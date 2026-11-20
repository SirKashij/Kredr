//! Terminal-Dienst: startet eine Shell in einem Pseudoterminal (ConPTY),
//! liefert ihre Ausgabe als Strom, nimmt Eingaben und Größenänderungen
//! entgegen, meldet das Ende des Prozesses und ob im Terminal noch ein
//! Kindprozess läuft.

use std::fmt;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// So lange wird Ausgabe gesammelt, bevor sie als ein Ereignis weitergeht.
/// Kurz genug, dass das Echo eines Tastendrucks nicht spürbar verzögert wird.
const OUTPUT_WINDOW: Duration = Duration::from_millis(5);
/// Ab dieser Größe geht gesammelte Ausgabe sofort weiter.
const OUTPUT_LIMIT: usize = 256 * 1024;

pub struct TerminalOptions {
    /// Startordner der Shell.
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

pub enum TerminalEvent {
    /// Rohe Ausgabe der Shell samt Steuersequenzen.
    Output(Vec<u8>),
    /// Der Shell-Prozess hat sich beendet.
    Exited,
}

#[derive(Debug)]
pub struct TerminalError(String);

impl fmt::Display for TerminalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TerminalError {}

fn error(source: impl fmt::Display) -> TerminalError {
    TerminalError(source.to_string())
}

/// Ein laufendes Terminal. Wird es verworfen, endet auch seine Shell.
pub struct Terminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Prozesskennung der Shell.
    shell_pid: Option<u32>,
    /// Ob sich die Shell beendet hat; ihre Prozesskennung kann dann neu vergeben sein.
    exited: Arc<AtomicBool>,
}

impl Terminal {
    /// Startet PowerShell im Startordner. `on_event` wird der Reihe nach
    /// aus einem Hintergrund-Thread aufgerufen.
    ///
    /// ConPTY fragt beim Start die Cursorposition ab (`ESC[6n`) und liefert
    /// erst weitere Ausgabe, wenn die Antwort über [`Terminal::write`] kommt.
    /// xterm.js beantwortet diese Abfrage von selbst.
    pub fn open(
        options: TerminalOptions,
        on_event: impl Fn(TerminalEvent) + Send + 'static,
    ) -> Result<Terminal, TerminalError> {
        let pair = native_pty_system()
            .openpty(size(options.cols, options.rows))
            .map_err(error)?;

        let mut command = CommandBuilder::new(powershell());
        command.arg("-NoLogo");
        command.cwd(&options.cwd);
        // Daran erkennen Programme wie Claude Code, dass 24-Bit-Farben gehen.
        command.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(command).map_err(error)?;
        let killer = child.clone_killer();
        let shell_pid = child.process_id();
        let exited = Arc::new(AtomicBool::new(false));
        let shell_exited = exited.clone();

        let mut reader = pair.master.try_clone_reader().map_err(error)?;
        let writer = pair.master.take_writer().map_err(error)?;

        // Ausgabe und Prozessende laufen durch dieselbe Warteschlange, damit
        // das Ende nie vor bereits gelesener Ausgabe gemeldet wird.
        let (sender, events) = mpsc::channel::<TerminalEvent>();
        let exit_sender = sender.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(len) => {
                        let output = TerminalEvent::Output(buffer[..len].to_vec());
                        if sender.send(output).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        thread::spawn(move || {
            let _ = child.wait();
            shell_exited.store(true, Ordering::Relaxed);
            let _ = exit_sender.send(TerminalEvent::Exited);
        });
        // ConPTY liefert bei schneller Ausgabe ein kleines Stück pro Zeile.
        // Gebündelt kommt beim Empfänger ein Ereignis pro Zeitfenster an
        // statt tausender pro Sekunde.
        thread::spawn(move || {
            while let Ok(event) = events.recv() {
                let TerminalEvent::Output(mut output) = event else {
                    on_event(event);
                    continue;
                };
                let deadline = Instant::now() + OUTPUT_WINDOW;
                let mut exited = false;
                while output.len() < OUTPUT_LIMIT {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match events.recv_timeout(remaining) {
                        Ok(TerminalEvent::Output(more)) => output.extend_from_slice(&more),
                        Ok(TerminalEvent::Exited) => {
                            exited = true;
                            break;
                        }
                        Err(_) => break,
                    }
                }
                on_event(TerminalEvent::Output(output));
                if exited {
                    on_event(TerminalEvent::Exited);
                }
            }
        });

        Ok(Terminal {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            shell_pid,
            exited,
        })
    }

    /// Sendet Eingaben an die Shell.
    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        let mut writer = self.writer.lock().map_err(error)?;
        writer.write_all(data).map_err(error)?;
        writer.flush().map_err(error)
    }

    /// Ändert die Größe des Terminals in Zeichen.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.master.lock().map_err(error)?;
        master.resize(size(cols, rows)).map_err(error)
    }

    /// Ob in der Shell gerade ein Programm läuft, etwa ein Agent. Eine Shell,
    /// die nur auf Eingabe wartet, und eine beendete Shell haben keines.
    pub fn has_child_process(&self) -> bool {
        if self.exited.load(Ordering::Relaxed) {
            return false;
        }
        self.shell_pid.is_some_and(has_child)
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Ob irgendein laufender Prozess `parent` als Elternprozess hat.
fn has_child(parent: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: Der Schnappschuss wird nur hier benutzt und wieder geschlossen;
    // `entry` ist ein gültiger, mit seiner Größe versehener Puffer.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 && !found {
            found = entry.th32ParentProcessID == parent;
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        found
    }
}

/// PowerShell 7, wenn installiert, sonst das mit Windows gelieferte
/// Windows PowerShell; dieselbe Reihenfolge wie in VS Code.
fn powershell() -> &'static str {
    let has_pwsh = std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join("pwsh.exe").is_file()));
    if has_pwsh {
        "pwsh.exe"
    } else {
        "powershell.exe"
    }
}
