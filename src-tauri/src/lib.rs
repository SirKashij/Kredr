pub mod agent;
pub mod terminal;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use terminal::{Terminal, TerminalEvent, TerminalOptions};

/// Die laufenden Terminals, nach Kennung.
#[derive(Default)]
struct Terminals {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Arc<Terminal>>>,
}

impl Terminals {
    /// Liefert das Terminal, ohne die Sperre über alle Terminals zu halten:
    /// eine Shell, die ihre Eingabe nicht liest, bremst so keine andere.
    fn get(&self, id: u32) -> Result<Arc<Terminal>, String> {
        let open = self.open.lock().map_err(|e| e.to_string())?;
        open.get(&id)
            .cloned()
            .ok_or_else(|| format!("terminal {id} not found"))
    }
}

/// Der Agent-Startbefehl aus den Einstellungen des Kerns. Solange es das
/// Modul Einstellungen noch nicht gibt, ist das der Standardwert; danach
/// liest nur diese Funktion den gespeicherten Wert.
fn agent_start_command() -> String {
    agent::DEFAULT_START_COMMAND.to_owned()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedTerminal {
    id: u32,
    /// Das Programm des Agent-Startbefehls, wenn ein Agent starten sollte,
    /// es aber nicht installiert ist. Das Terminal ist dann eine gewöhnliche Shell.
    missing_agent_program: Option<String>,
}

/// Öffnet ein Terminal. Mit `agent` startet darin sofort der Agent.
#[tauri::command]
fn terminal_open(
    terminals: State<'_, Terminals>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    agent: bool,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<()>,
) -> Result<OpenedTerminal, String> {
    let mut start_command = agent.then(agent_start_command);
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    let missing_agent_program = start_command
        .as_deref()
        .and_then(|command| agent::missing_program(command, &search_path));
    if missing_agent_program.is_some() {
        start_command = None;
    }
    let options = TerminalOptions {
        cwd,
        cols,
        rows,
        start_command,
    };
    let terminal = Terminal::open(options, move |event| {
        // Scheitert das Senden, ist das Fenster bereits geschlossen.
        let _ = match event {
            TerminalEvent::Output(bytes) => on_output.send(InvokeResponseBody::Raw(bytes)),
            TerminalEvent::Exited => on_exit.send(()),
        };
    })
    .map_err(|e| e.to_string())?;

    let id = terminals.next_id.fetch_add(1, Ordering::Relaxed);
    terminals
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Arc::new(terminal));
    Ok(OpenedTerminal {
        id,
        missing_agent_program,
    })
}

#[tauri::command]
fn terminal_write(terminals: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let terminal = terminals.get(id)?;
    terminal.write(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_resize(
    terminals: State<'_, Terminals>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminal = terminals.get(id)?;
    terminal.resize(cols, rows).map_err(|e| e.to_string())
}

/// Ob im Terminal noch ein Kindprozess läuft; danach richtet sich die
/// Rückfrage beim Schließen.
#[tauri::command]
fn terminal_has_child_process(terminals: State<'_, Terminals>, id: u32) -> Result<bool, String> {
    Ok(terminals.get(id)?.has_child_process())
}

#[tauri::command]
fn terminal_close(terminals: State<'_, Terminals>, id: u32) -> Result<(), String> {
    terminals
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}

/// Der Ordner, der beim Start als Projekt geöffnet wird: das erste
/// Programmargument, wenn es ein Ordner ist (`kredr <Ordner>`).
#[tauri::command]
fn initial_project() -> Option<PathBuf> {
    let folder = PathBuf::from(std::env::args_os().nth(1)?);
    if !folder.is_dir() {
        return None;
    }
    std::path::absolute(folder).ok()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Terminals::default())
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_has_child_process,
            terminal_close,
            initial_project,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
