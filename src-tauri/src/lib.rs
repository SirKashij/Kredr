pub mod agent;
pub mod agent_status;
pub mod arrangement_store;
pub mod external;
pub mod file_list;
pub mod notifications;
mod paths;
pub mod project_files;
mod project_files_commands;
pub mod project_windows;
mod projects;
pub mod search;
mod search_commands;
pub mod settings;
pub mod terminal;
mod terminal_commands;
pub mod version_control;
mod version_control_commands;
mod waiting_alerts;
pub mod window_geometry;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, State};

use agent_status::AgentStatus;
use project_files_commands::ProjectWatchers;
use search::Searches;
use settings::{Settings, SettingsStore, Shell};
use terminal_commands::{AgentStatusReceiver, Terminals};
use version_control_commands::VersionControls;

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
    terminal::available_shells()
}

/// Gibt alles frei, was zu einem geschlossenen Fenster gehört. Die eine
/// Stelle dafür: Was künftig an einem Fenster hängt, kommt hier dazu.
fn release_window(window: &tauri::Window) {
    let label = window.label();
    projects::window_closed(window);
    waiting_alerts::window_closed(window);
    window.state::<Terminals>().close_all_of(label);
    // Vor den Beobachtern, damit auch der Beobachter der Projektdateien enden kann.
    window.state::<VersionControls>().close_all_of(label);
    window.state::<ProjectWatchers>().close_all_of(label);
    window.state::<Searches>().close_all_of(label);
}

pub fn run() {
    // Der Empfänger für den Agentenstatus aller Fenster; sein Laufzeitordner
    // gehört diesem Kredr-Prozess.
    let temp = std::env::temp_dir();
    let runtime_dir = agent_status::runtime_folder_of(&temp, std::process::id());
    // Was frühere Kredr-Prozesse dort hinterlassen haben, hält den Start nicht auf.
    std::thread::spawn(move || agent_status::remove_orphaned_runtime_folders(&temp));
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
        .manage(Searches::default())
        .manage(VersionControls::default())
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
                release_window(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            terminal_commands::terminal_open,
            terminal_commands::terminal_write,
            terminal_commands::terminal_resize,
            terminal_commands::terminal_has_child_process,
            terminal_commands::terminal_close,
            resolve_files,
            open_file,
            open_url,
            settings_get,
            settings_set,
            available_shells,
            project_files_commands::project_files_list_folder,
            project_files_commands::project_files_list_all,
            project_files_commands::project_files_read,
            project_files_commands::project_files_read_image,
            project_files_commands::project_files_write,
            project_files_commands::project_files_create_file,
            project_files_commands::project_files_create_folder,
            project_files_commands::project_files_rename,
            project_files_commands::project_files_trash,
            project_files_commands::project_files_reveal,
            project_files_commands::project_files_watch,
            project_files_commands::project_files_unwatch,
            search_commands::search_text,
            search_commands::search_cancel,
            version_control_commands::version_control_watch,
            version_control_commands::version_control_unwatch,
            version_control_commands::version_control_diff,
            version_control_commands::version_control_stage,
            version_control_commands::version_control_unstage,
            version_control_commands::version_control_discard,
            version_control_commands::version_control_commit,
            version_control_commands::version_control_commit_and_push,
            version_control_commands::version_control_push,
            version_control_commands::version_control_pull,
            version_control_commands::version_control_pull_and_push,
            version_control_commands::version_control_commits,
            version_control_commands::version_control_commit_files,
            version_control_commands::version_control_commit_diff,
            version_control_commands::version_control_branches,
            version_control_commands::version_control_switch_branch,
            version_control_commands::version_control_create_branch,
            projects::window_content,
            projects::recent_projects,
            projects::forget_project,
            projects::open_project,
            waiting_alerts::waiting_alert,
            waiting_alerts::waiting_alert_clear,
            project_files_commands::project_files_exist,
            projects::arrangement_load,
            projects::arrangement_save,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
