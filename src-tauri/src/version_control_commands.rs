//! Die Befehle der Versionskontrolle für die Oberfläche und die Verwaltung
//! des beobachteten Zustands je Projekt. Die Logik liegt in `version_control`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::project_files::ProjectWatcher;
use crate::project_files_commands::ProjectWatchers;
use crate::version_control::{
    BackgroundFetch, Branch, ChangedFile, Committed, Diff, RepositoryState, StateResult,
    StateSubscription, StateWatch, VersionControl, VersionControlError,
};

/// Was die Oberfläche über den Zustand eines Projekts erfährt.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StateMessage {
    Repository(RepositoryState),
    /// Kein Zustand: Git fehlt, der Ordner ist kein Repository oder Git scheiterte.
    Unavailable(VersionControlError),
}

impl From<&StateResult> for StateMessage {
    fn from(state: &StateResult) -> Self {
        match state {
            Ok(state) => StateMessage::Repository(state.clone()),
            Err(error) => StateMessage::Unavailable(error.clone()),
        }
    }
}

/// Der beobachtete Zustand der geöffneten Projekte und die Abonnements der
/// Fenster. Je Projektordner wird der Zustand nur einmal gelesen, gleich wie
/// viele ihn abonnieren.
#[derive(Default)]
pub struct VersionControls {
    next_id: AtomicU32,
    watching: Mutex<Watching>,
}

#[derive(Default)]
struct Watching {
    projects: HashMap<PathBuf, WatchedProject>,
    subscriptions: HashMap<u32, WindowSubscription>,
}

struct WatchedProject {
    state: StateWatch,
    /// Fragt den Stand gegenüber GitHub ab, solange das Projekt beobachtet wird.
    _fetching: BackgroundFetch,
    /// Hält den Beobachter der Projektdateien am Leben, solange der Zustand ihm folgt.
    _watcher: Arc<ProjectWatcher>,
}

struct WindowSubscription {
    window: String,
    project: PathBuf,
    _subscription: StateSubscription,
}

impl Watching {
    /// Beendet das Beobachten der Projekte, die niemand mehr abonniert.
    fn drop_unused(&mut self) {
        let subscriptions = &self.subscriptions;
        self.projects.retain(|project, _| {
            subscriptions
                .values()
                .any(|subscription| &subscription.project == project)
        });
    }
}

impl VersionControls {
    /// Beendet die Abonnements eines geschlossenen Fensters. Vor
    /// `ProjectWatchers::close_all_of` aufrufen, damit auch der Beobachter
    /// der Projektdateien enden kann.
    pub fn close_all_of(&self, window: &str) {
        let Ok(mut watching) = self.watching.lock() else {
            return;
        };
        watching
            .subscriptions
            .retain(|_, subscription| subscription.window != window);
        watching.drop_unused();
    }
}

/// Abonniert den Zustand der Versionskontrolle des Projekts und liefert die
/// Kennung des Abonnements. `on_state` erhält den aktuellen Zustand und
/// danach jede Änderung. Läuft abseits des Haupt-Threads, weil der erste
/// Aufruf je Projekt Git nach der Lage des Repositorys fragt.
#[tauri::command(async)]
pub(crate) fn version_control_watch(
    window: tauri::Window,
    controls: State<'_, VersionControls>,
    watchers: State<'_, ProjectWatchers>,
    project: PathBuf,
    on_state: Channel<StateMessage>,
) -> Result<u32, String> {
    let mut watching = controls.watching.lock().map_err(|e| e.to_string())?;
    if !watching.projects.contains_key(&project) {
        let watcher = watchers.for_project(&project)?;
        let state = VersionControl::open(&project).watch(&watcher);
        let fetching = VersionControl::open(&project).fetch_regularly(FETCH_INTERVAL);
        watching.projects.insert(
            project.clone(),
            WatchedProject {
                state,
                _fetching: fetching,
                _watcher: watcher,
            },
        );
    }
    let subscription = watching.projects[&project].state.subscribe(move |state| {
        // Scheitert das Senden, ist das Fenster bereits geschlossen.
        let _ = on_state.send(state.into());
    });
    let id = controls.next_id.fetch_add(1, Ordering::Relaxed);
    watching.subscriptions.insert(
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
pub(crate) fn version_control_unwatch(
    controls: State<'_, VersionControls>,
    id: u32,
) -> Result<(), String> {
    let mut watching = controls.watching.lock().map_err(|e| e.to_string())?;
    watching.subscriptions.remove(&id);
    watching.drop_unused();
    Ok(())
}

/// Die beiden Fassungen, die der Diff einer Änderung gegenüberstellt. Läuft
/// abseits des Haupt-Threads, weil dafür Git aufgerufen wird.
#[tauri::command(async)]
pub(crate) fn version_control_diff(
    project: PathBuf,
    file: ChangedFile,
) -> Result<Diff, VersionControlError> {
    VersionControl::open(&project).diff(&file)
}

/// So oft wird der Stand gegenüber GitHub im Hintergrund abgefragt (wie in
/// VS Code).
const FETCH_INTERVAL: Duration = Duration::from_secs(180);

// Festschreiben und Abgleichen. Jeder Befehl läuft abseits des Haupt-Threads;
// das Ergebnis im Repository erfährt die Oberfläche über den abonnierten Zustand.

/// Wählt die Änderungen aus; ohne `files` alle.
#[tauri::command(async)]
pub(crate) fn version_control_stage(
    project: PathBuf,
    files: Option<Vec<ChangedFile>>,
) -> Result<(), VersionControlError> {
    let version_control = VersionControl::open(&project);
    match files {
        Some(files) => version_control.stage(&files),
        None => version_control.stage_all(),
    }
}

/// Wählt die Änderungen ab; ohne `files` alle.
#[tauri::command(async)]
pub(crate) fn version_control_unstage(
    project: PathBuf,
    files: Option<Vec<ChangedFile>>,
) -> Result<(), VersionControlError> {
    let version_control = VersionControl::open(&project);
    match files {
        Some(files) => version_control.unstage(&files),
        None => version_control.unstage_all(),
    }
}

#[tauri::command(async)]
pub(crate) fn version_control_discard(
    project: PathBuf,
    file: ChangedFile,
) -> Result<(), VersionControlError> {
    VersionControl::open(&project).discard(&file)
}

#[tauri::command(async)]
pub(crate) fn version_control_commit(
    project: PathBuf,
    message: String,
) -> Result<(), VersionControlError> {
    VersionControl::open(&project).commit(&message)
}

#[tauri::command(async)]
pub(crate) fn version_control_commit_and_push(
    project: PathBuf,
    message: String,
) -> Result<Committed, VersionControlError> {
    VersionControl::open(&project).commit_and_push(&message)
}

#[tauri::command(async)]
pub(crate) fn version_control_push(project: PathBuf) -> Result<(), VersionControlError> {
    VersionControl::open(&project).push()
}

#[tauri::command(async)]
pub(crate) fn version_control_pull(project: PathBuf) -> Result<(), VersionControlError> {
    VersionControl::open(&project).pull()
}

#[tauri::command(async)]
pub(crate) fn version_control_pull_and_push(project: PathBuf) -> Result<(), VersionControlError> {
    VersionControl::open(&project).pull_and_push()
}

/// Commits des aktuellen Branches, die neuesten zuerst: höchstens `limit`
/// nach den ersten `skip`.
#[tauri::command(async)]
pub(crate) fn version_control_commits(
    project: PathBuf,
    skip: usize,
    limit: usize,
) -> Result<Vec<crate::version_control::Commit>, VersionControlError> {
    VersionControl::open(&project).commits(skip, limit)
}

/// Die Dateien, die ein Commit geändert hat.
#[tauri::command(async)]
pub(crate) fn version_control_commit_files(
    project: PathBuf,
    commit: String,
) -> Result<Vec<crate::version_control::CommitFile>, VersionControlError> {
    VersionControl::open(&project).commit_files(&commit)
}

/// Die beiden Fassungen, die der Diff einer Datei eines Commits gegenüberstellt.
#[tauri::command(async)]
pub(crate) fn version_control_commit_diff(
    project: PathBuf,
    commit: String,
    file: crate::version_control::CommitFile,
) -> Result<Diff, VersionControlError> {
    VersionControl::open(&project).commit_diff(&commit, &file)
}

/// Die Branches des Projekts: die lokalen und die des Remotes.
#[tauri::command(async)]
pub(crate) fn version_control_branches(
    project: PathBuf,
) -> Result<Vec<Branch>, VersionControlError> {
    VersionControl::open(&project).branches()
}

/// Wechselt zu einem Branch aus der Liste.
#[tauri::command(async)]
pub(crate) fn version_control_switch_branch(
    project: PathBuf,
    branch: Branch,
) -> Result<(), VersionControlError> {
    VersionControl::open(&project).switch_branch(&branch)
}

/// Legt vom aktuellen Stand aus einen Branch an und wechselt zu ihm.
#[tauri::command(async)]
pub(crate) fn version_control_create_branch(
    project: PathBuf,
    name: String,
) -> Result<(), VersionControlError> {
    VersionControl::open(&project).create_branch(&name)
}
