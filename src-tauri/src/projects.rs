//! Projekte und Workspaces öffnen: verbindet die Fenster von Kredr mit der
//! Zuordnung Fenster ↔ Fensterinhalt, der Liste zuletzt geöffneter Projekte
//! und der pro Projekt bzw. Workspace gespeicherten Aufteilung samt
//! Fenstergeometrie.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WebviewWindowBuilder, Window,
};

use crate::arrangement_store::{ArrangementStore, ProjectState, RecentEntry, WorkspaceState};
use crate::project_windows::{project_folder, project_from_args, ProjectWindows, WindowContent};
use crate::window_geometry::{Observed, Screen, WindowGeometry};

/// Das beim Start aus der Konfiguration angelegte Fenster.
const FIRST_WINDOW: &str = "main";
/// Meldet einem Fenster auf der Startseite, was es jetzt zeigt.
const CONTENT_OPENED: &str = "window-content-opened";

/// Zwei gleichzeitige Aufrufe sollen dasselbe Projekt nicht doppelt öffnen.
static OPENING: Mutex<()> = Mutex::new(());

/// Richtet den Aufteilungsspeicher ein und gibt dem ersten Fenster das
/// Projekt aus den Programmargumenten (`kredr <Ordner>`).
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    app.manage(ArrangementStore::new(crate::data_dir(app)?));
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let project = project_from_args(&args, &cwd);
    if let Some(folder) = &project {
        remember(app, folder);
        restore_geometry(app, FIRST_WINDOW, folder);
    }
    app.state::<ProjectWindows>()
        .assign(FIRST_WINDOW, content_for(project.clone()));
    // Ohne Projekt kommen die Workspaces zurück, die beim Beenden offen waren.
    if project.is_none() {
        reopen_workspaces(app);
    }
    Ok(())
}

/// Öffnet die beim Beenden offenen Workspaces wieder: den ersten im ersten
/// Fenster, jeden weiteren in einem neuen.
fn reopen_workspaces(app: &AppHandle) {
    let store = app.state::<ArrangementStore>();
    let windows = app.state::<ProjectWindows>();
    let mut first = true;
    for id in store.open_workspaces() {
        let Some(state) = store.workspace_state(&id) else {
            continue;
        };
        let content = WindowContent::Workspace {
            id,
            name: state.name,
            projects: state.projects,
        };
        if first {
            if windows.claim(FIRST_WINDOW, content).is_ok() {
                place(app, FIRST_WINDOW, state.window);
                first = false;
            }
            continue;
        }
        let label = windows.next_label();
        if windows.claim(&label, content).is_err() {
            continue;
        }
        let app = app.clone();
        // Ein Fenster darf unter Windows nicht aus dem Hauptthread heraus
        // entstehen, während dieser ein Ereignis bearbeitet.
        std::thread::spawn(move || {
            if let Err(error) = open_window(&app, &label, state.window) {
                app.state::<ProjectWindows>().release(&label);
                eprintln!("Fenster konnte nicht geöffnet werden: {error}");
            }
        });
    }
}

/// Der Fensterinhalt für ein Projekt; ohne Projekt die Startseite.
fn content_for(project: Option<PathBuf>) -> WindowContent {
    match project {
        Some(path) => WindowContent::Project { path },
        None => WindowContent::StartPage,
    }
}

/// Ein weiterer Start von Kredr (Startmenü, Rechtsklick, `kredr .`) landet
/// hier im bereits laufenden Prozess.
pub fn open_from_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let project = project_from_args(&args, Path::new(&cwd));
    let app = app.clone();
    // Ein Fenster darf unter Windows nicht aus dem Hauptthread heraus
    // entstehen, während dieser ein Ereignis bearbeitet.
    std::thread::spawn(move || open(&app, project));
}

/// Zeigt das Projekt in einem Fenster: holt sein Fenster nach vorn, nutzt
/// ein Fenster auf der Startseite oder öffnet ein neues. Ohne Projekt geht
/// es um die Startseite.
fn open(app: &AppHandle, project: Option<PathBuf>) {
    let _guard = OPENING.lock();
    let windows = app.state::<ProjectWindows>();
    let existing = match &project {
        Some(folder) => windows.window_of(folder),
        None => windows.start_page_window(),
    };
    if let Some(label) = existing {
        return focus(app, &label);
    }
    if let Some(folder) = &project {
        remember(app, folder);
        if let Some(label) = windows.start_page_window() {
            let content = WindowContent::Project {
                path: folder.clone(),
            };
            windows.assign(&label, content.clone());
            restore_geometry(app, &label, folder);
            let _ = app.emit_to(label.as_str(), CONTENT_OPENED, content);
            return focus(app, &label);
        }
    }
    let label = windows.next_label();
    windows.assign(&label, content_for(project.clone()));
    let geometry = project
        .as_deref()
        .and_then(|folder| app.state::<ArrangementStore>().project_state(folder).window);
    if let Err(error) = open_window(app, &label, geometry) {
        windows.release(&label);
        eprintln!("Fenster konnte nicht geöffnet werden: {error}");
    }
}

/// Ein weiteres Fenster, eingerichtet wie das erste. Mit gespeicherter
/// Fenstergeometrie erscheint es dort, wo es zuletzt lag.
fn open_window(
    app: &AppHandle,
    label: &str,
    geometry: Option<WindowGeometry>,
) -> tauri::Result<()> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .unwrap_or_default();
    config.label = label.to_string();
    // Sichtbar wird das Fenster erst an seinem Platz.
    config.visible = false;
    let window = WebviewWindowBuilder::from_config(app, &config)?.build()?;
    place(app, label, geometry);
    window.show()
}

/// Gibt dem Fenster Größe und Position, die für das Projekt gespeichert
/// sind. Ohne gespeicherte Fenstergeometrie bleibt es, wie es ist.
fn restore_geometry(app: &AppHandle, label: &str, folder: &Path) {
    let stored = app.state::<ArrangementStore>().project_state(folder).window;
    place(app, label, stored);
}

/// Gibt dem Fenster die gespeicherte Größe und Position; ohne sie bleibt es, wie es ist.
fn place(app: &AppHandle, label: &str, stored: Option<WindowGeometry>) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Some(stored) = stored else {
        return;
    };
    // Liegt die Position außerhalb der aktuellen Bildschirme, erscheint das
    // Fenster trotzdem sichtbar.
    let geometry = stored.visible_on(&screens(&window));
    if !geometry.maximized && window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    // Erst der Ort, dann die Größe: Auf einem Bildschirm mit anderer
    // Skalierung passt Windows die Größe beim Verschieben an.
    let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
    let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
    if geometry.maximized {
        let _ = window.maximize();
    }
}

/// Die nutzbaren Flächen der aktuellen Bildschirme, der Hauptbildschirm zuerst.
fn screens(window: &WebviewWindow) -> Vec<Screen> {
    let primary = window.primary_monitor().ok().flatten();
    let others = window.available_monitors().unwrap_or_default();
    primary
        .iter()
        .chain(&others)
        .map(|monitor| {
            let area = monitor.work_area();
            Screen {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect()
}

/// Was sich am Fenster gerade ablesen lässt; nichts, wenn es bereits schließt.
fn observe(window: &Window) -> Option<Observed> {
    if window.is_minimized().ok()? {
        return Some(Observed::Minimized);
    }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let geometry = WindowGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    };
    Some(if window.is_maximized().ok()? {
        Observed::Maximized(geometry)
    } else {
        Observed::Normal(geometry)
    })
}

/// Holt das Fenster nach vorn, auch aus der Taskleiste.
pub(crate) fn focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Die Liste zuletzt geöffneter Projekte ist Komfort: scheitert das
/// Schreiben, öffnet sich das Projekt trotzdem.
fn remember(app: &AppHandle, folder: &Path) {
    if let Err(error) = app.state::<ArrangementStore>().remember_project(folder) {
        eprintln!("Projektliste konnte nicht gespeichert werden: {error}");
    }
}

/// Setzt den Workspace an den Anfang der Zuletzt-Liste; auch das ist Komfort.
fn remember_workspace(store: &ArrangementStore, id: &str) {
    if let Err(error) = store.remember_workspace(id) {
        eprintln!("Zuletzt-Liste konnte nicht gespeichert werden: {error}");
    }
}

/// Vergisst ein geschlossenes Fenster; seine Projekte gelten danach nicht mehr als offen.
pub fn window_closed(window: &Window) {
    let windows = window.state::<ProjectWindows>();
    windows.release(window.label());
    // Schließt das letzte Fenster, beendet sich Kredr: Dessen Workspaces
    // bleiben gemerkt und kommen beim nächsten Start zurück.
    if windows.any_open() {
        remember_open_workspaces(window.app_handle());
    }
}

/// Merkt sich, welche Workspaces gerade in einem Fenster offen sind.
fn remember_open_workspaces(app: &AppHandle) {
    let ids = app.state::<ProjectWindows>().workspace_ids();
    if let Err(error) = app
        .state::<ArrangementStore>()
        .remember_open_workspaces(&ids)
    {
        eprintln!("Offene Workspaces konnten nicht gespeichert werden: {error}");
    }
}

/// Was das aufrufende Fenster zeigt.
#[tauri::command]
pub fn window_content(window: Window, windows: State<'_, ProjectWindows>) -> WindowContent {
    windows.content_of(window.label())
}

/// Wessen Aufteilung ein Fenster speichert: die eines Projekts oder eines Workspace.
enum Saved {
    Project(PathBuf),
    Workspace {
        id: String,
        name: String,
        projects: Vec<PathBuf>,
    },
}

fn saved_by(windows: &ProjectWindows, label: &str) -> Option<Saved> {
    match windows.content_of(label) {
        WindowContent::StartPage => None,
        WindowContent::Project { path } => Some(Saved::Project(path)),
        WindowContent::Workspace { id, name, projects } => {
            Some(Saved::Workspace { id, name, projects })
        }
    }
}

/// Was aus dem Hinzufügen eines Projekts zum Fenster wurde.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddProjectOutcome {
    /// Das Fenster zeigt jetzt diesen Inhalt.
    Added { content: WindowContent },
    /// Ein Projekt ist schon in einem anderen Fenster offen; jenes ist jetzt vorn.
    OpenElsewhere,
}

/// Gibt dem aufrufenden Fenster den Workspace `content`, den die Oberfläche
/// mit einem weiteren Projekt gebildet hat. Wird dabei aus einem
/// Projektfenster ein Workspace, übernimmt er die gespeicherte Aufteilung
/// und Fenstergeometrie des Projekts; die des hinzugefügten Projekts bleibt
/// unberührt (ADR 0004).
#[tauri::command]
pub fn add_project(
    app: AppHandle,
    window: Window,
    windows: State<'_, ProjectWindows>,
    store: State<'_, ArrangementStore>,
    content: WindowContent,
) -> Result<AddProjectOutcome, String> {
    let WindowContent::Workspace { id, name, projects } = content else {
        return Err("only a workspace can receive another project".to_string());
    };
    let projects = projects
        .iter()
        .map(|path| {
            project_folder(path).ok_or_else(|| format!("{} is not a folder", path.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let _guard = OPENING.lock();
    let previous = windows.content_of(window.label());
    let content = WindowContent::Workspace {
        id: id.clone(),
        name: name.clone(),
        projects: projects.clone(),
    };
    if let Err(other) = windows.claim(window.label(), content.clone()) {
        focus(&app, &other);
        return Ok(AddProjectOutcome::OpenElsewhere);
    }
    // Die Projekte stehen sofort im Speicher, nicht erst mit der nächsten
    // Änderung der Aufteilung. Ein neuer Workspace übernimmt, was für das
    // Projekt gespeichert ist; ein bestehender behält seinen Stand.
    let (arrangement, geometry) = match &previous {
        WindowContent::Project { path } => {
            let running = store.project_state(path);
            (running.arrangement, running.window)
        }
        WindowContent::StartPage | WindowContent::Workspace { .. } => store
            .workspace_state(&id)
            .map(|state| (state.arrangement, state.window))
            .unwrap_or_default(),
    };
    let state = WorkspaceState {
        name,
        projects,
        arrangement,
        window: geometry,
    };
    if let Err(error) = store.save_workspace_state(&id, &state) {
        // Ohne gespeicherten Workspace zeigt das Fenster weiter, was es zeigte.
        windows.assign(window.label(), previous);
        return Err(error.to_string());
    }
    remember_workspace(&store, &id);
    remember_open_workspaces(&app);
    Ok(AddProjectOutcome::Added { content })
}

/// Die zuletzt genutzten Projekte und Workspaces gemischt, das jüngste zuerst.
#[tauri::command]
pub fn recent_entries(store: State<'_, ArrangementStore>) -> Vec<RecentEntry> {
    store.recent()
}

/// Entfernt ein Projekt aus der Liste und liefert die Liste danach.
#[tauri::command]
pub fn forget_project(
    store: State<'_, ArrangementStore>,
    path: PathBuf,
) -> Result<Vec<RecentEntry>, String> {
    store.forget_project(&path).map_err(|e| e.to_string())?;
    Ok(store.recent())
}

/// Entfernt einen Workspace aus der Liste und liefert die Liste danach.
#[tauri::command]
pub fn forget_workspace(
    store: State<'_, ArrangementStore>,
    id: String,
) -> Result<Vec<RecentEntry>, String> {
    store.forget_workspace(&id).map_err(|e| e.to_string())?;
    Ok(store.recent())
}

/// Was aus dem Öffnen eines Workspace wurde.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenWorkspaceOutcome {
    /// Das Fenster zeigt jetzt diesen Inhalt.
    Opened { content: WindowContent },
    /// Ein Projekt ist schon in einem anderen Fenster offen; jenes ist jetzt vorn.
    OpenElsewhere,
}

/// Öffnet den gespeicherten Workspace im aufrufenden Fenster mit seiner
/// Fenstergeometrie; seine Aufteilung lädt die Oberfläche danach. Ist eines
/// seiner Projekte schon in einem anderen Fenster offen, kommt jenes nach
/// vorn, und das Fenster zeigt weiter, was es zeigte.
#[tauri::command]
pub fn open_workspace(
    app: AppHandle,
    window: Window,
    windows: State<'_, ProjectWindows>,
    store: State<'_, ArrangementStore>,
    id: String,
) -> Result<OpenWorkspaceOutcome, String> {
    let _guard = OPENING.lock();
    let state = store
        .workspace_state(&id)
        .ok_or_else(|| format!("workspace {id} is not stored"))?;
    let content = WindowContent::Workspace {
        id: id.clone(),
        name: state.name,
        projects: state.projects,
    };
    if let Err(other) = windows.claim(window.label(), content.clone()) {
        focus(&app, &other);
        return Ok(OpenWorkspaceOutcome::OpenElsewhere);
    }
    remember_workspace(&store, &id);
    place(&app, window.label(), state.window);
    remember_open_workspaces(&app);
    Ok(OpenWorkspaceOutcome::Opened { content })
}

/// Öffnet den Ordner als Projekt im aufrufenden Fenster und liefert, was das
/// Fenster danach zeigt. Ist das Projekt schon in einem anderen Fenster
/// offen, kommt jenes nach vorn und das Ergebnis ist nichts.
#[tauri::command]
pub fn open_project(
    app: AppHandle,
    window: Window,
    windows: State<'_, ProjectWindows>,
    path: PathBuf,
) -> Result<Option<WindowContent>, String> {
    let folder =
        project_folder(&path).ok_or_else(|| format!("{} is not a folder", path.display()))?;
    let _guard = OPENING.lock();
    if let Some(label) = windows.window_of(&folder) {
        if label != window.label() {
            focus(&app, &label);
            return Ok(None);
        }
    }
    remember(&app, &folder);
    restore_geometry(&app, window.label(), &folder);
    let content = WindowContent::Project { path: folder };
    windows.assign(window.label(), content.clone());
    Ok(Some(content))
}

/// Die gespeicherte Aufteilung des Projekts oder Workspace dieses Fensters,
/// im Format der Oberfläche; nichts, wenn keine lesbare gespeichert ist.
#[tauri::command(async)]
pub fn arrangement_load(
    window: Window,
    windows: State<'_, ProjectWindows>,
    store: State<'_, ArrangementStore>,
) -> Option<serde_json::Value> {
    match saved_by(&windows, window.label())? {
        Saved::Project(project) => store.project_state(&project).arrangement,
        Saved::Workspace { id, .. } => store.workspace_state(&id)?.arrangement,
    }
}

/// Speichert die Aufteilung des Projekts oder Workspace dieses Fensters und
/// dazu Größe und Position des Fensters, wie sie gerade sind.
#[tauri::command(async)]
pub fn arrangement_save(
    window: Window,
    windows: State<'_, ProjectWindows>,
    store: State<'_, ArrangementStore>,
    arrangement: serde_json::Value,
) -> Result<(), String> {
    let geometry = |previous: Option<WindowGeometry>| match observe(&window) {
        Some(observed) => WindowGeometry::remember(previous, observed),
        None => previous,
    };
    let saved = match saved_by(&windows, window.label()) {
        None => return Ok(()),
        Some(Saved::Project(project)) => {
            let previous = store.project_state(&project).window;
            let state = ProjectState {
                arrangement: Some(arrangement),
                window: geometry(previous),
            };
            store.save_project_state(&project, &state)
        }
        Some(Saved::Workspace { id, name, projects }) => {
            let previous = store.workspace_state(&id).and_then(|state| state.window);
            let state = WorkspaceState {
                name,
                projects,
                arrangement: Some(arrangement),
                window: geometry(previous),
            };
            store.save_workspace_state(&id, &state)
        }
    };
    saved.map_err(|e| e.to_string())
}
