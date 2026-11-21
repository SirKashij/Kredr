//! Projekte öffnen: verbindet die Fenster von Kredr mit der Zuordnung
//! Fenster ↔ Projekt, der Liste zuletzt geöffneter Projekte und der pro
//! Projekt gespeicherten Aufteilung samt Fenstergeometrie.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WebviewWindowBuilder, Window,
};

use crate::arrangement_store::{ArrangementStore, ProjectState, RecentProject};
use crate::project_windows::{project_folder, project_from_args, ProjectWindows};
use crate::window_geometry::{Observed, Screen, WindowGeometry};

/// Das beim Start aus der Konfiguration angelegte Fenster.
const FIRST_WINDOW: &str = "main";
/// Meldet einem Fenster auf der Startseite, welches Projekt es jetzt zeigt.
const PROJECT_OPENED: &str = "project-opened";

/// Zwei gleichzeitige Aufrufe sollen dasselbe Projekt nicht doppelt öffnen.
static OPENING: Mutex<()> = Mutex::new(());

/// Richtet den Aufteilungsspeicher ein und gibt dem ersten Fenster das
/// Projekt aus den Programmargumenten (`kredr <Ordner>`).
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    app.manage(ArrangementStore::new(app.path().app_data_dir()?));
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let project = project_from_args(&args, &cwd);
    if let Some(folder) = &project {
        remember(app, folder);
        restore_geometry(app, FIRST_WINDOW, folder);
    }
    app.state::<ProjectWindows>().assign(FIRST_WINDOW, project);
    Ok(())
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
            windows.assign(&label, project.clone());
            restore_geometry(app, &label, folder);
            let _ = app.emit_to(label.as_str(), PROJECT_OPENED, folder);
            return focus(app, &label);
        }
    }
    let label = windows.next_label();
    windows.assign(&label, project.clone());
    if let Err(error) = open_window(app, &label, project.as_deref()) {
        windows.release(&label);
        eprintln!("Fenster konnte nicht geöffnet werden: {error}");
    }
}

/// Ein weiteres Fenster, eingerichtet wie das erste. Mit einem Projekt
/// erscheint es dort, wo dessen Fenster zuletzt lag.
fn open_window(app: &AppHandle, label: &str, project: Option<&Path>) -> tauri::Result<()> {
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
    if let Some(folder) = project {
        restore_geometry(app, label, folder);
    }
    window.show()
}

/// Gibt dem Fenster Größe und Position, die für das Projekt gespeichert
/// sind. Ohne gespeicherte Fenstergeometrie bleibt es, wie es ist.
fn restore_geometry(app: &AppHandle, label: &str, folder: &Path) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let Some(stored) = app.state::<ArrangementStore>().project_state(folder).window else {
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

/// Vergisst ein geschlossenes Fenster; sein Projekt gilt danach nicht mehr als offen.
pub fn window_closed(window: &Window) {
    window.state::<ProjectWindows>().release(window.label());
}

/// Das Projekt des aufrufenden Fensters; ohne Projekt zeigt es die Startseite.
#[tauri::command]
pub fn window_project(window: Window, windows: State<'_, ProjectWindows>) -> Option<PathBuf> {
    windows.project_of(window.label())
}

#[tauri::command]
pub fn recent_projects(store: State<'_, ArrangementStore>) -> Vec<RecentProject> {
    store.recent_projects()
}

/// Entfernt ein Projekt aus der Liste und liefert die Liste danach.
#[tauri::command]
pub fn forget_project(
    store: State<'_, ArrangementStore>,
    path: PathBuf,
) -> Result<Vec<RecentProject>, String> {
    store.forget_project(&path).map_err(|e| e.to_string())?;
    Ok(store.recent_projects())
}

/// Öffnet den Ordner als Projekt im aufrufenden Fenster. Ist das Projekt
/// schon in einem anderen Fenster offen, kommt jenes nach vorn und das
/// Ergebnis ist `false`.
#[tauri::command]
pub fn open_project(
    app: AppHandle,
    window: Window,
    windows: State<'_, ProjectWindows>,
    path: PathBuf,
) -> Result<bool, String> {
    let folder =
        project_folder(&path).ok_or_else(|| format!("{} is not a folder", path.display()))?;
    let _guard = OPENING.lock();
    if let Some(label) = windows.window_of(&folder) {
        if label != window.label() {
            focus(&app, &label);
            return Ok(false);
        }
    }
    remember(&app, &folder);
    restore_geometry(&app, window.label(), &folder);
    windows.assign(window.label(), Some(folder));
    Ok(true)
}

/// Die gespeicherte Aufteilung des Projekts dieses Fensters, im Format der
/// Oberfläche; nichts, wenn keine lesbare gespeichert ist.
#[tauri::command(async)]
pub fn arrangement_load(
    window: Window,
    windows: State<'_, ProjectWindows>,
    store: State<'_, ArrangementStore>,
) -> Option<serde_json::Value> {
    let project = windows.project_of(window.label())?;
    store.project_state(&project).arrangement
}

/// Speichert die Aufteilung des Projekts dieses Fensters und dazu Größe und
/// Position des Fensters, wie sie gerade sind.
#[tauri::command(async)]
pub fn arrangement_save(
    window: Window,
    windows: State<'_, ProjectWindows>,
    store: State<'_, ArrangementStore>,
    arrangement: serde_json::Value,
) -> Result<(), String> {
    let Some(project) = windows.project_of(window.label()) else {
        return Ok(());
    };
    let previous = store.project_state(&project).window;
    let state = ProjectState {
        arrangement: Some(arrangement),
        window: match observe(&window) {
            Some(observed) => WindowGeometry::remember(previous, observed),
            None => previous,
        },
    };
    store
        .save_project_state(&project, &state)
        .map_err(|e| e.to_string())
}
