pub mod agent;
pub mod arrangement_store;
pub mod project_windows;
mod projects;
pub mod terminal;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};

use terminal::{Terminal, TerminalEvent, TerminalOptions};

/// Die laufenden Terminals, nach Kennung.
#[derive(Default)]
struct Terminals {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Arc<Terminal>>>,
    /// Zu welchem Fenster ein Terminal gehört.
    owners: Mutex<HashMap<u32, String>>,
}

impl Terminals {
    /// Beendet die Terminals eines geschlossenen Fensters; der Prozess läuft
    /// für die übrigen Fenster weiter.
    fn close_all_of(&self, window: &str) {
        let Ok(mut owners) = self.owners.lock() else {
            return;
        };
        let Ok(mut open) = self.open.lock() else {
            return;
        };
        owners.retain(|id, owner| {
            let keep = owner != window;
            if !keep {
                open.remove(id);
            }
            keep
        });
    }

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
    window: tauri::Window,
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
    if let Ok(mut owners) = terminals.owners.lock() {
        owners.insert(id, window.label().to_string());
    }
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
    if let Ok(mut owners) = terminals.owners.lock() {
        owners.remove(&id);
    }
    Ok(())
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // Ein einziger Prozess verwaltet alle Fenster. Die Entwicklungsfassung
    // nimmt daran nicht teil, damit sie neben einem installierten Kredr läuft.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            projects::open_from_second_instance,
        ));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(Terminals::default())
        .manage(project_windows::ProjectWindows::default())
        .setup(|app| Ok(projects::start(app.handle())?))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                projects::window_closed(window);
                window.state::<Terminals>().close_all_of(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_has_child_process,
            terminal_close,
            projects::window_project,
            projects::recent_projects,
            projects::forget_project,
            projects::open_project,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
