pub mod agent;
pub mod agent_status;
pub mod app_update;
pub mod arrangement_store;
pub mod dialog_answers;
pub mod external;
pub mod file_list;
pub mod notifications;
mod orphaned_dialogs;
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
#[cfg(test)]
mod window_wiring_tests;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, Runtime, State, Window, WindowEvent};

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

/// Wo Kredr Einstellungen, Projektliste und Aufteilungen ablegt. Die
/// Entwicklungsfassung nimmt mit `KREDR_DATA_DIR` einen eigenen Ordner, damit
/// Testläufe die Daten eines installierten Kredr nicht berühren.
pub(crate) fn data_dir(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    match std::env::var_os("KREDR_DATA_DIR") {
        Some(dir) if cfg!(debug_assertions) => Ok(PathBuf::from(dir)),
        _ => app.path().app_data_dir(),
    }
}

/// Gibt alles frei, was zu einem geschlossenen Fenster gehört. Die eine
/// Stelle dafür: Was künftig an einem Fenster hängt, kommt hier dazu.
fn release_window<R: Runtime>(window: &Window<R>) {
    let label = window.label();
    projects::window_closed(window);
    waiting_alerts::window_closed(window);
    app_update::window_closed(window);
    window.state::<Terminals>().close_all_of(label);
    // Vor den Beobachtern, damit auch der Beobachter der Projektdateien enden kann.
    window.state::<VersionControls>().close_all_of(label);
    window.state::<ProjectWatchers>().close_all_of(label);
    window.state::<Searches>().close_all_of(label);
    orphaned_dialogs::close_orphaned_dialogs();
}

/// Verwaltet, was einzelnen Fenstern gehört und `release_window` freigibt.
/// Benachrichtigungen und Aktualisierung entstehen erst beim Start.
fn manage_per_window<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(Terminals::default())
        .manage(ProjectWatchers::default())
        .manage(Searches::default())
        .manage(VersionControls::default())
        .manage(project_windows::ProjectWindows::default())
}

/// Was Kredr bei Ereignissen eines Fensters tut.
fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::Destroyed = event {
        release_window(window);
    }
}

pub fn run() {
    // Der Empfänger für den Agentenstatus aller Fenster; sein Laufzeitordner
    // gehört diesem Kredr-Prozess.
    let temp = std::env::temp_dir();
    let runtime_dir = agent_status::runtime_folder_of(&temp, std::process::id());
    // Dort legt Claude Code die Ausgabedateien seiner Hintergrundaufgaben ab.
    let claude_temp = temp.join("claude");
    // Was frühere Kredr-Prozesse dort hinterlassen haben, hält den Start nicht auf.
    std::thread::spawn(move || agent_status::remove_orphaned_runtime_folders(&temp));
    let agent_status: AgentStatusReceiver = AgentStatus::start(runtime_dir, claude_temp)
        .ok()
        .map(Arc::new);
    let mut builder = tauri::Builder::default();
    // Ein einziger Prozess verwaltet alle Fenster. Die Entwicklungsfassung
    // nimmt daran nicht teil, damit sie neben einem installierten Kredr läuft.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            projects::open_from_second_instance,
        ));
    }
    manage_per_window(builder)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(agent_status)
        .manage(dialog_answers::DialogAnswers::from_env())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = SettingsStore::open(data_dir(app.handle())?, move |settings| {
                // Scheitert das Senden, ist kein Fenster mehr offen.
                let _ = handle.emit("settings-changed", settings);
                app_update::settings_changed(&handle, settings);
            });
            app.manage(settings);
            projects::start(app.handle())?;
            waiting_alerts::start(app.handle());
            app_update::start(app.handle());
            Ok(())
        })
        .on_window_event(on_window_event)
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
            app_update::app_update_state,
            app_update::app_update_later,
            app_update::app_update_check,
            app_update::app_update_download,
            app_update::app_update_install,
            app_update::app_update_ask,
            app_update::app_update_cancel,
            app_update::app_update_fail,
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
            projects::recent_entries,
            projects::forget_project,
            projects::forget_workspace,
            projects::open_project,
            projects::open_workspace,
            projects::add_project,
            projects::remove_project,
            projects::rename_workspace,
            projects::reorder_projects,
            projects::close_workspace,
            projects::folders_among,
            projects::project_arrangement_load,
            projects::project_arrangement_save,
            dialog_answers::dialog_answer,
            waiting_alerts::waiting_alert,
            waiting_alerts::waiting_alert_clear,
            project_files_commands::project_files_exist,
            projects::arrangement_load,
            projects::arrangement_save,
        ])
        .run(tauri::generate_context!())
        .expect("Kredr konnte nicht gestartet werden");
}
