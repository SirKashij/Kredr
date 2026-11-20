pub mod agent;
pub mod external;
pub mod project_files;
pub mod settings;
pub mod terminal;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager, State};

use project_files::{Entry, ProjectChanges, ProjectWatcher, Subscription};
use settings::{Settings, SettingsStore, Shell};
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

/// Der Agent-Startbefehl aus den Einstellungen des Kerns. Er wird bei jedem
/// Start frisch gelesen, damit eine Änderung sofort gilt.
fn agent_start_command(settings: &SettingsStore) -> String {
    settings.get().agent_command
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedTerminal {
    id: u32,
    /// Das Programm des Agent-Startbefehls, wenn ein Agent starten sollte,
    /// es aber nicht installiert ist. Das Terminal ist dann eine gewöhnliche Shell.
    missing_agent_program: Option<String>,
}

/// Öffnet ein Terminal mit der gewählten Shell. Mit `agent` startet darin
/// sofort der Agent.
#[tauri::command]
fn terminal_open(
    terminals: State<'_, Terminals>,
    settings: State<'_, SettingsStore>,
    shell: Option<Shell>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    agent: bool,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<()>,
) -> Result<OpenedTerminal, String> {
    let mut start_command = agent.then(|| agent_start_command(&settings));
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    let missing_agent_program = start_command
        .as_deref()
        .and_then(|command| agent::missing_program(command, &search_path));
    if missing_agent_program.is_some() {
        start_command = None;
    }
    let options = TerminalOptions {
        // Ohne Angabe gilt die Standard-Shell aus den Einstellungen.
        shell: shell.unwrap_or_else(|| settings.get().default_shell),
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

#[tauri::command]
fn settings_get(settings: State<'_, SettingsStore>) -> Settings {
    settings.get()
}

/// Speichert die Einstellungen; alle Fenster erfahren davon über das
/// Ereignis `settings-changed`.
#[tauri::command]
fn settings_set(settings: State<'_, SettingsStore>, value: Settings) -> Result<Settings, String> {
    settings.set(value).map_err(|e| e.to_string())
}

/// Die Shells, die die Einstellungsseite zur Wahl stellt.
#[tauri::command]
fn available_shells() -> Vec<Shell> {
    settings::available_shells()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Terminals::default())
        .manage(ProjectWatchers::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = SettingsStore::open(app.path().app_data_dir()?, move |settings| {
                // Scheitert das Senden, ist kein Fenster mehr offen.
                let _ = handle.emit("settings-changed", settings);
            });
            app.manage(settings);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_has_child_process,
            terminal_close,
            initial_project,
            resolve_files,
            open_file,
            open_url,
            settings_get,
            settings_set,
            available_shells,
            project_files_list,
            project_files_watch,
            project_files_unwatch,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
