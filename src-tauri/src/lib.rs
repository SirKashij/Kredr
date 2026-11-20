pub mod agent;
pub mod agent_status;
pub mod arrangement_store;
pub mod external;
pub mod notifications;
pub mod project_files;
pub mod project_windows;
mod projects;
pub mod settings;
pub mod terminal;
mod waiting_alerts;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, Manager, State};

use agent_status::{AgentStatus, StatusUpdate};
use project_files::{Entry, ProjectChanges, ProjectWatcher, Subscription};
use settings::{Settings, SettingsStore, Shell};
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

/// Der Empfänger für den Agentenstatus. Er fehlt, wenn er sich beim Start
/// nicht öffnen ließ; Agenten starten dann ohne Agentenstatus.
type AgentStatusReceiver = Option<Arc<AgentStatus>>;

/// Öffnet ein Terminal mit der gewählten Shell. Mit `agent` startet darin
/// sofort der Agent; `on_agent_status` erhält dann jede Änderung seines
/// Agentenstatus.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn terminal_open(
    window: tauri::Window,
    terminals: State<'_, Terminals>,
    agent_status: State<'_, AgentStatusReceiver>,
    settings: State<'_, SettingsStore>,
    shell: Option<Shell>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    agent: bool,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<()>,
    on_agent_status: Channel<StatusUpdate>,
) -> Result<OpenedTerminal, String> {
    let id = terminals.next_id.fetch_add(1, Ordering::Relaxed);
    // Ohne Angabe gilt die Standard-Shell aus den Einstellungen.
    let shell = shell.unwrap_or_else(|| settings.get().default_shell);
    let mut start_command = agent.then(|| agent_start_command(&settings));
    let search_path = std::env::var_os("PATH").unwrap_or_default();
    let missing_agent_program = start_command
        .as_deref()
        .and_then(|command| agent::missing_program(command, &search_path));
    if missing_agent_program.is_some() {
        start_command = None;
    }
    // Der Agent meldet seinen Status über eine Konfiguration, die nur für
    // dieses Terminal gilt. Lässt sie sich nicht anlegen, startet er ohne.
    let status = agent_status
        .inner()
        .clone()
        .filter(|_| start_command.is_some());
    if let (Some(status), Some(command)) = (&status, &mut start_command) {
        let settings_file = status.register(id, move |update| {
            // Hier beginnt jede Reaktion des Kerns auf einen Statuswechsel.
            let _ = on_agent_status.send(update);
        });
        if let Ok(settings_file) = settings_file {
            *command = agent::with_status_settings(command, &settings_file, shell);
        }
    }
    let options = TerminalOptions {
        shell,
        cwd,
        cols,
        rows,
        start_command,
    };
    let exited_status = status.clone();
    let terminal = Terminal::open(options, move |event| {
        // Scheitert das Senden, ist das Fenster bereits geschlossen.
        let _ = match event {
            TerminalEvent::Output(bytes) => on_output.send(InvokeResponseBody::Raw(bytes)),
            TerminalEvent::Exited => {
                if let Some(status) = &exited_status {
                    status.forget(id);
                }
                on_exit.send(())
            }
        };
    })
    .map_err(|e| {
        if let Some(status) = &status {
            status.forget(id);
        }
        e.to_string()
    })?;

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
fn terminal_close(
    terminals: State<'_, Terminals>,
    agent_status: State<'_, AgentStatusReceiver>,
    id: u32,
) -> Result<(), String> {
    if let Some(status) = agent_status.inner() {
        status.forget(id);
    }
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

/// Die Beobachter der geöffneten Projekte und die Abonnements der Fenster.
/// Je Projektordner gibt es einen Beobachter; an ihm hängen Oberfläche und Kern.
#[derive(Default)]
struct ProjectWatchers {
    next_id: AtomicU32,
    watchers: Mutex<HashMap<PathBuf, Arc<ProjectWatcher>>>,
    subscriptions: Mutex<HashMap<u32, WindowSubscription>>,
}

/// Das Abonnement eines Fensters am Ereignisstrom seines Projekts.
struct WindowSubscription {
    window: String,
    project: PathBuf,
    _subscription: Subscription,
}

impl ProjectWatchers {
    /// Beendet die Abonnements eines geschlossenen Fensters und die
    /// Beobachter, an denen danach niemand mehr hängt; sonst bliebe der
    /// Projektordner bis zum Ende des Prozesses beobachtet.
    fn close_all_of(&self, window: &str) {
        let Ok(mut subscriptions) = self.subscriptions.lock() else {
            return;
        };
        subscriptions.retain(|_, subscription| subscription.window != window);
        let Ok(mut watchers) = self.watchers.lock() else {
            return;
        };
        watchers.retain(|project, watcher| {
            // Wer den Beobachter außerhalb dieser Liste hält, hört noch zu.
            Arc::strong_count(watcher) > 1
                || subscriptions
                    .values()
                    .any(|subscription| &subscription.project == project)
        });
    }

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
    window: tauri::Window,
    watchers: State<'_, ProjectWatchers>,
    project: PathBuf,
    on_change: Channel<ProjectChanges>,
) -> Result<u32, String> {
    // Der Beobachter bleibt gehalten, bis das Abonnement eingetragen ist;
    // so räumt ihn ein gleichzeitig schließendes Fenster nicht weg.
    let watcher = watchers.for_project(&project)?;
    let subscription = watcher.subscribe(move |changes| {
        // Scheitert das Senden, ist das Fenster bereits geschlossen.
        let _ = on_change.send(changes.clone());
    });
    let id = watchers.next_id.fetch_add(1, Ordering::Relaxed);
    watchers
        .subscriptions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id,
            WindowSubscription {
                window: window.label().to_string(),
                project,
                _subscription: subscription,
            },
        );
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
    // Der Empfänger für den Agentenstatus aller Fenster; sein Laufzeitordner
    // gehört diesem Kredr-Prozess.
    let runtime_dir = std::env::temp_dir().join(format!("kredr-{}", std::process::id()));
    let agent_status: AgentStatusReceiver = AgentStatus::start(runtime_dir).ok().map(Arc::new);
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Terminals::default())
        .manage(agent_status)
        .manage(ProjectWatchers::default())
        .manage(project_windows::ProjectWindows::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = SettingsStore::open(app.path().app_data_dir()?, move |settings| {
                // Scheitert das Senden, ist kein Fenster mehr offen.
                let _ = handle.emit("settings-changed", settings);
            });
            app.manage(settings);
            projects::start(app.handle())?;
            waiting_alerts::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                projects::window_closed(window);
                waiting_alerts::window_closed(window);
                window.state::<Terminals>().close_all_of(window.label());
                window
                    .state::<ProjectWatchers>()
                    .close_all_of(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_has_child_process,
            terminal_close,
            resolve_files,
            open_file,
            open_url,
            settings_get,
            settings_set,
            available_shells,
            project_files_list,
            project_files_watch,
            project_files_unwatch,
            projects::window_project,
            projects::recent_projects,
            projects::forget_project,
            projects::open_project,
            waiting_alerts::waiting_alert,
            waiting_alerts::waiting_alert_clear,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
