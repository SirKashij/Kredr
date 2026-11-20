pub mod external;
pub mod terminal;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use terminal::{Shell, Terminal, TerminalEvent, TerminalOptions};

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

#[tauri::command]
fn terminal_open(
    terminals: State<'_, Terminals>,
    shell: Option<String>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<()>,
) -> Result<u32, String> {
    let shell = match shell {
        Some(id) => Shell::from_id(&id).ok_or_else(|| format!("unknown shell {id}"))?,
        None => Shell::PowerShell,
    };
    let options = TerminalOptions {
        shell,
        cwd,
        cols,
        rows,
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
    Ok(id)
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

/// Die Kennungen der Shells, die sich auf diesem Rechner starten lassen.
#[tauri::command]
fn terminal_shells() -> Vec<&'static str> {
    terminal::available_shells()
        .into_iter()
        .map(Shell::id)
        .collect()
}

/// Prüft, welche Texte aus einem Terminal vorhandene Dateien bezeichnen:
/// je Text der volle Pfad oder nichts. Relative Angaben gelten ab `base`.
#[tauri::command]
fn resolve_files(base: PathBuf, candidates: Vec<String>) -> Vec<Option<PathBuf>> {
    candidates
        .iter()
        .map(|candidate| external::resolve_file(&base, candidate))
        .collect()
}

#[tauri::command]
fn open_file(path: PathBuf) -> Result<(), String> {
    external::open_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    external::open_url(&url).map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Terminals::default())
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_has_child_process,
            terminal_close,
            terminal_shells,
            resolve_files,
            open_file,
            open_url,
            initial_project,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
