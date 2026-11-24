//! Die Verdrahtung zwischen Fenstern und Kern, mit der Mock-Runtime von Tauri:
//! ohne echtes Fenster, ohne Updater und ohne Netz.

use tauri::async_runtime::block_on;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use crate::app_update::{app_update_install, AppUpdates, Phase};
use crate::notifications::Notifications;

/// Das Fenster, in dem die Person „Jetzt aktualisieren“ klickt.
const MAIN: &str = "main";
/// Ein zweites Fenster.
const OTHER: &str = "projekt-2";

/// Kredr mit allem, was ein Fenster beim Schließen freigibt, wie in `run`, und einer
/// Aktualisierung, die nie gesucht hat und deshalb kein `Update` kennt.
fn kredr() -> App<MockRuntime> {
    crate::manage_per_window(mock_builder())
        .manage(Notifications::new("kredr-test"))
        .manage(AppUpdates::new("0.5.0".into(), None, false))
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

/// Bietet 0.6.0 an und lässt `window` die Rückfrage halten.
fn ask_in(app: &App<MockRuntime>, window: &str) {
    let updates = app.state::<AppUpdates>();
    updates.change(app.handle(), |state, _| state.found("0.6.0".into()));
    updates.change(app.handle(), |state, _| state.ask(window));
    assert_eq!(updates.state().phase, Phase::Confirm);
}

fn phase(app: &App<MockRuntime>) -> Phase {
    app.state::<AppUpdates>().state().phase
}

#[test]
fn schliesst_sich_das_fragende_fenster_endet_die_rueckfrage() {
    let app = kredr();
    let main = open(&app, MAIN);
    ask_in(&app, MAIN);

    crate::on_window_event(&main, &WindowEvent::Destroyed);

    assert_eq!(phase(&app), Phase::Offered);
}

#[test]
fn schliesst_sich_ein_anderes_fenster_bleibt_die_rueckfrage() {
    let app = kredr();
    let _main = open(&app, MAIN);
    let other = open(&app, OTHER);
    ask_in(&app, MAIN);

    crate::on_window_event(&other, &WindowEvent::Destroyed);

    assert_eq!(phase(&app), Phase::Confirm);
}

#[test]
fn installieren_ohne_update_beendet_die_rueckfrage() {
    let app = kredr();
    let main = open(&app, MAIN);
    ask_in(&app, MAIN);

    let installed = block_on(app_update_install(
        app.handle().clone(),
        main,
        app.state::<AppUpdates>(),
    ));

    assert_eq!(installed, Ok(()));
    assert_eq!(phase(&app), Phase::Offered);
}

#[test]
fn installieren_ohne_update_laesst_die_rueckfrage_eines_anderen_fensters() {
    let app = kredr();
    let _main = open(&app, MAIN);
    let other = open(&app, OTHER);
    ask_in(&app, MAIN);

    let installed = block_on(app_update_install(
        app.handle().clone(),
        other,
        app.state::<AppUpdates>(),
    ));

    assert_eq!(installed, Ok(()));
    assert_eq!(phase(&app), Phase::Confirm);
}
