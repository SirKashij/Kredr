//! Die Befehle der Projektdateien für die Oberfläche und die Verwaltung der
//! Beobachter je Projekt. Die Logik liegt in `project_files`, `file_list` und
//! `external`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

use crate::project_files::{
    self, Entry, FileContent, FileOperationError, ImageContent, ProjectChanges, ProjectWatcher,
    Subscription,
};
use crate::{external, file_list};

/// Die Beobachter der geöffneten Projekte und die Abonnements der Fenster.
/// Je Projektordner gibt es einen Beobachter; an ihm hängen Oberfläche und Kern.
#[derive(Default)]
pub(crate) struct ProjectWatchers {
    next_id: AtomicU32,
    watchers: Mutex<HashMap<PathBuf, Arc<ProjectWatcher>>>,
    subscriptions: Mutex<HashMap<u32, WindowSubscription>>,
}

/// Das Abonnement eines Fensters am Ereignisstrom seines Projekts.
pub(crate) struct WindowSubscription {
    window: String,
    project: PathBuf,
    _subscription: Subscription,
}

impl ProjectWatchers {
    /// Beendet die Abonnements eines geschlossenen Fensters und die
    /// Beobachter, an denen danach niemand mehr hängt; sonst bliebe der
    /// Projektordner bis zum Ende des Prozesses beobachtet.
    pub(crate) fn close_all_of(&self, window: &str) {
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
    pub(crate) fn for_project(&self, project: &Path) -> Result<Arc<ProjectWatcher>, String> {
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
pub(crate) fn project_files_list_folder(
    project: PathBuf,
    folder: String,
) -> Result<Vec<Entry>, String> {
    project_files::list_folder(&project.join(folder)).map_err(|e| e.to_string())
}

/// Die Dateiliste des Projekts für „Datei per Namen öffnen“: alle nicht
/// ignorierten Dateien, relativ zum Projektordner.
#[tauri::command(async)]
pub(crate) fn project_files_list_all(project: PathBuf) -> Vec<String> {
    file_list::list_files(&project)
}

/// Liest eine Datei für die Dateiansicht. `path` ist relativ zum
/// Projektordner; ein voller Pfad (Datei außerhalb des Projekts) gilt unverändert.
#[tauri::command(async)]
pub(crate) fn project_files_read(project: PathBuf, path: String) -> Result<FileContent, String> {
    project_files::read_file(&project.join(path)).map_err(|e| e.to_string())
}

/// Warum ein Bild nicht geliefert wird.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ImageUnavailable {
    NotAnImage,
    TooLarge { size: u64 },
    Missing,
    Failed { details: String },
}

/// Liest eine Bilddatei als rohe Bytes; `path` wie bei `project_files_read`.
/// Nur Dateien mit Bildendung werden geliefert.
#[tauri::command(async)]
pub(crate) fn project_files_read_image(
    project: PathBuf,
    path: String,
) -> Result<tauri::ipc::Response, ImageUnavailable> {
    match project_files::read_image(&project.join(path)) {
        Ok(ImageContent::Image { bytes }) => Ok(tauri::ipc::Response::new(bytes)),
        Ok(ImageContent::NotAnImage) => Err(ImageUnavailable::NotAnImage),
        Ok(ImageContent::TooLarge { size }) => Err(ImageUnavailable::TooLarge { size }),
        Ok(ImageContent::Missing) => Err(ImageUnavailable::Missing),
        Err(e) => Err(ImageUnavailable::Failed {
            details: e.to_string(),
        }),
    }
}

/// Welche der Dateien und Ordner es gibt, in der Reihenfolge von `paths`;
/// jeder Pfad wie bei `project_files_read`. Danach richtet sich, was von
/// einer gespeicherten Aufteilung wiederhergestellt wird.
#[tauri::command(async)]
pub(crate) fn project_files_exist(project: PathBuf, paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|path| project.join(path).exists())
        .collect()
}

/// Schreibt den Inhalt einer Datei; `path` wie bei `project_files_read`.
#[tauri::command(async)]
pub(crate) fn project_files_write(
    project: PathBuf,
    path: String,
    text: String,
) -> Result<(), String> {
    project_files::write_file(&project.join(path), &text).map_err(|e| e.to_string())
}

/// Legt im Ordner `folder` des Projekts eine leere Datei an.
#[tauri::command(async)]
pub(crate) fn project_files_create_file(
    project: PathBuf,
    folder: String,
    name: String,
) -> Result<(), FileOperationError> {
    project_files::create_file(&project.join(folder), &name)
}

/// Legt im Ordner `folder` des Projekts einen leeren Ordner an.
#[tauri::command(async)]
pub(crate) fn project_files_create_folder(
    project: PathBuf,
    folder: String,
    name: String,
) -> Result<(), FileOperationError> {
    project_files::create_folder(&project.join(folder), &name)
}

/// Gibt dem Eintrag `path` des Projekts in seinem Ordner einen neuen Namen.
#[tauri::command(async)]
pub(crate) fn project_files_rename(
    project: PathBuf,
    path: String,
    new_name: String,
) -> Result<(), FileOperationError> {
    project_files::rename(&project.join(path), &new_name)
}

/// Verschiebt den Eintrag `path` des Projekts in den Windows-Papierkorb.
#[tauri::command(async)]
pub(crate) fn project_files_trash(
    project: PathBuf,
    path: String,
) -> Result<(), FileOperationError> {
    project_files::move_to_trash(&project.join(path))
}

/// Markiert den Eintrag `path` des Projekts im Windows-Explorer; ein leerer
/// Pfad meint den Projektordner selbst.
#[tauri::command(async)]
pub(crate) fn project_files_reveal(
    project: PathBuf,
    path: String,
) -> Result<(), FileOperationError> {
    Ok(external::reveal(&project.join(path))?)
}

/// Abonniert den Ereignisstrom des Projekts und liefert die Kennung des Abonnements.
#[tauri::command]
pub(crate) fn project_files_watch(
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
pub(crate) fn project_files_unwatch(
    watchers: State<'_, ProjectWatchers>,
    id: u32,
) -> Result<(), String> {
    watchers
        .subscriptions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}
