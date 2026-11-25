//! Der vorgespielte adapter der Aktualisierung, über die Befehle des Kerns
//! und die Mock-Runtime von Tauri: ohne echtes Fenster, ohne Netz und ohne
//! Pausen.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::async_runtime::block_on;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Listener, Manager, WebviewUrl, WebviewWindowBuilder, Window};

use crate::app_update::{
    app_update_ask, app_update_check, app_update_download, app_update_install, AppUpdates,
    CheckResult, FailureCause, Phase, SimulatedUpdater, Updater,
};
use crate::arrangement_store::ArrangementStore;
use crate::notifications::Notifications;
use crate::project_windows::{ProjectWindows, WindowContent};

/// Das Fenster, in dem die Person „Jetzt aktualisieren“ klickt.
const MAIN: &str = "main";

/// Kredr mit dem vorgespielten adapter, der `version` anbietet und an
/// `failure` scheitert. Die Aufteilungen liegen in `data`.
fn kredr(version: Option<&str>, failure: Option<FailureCause>, data: &Path) -> App<MockRuntime> {
    let updater = SimulatedUpdater::new(version.map(str::to_owned), failure, Duration::ZERO);
    crate::manage_per_window(mock_builder())
        .manage(Notifications::new("kredr-test"))
        .manage(ArrangementStore::new(data))
        .manage(AppUpdates::new(
            "0.5.0".into(),
            None,
            false,
            Updater::Simulated(updater),
        ))
        .build(mock_context(noop_assets()))
        .expect("die Mock-App sollte starten")
}

fn open(app: &App<MockRuntime>, label: &str) -> Window<MockRuntime> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .build()
        .expect("das Fenster sollte sich öffnen")
        .as_ref()
        .window()
}

fn state(app: &App<MockRuntime>) -> crate::app_update::AppUpdateState {
    app.state::<AppUpdates>().state()
}

/// Jeder Fortschritt, den der Kern allen Fenstern meldet, in Prozent.
fn record_progress(app: &App<MockRuntime>) -> Arc<Mutex<Vec<u8>>> {
    let progress = Arc::new(Mutex::new(Vec::new()));
    let recorded = progress.clone();
    app.listen_any("app-update-changed", move |event| {
        let state: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        if let Some(percent) = state["progress"].as_u64() {
            recorded.lock().unwrap().push(percent as u8);
        }
    });
    progress
}

/// „Jetzt suchen“ findet die vorgespielte Version, und `window` hält die Rückfrage.
fn ask_in(app: &App<MockRuntime>, window: &Window<MockRuntime>) {
    let found = block_on(app_update_check(app.handle().clone(), app.state()));
    assert!(matches!(found, Ok(CheckResult::Found { .. })), "{found:?}");
    assert!(app_update_ask(
        app.handle().clone(),
        window.clone(),
        app.state()
    ));
}

fn download(app: &App<MockRuntime>, window: &Window<MockRuntime>) -> bool {
    block_on(app_update_download(
        app.handle().clone(),
        window.clone(),
        app.state(),
    ))
    .expect("der Download meldet Fehlschläge über den Zustand")
}

#[test]
fn der_vorgespielte_download_meldet_fortschritt_und_haelt_wieder_die_rueckfrage() {
    let data = tempfile::tempdir().unwrap();
    let app = kredr(Some("0.6.0"), None, data.path());
    let main = open(&app, MAIN);
    let progress = record_progress(&app);
    ask_in(&app, &main);

    assert!(download(&app, &main), "die Version sollte bereitliegen");

    assert_eq!(
        *progress.lock().unwrap(),
        vec![0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    );
    assert_eq!(state(&app).phase, Phase::Confirm);
}

#[test]
fn der_vorgespielte_download_scheitert_im_netz_und_an_der_signatur() {
    let cases = [
        (FailureCause::Network, "error sending request for url"),
        (FailureCause::Signature, "The signature verification failed"),
    ];
    for (cause, text) in cases {
        let data = tempfile::tempdir().unwrap();
        let app = kredr(Some("0.6.0"), Some(cause), data.path());
        let main = open(&app, MAIN);
        let progress = record_progress(&app);
        ask_in(&app, &main);

        assert!(!download(&app, &main), "{cause:?}");

        let failed = state(&app);
        assert_eq!(failed.phase, Phase::Failed, "{cause:?}");
        assert_eq!(failed.cause, Some(cause));
        assert!(
            failed.error.as_deref().unwrap().starts_with(text),
            "{failed:?}"
        );
        // Er scheitert nach der Hälfte, nicht schon vor dem ersten Fortschritt.
        assert_eq!(*progress.lock().unwrap(), vec![0, 10, 20, 30, 40, 50]);
    }
}

/// „Jetzt aktualisieren“ bis zur Installation, in `window`, das ein Projekt zeigt.
fn install(app: &App<MockRuntime>, window: &Window<MockRuntime>) {
    app.state::<ProjectWindows>().assign(
        window.label(),
        WindowContent::Project {
            path: "C:/projekt".into(),
        },
    );
    ask_in(app, window);
    assert!(download(app, window));
    block_on(app_update_install(
        app.handle().clone(),
        window.clone(),
        app.state(),
    ))
    .expect("die Installation meldet Fehlschläge über den Zustand");
}

#[test]
fn die_vorgespielte_installation_kehrt_zum_angebot_zurueck_ohne_notiz_fuer_den_neustart() {
    let data = tempfile::tempdir().unwrap();
    let app = kredr(Some("0.6.0"), None, data.path());
    let main = open(&app, MAIN);

    install(&app, &main);

    let offered = state(&app);
    assert_eq!(offered.phase, Phase::Offered);
    assert_eq!(offered.version.as_deref(), Some("0.6.0"));
    assert_eq!(offered.error, None);
    // Nach einem Neustart in die angebotene Version käme kein Fenster zurück.
    let store = app.state::<ArrangementStore>();
    assert!(store.take_restart_windows("0.6.0").is_empty());
    // Die Aktualisierung lässt sich erneut anstoßen.
    assert!(app_update_ask(app.handle().clone(), main, app.state()));
}

#[test]
fn die_vorgespielte_installation_scheitert_am_installer() {
    let data = tempfile::tempdir().unwrap();
    let app = kredr(Some("0.6.0"), Some(FailureCause::Installer), data.path());
    let main = open(&app, MAIN);

    install(&app, &main);

    let failed = state(&app);
    assert_eq!(failed.phase, Phase::Failed);
    assert_eq!(failed.cause, Some(FailureCause::Installer));
    assert_eq!(
        failed.error.as_deref(),
        Some("Das System kann die angegebene Datei nicht finden. (os error 2)")
    );
    let store = app.state::<ArrangementStore>();
    assert!(store.take_restart_windows("0.6.0").is_empty());
}

#[test]
fn ohne_vorgespielte_version_findet_die_entwicklungsfassung_nichts() {
    let data = tempfile::tempdir().unwrap();
    let app = kredr(None, None, data.path());

    let checked = block_on(app_update_check(app.handle().clone(), app.state()));

    assert_eq!(checked, Ok(CheckResult::Development));
    assert_eq!(state(&app).phase, Phase::None);
}
