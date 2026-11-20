pub mod project_files;
pub mod terminal;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use project_files::{Entry, ProjectChanges, ProjectWatcher, Subscription};
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

#[tauri::command]
fn terminal_open(
    terminals: State<'_, Terminals>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<()>,
) -> Result<u32, String> {
    let options = TerminalOptions { cwd, cols, rows };
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

/// Die Beobachter der geöffneten Projekte und die Abonnements der Fenster.
/// Je Projektordner gibt es einen Beobachter; an ihm hängen Oberfläche und Kern.
#[derive(Default)]
struct ProjectWatchers {
    next_id: AtomicU32,
    watchers: Mutex<HashMap<PathBuf, Arc<ProjectWatcher>>>,
    subscriptions: Mutex<HashMap<u32, Subscription>>,
}

impl ProjectWatchers {
    /// Liefert den Beobachter des Projekts und startet ihn beim ersten Mal.
    fn for_project(&self, project: &Path) -> Result<Arc<ProjectWatcher>, String> {
        let mut watchers = self.watchers.lock().map_err(|e| e.to_string())?;
        if let Some(watcher) = watchers.get(project) {
            return Ok(watcher.clone());
        }
        let watcher = Arc::new(ProjectWatcher::start(project).map_err(|e| e.to_string())?);
        watchers.insert(project.to_path_buf(), watcher.clone());
        Ok(watcher)
    }
}

/// Die Einträge eines Ordners im Projekt; `folder` ist relativ zum
/// Projektordner und für diesen selbst leer. Läuft abseits des
/// Haupt-Threads, damit auch ein sehr großer Ordner das Fenster nicht anhält.
#[tauri::command(async)]
fn project_files_list(project: PathBuf, folder: String) -> Result<Vec<Entry>, String> {
    project_files::list_folder(&project.join(folder)).map_err(|e| e.to_string())
}

/// Abonniert den Ereignisstrom des Projekts und liefert die Kennung des Abonnements.
#[tauri::command]
fn project_files_watch(
    watchers: State<'_, ProjectWatchers>,
    project: PathBuf,
    on_change: Channel<ProjectChanges>,
) -> Result<u32, String> {
    let subscription = watchers.for_project(&project)?.subscribe(move |changes| {
        // Scheitert das Senden, ist das Fenster bereits geschlossen.
        let _ = on_change.send(changes.clone());
    });
    let id = watchers.next_id.fetch_add(1, Ordering::Relaxed);
    watchers
        .subscriptions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, subscription);
    Ok(id)
}

#[tauri::command]
fn project_files_unwatch(watchers: State<'_, ProjectWatchers>, id: u32) -> Result<(), String> {
    watchers
        .subscriptions
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
        .manage(ProjectWatchers::default())
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_has_child_process,
            terminal_close,
            initial_project,
            project_files_list,
            project_files_watch,
            project_files_unwatch,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
