//! Der Ablauf der Aktualisierung mit dem vorgespielten Updater, über die
//! Befehle des Kerns und die Mock-Runtime von Tauri: ohne echtes Fenster,
//! ohne Netz und ohne Pausen. Die Fenster spielen Fakes, die wie die
//! Oberfläche auf Rundfragen antworten und die Rückfrage beantworten.
//!
//! Tauri stellt Rust-Listenern ein Ereignis nicht sicher zu, wenn ein
//! anderer Thread gerade eines sendet: Es landet in einer Warteschlange, die
//! erst das nächste Ereignis mit Rust-Listenern leert, oft zu spät oder nie
//! (`try_lock` in `tauri/src/event/listener.rs`, auch außerhalb der
//! Mock-Runtime). Die Fake-Fenster hören die Rundfrage, anders als eine
//! Webview, in Rust. Darum sendet in diesen Tests nur der Ablauf selbst, aus
//! einem Thread: Die Fake-Fenster antworten per Befehl wie die Oberfläche und
//! warten auf die Rückfrage und den Download am Zustand statt an
//! `app-update-changed`.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::async_runtime::block_on;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Listener, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

use crate::app_update::{
    app_update_answer, app_update_cancel, app_update_check, app_update_now, window_poll_answer,
    AppUpdateState, AppUpdates, CheckResult, FailureCause, Phase, SimulatedUpdater, UpdateReasons,
    Updater, WindowPolls,
};
use crate::arrangement_store::ArrangementStore;
use crate::notifications::Notifications;
use crate::project_windows::{ProjectWindows, WindowContent};

/// Das Fenster, in dem die Person „Jetzt aktualisieren“ klickt.
const MAIN: &str = "main";
/// Ein zweites Fenster.
const OTHER: &str = "window-1";

/// Was in den Fenstern und am Installer geschah, in Reihenfolge.
type Journal = Arc<Mutex<Vec<String>>>;

/// Kredr mit dem vorgespielten Updater, der 0.6.0 anbietet und an `failure`
/// scheitert; ein Zehntel des Downloads dauert `pace`. Die Aufteilungen und
/// die Notiz für den Neustart liegen in `data`. Wo der Installer starten
/// würde, schreibt der Updater ins `journal`, ob die Notiz dann bereitliegt.
fn kredr(
    failure: Option<FailureCause>,
    pace: Duration,
    data: &Path,
    journal: &Journal,
) -> App<MockRuntime> {
    let journal = journal.clone();
    let notes = data.join("restart-windows.json");
    let updater =
        SimulatedUpdater::new(Some("0.6.0".into()), failure, pace).on_installer(move || {
            let note = if notes.exists() {
                "mit Notiz"
            } else {
                "ohne Notiz"
            };
            journal.lock().unwrap().push(format!("Installer {note}"));
        });
    let app = crate::manage_per_window(mock_builder())
        .manage(Notifications::new("kredr-test"))
        .manage(ArrangementStore::new(data))
        .manage(WindowPolls::default())
        .manage(
            AppUpdates::new("0.5.0".into(), None, false, Updater::Simulated(updater))
                .poll_timeout(Duration::from_millis(300)),
        )
        .build(mock_context(noop_assets()))
        .expect("die Mock-App sollte starten");
    let updates = app.state::<AppUpdates>();
    updates.change(app.handle(), |state| state.found("0.6.0".into()));
    app
}

/// Ein Fenster, das ein Projekt zeigt und wie die Oberfläche antwortet: auf
/// jede Rundfrage nach Anlässen mit dem nächsten aus `reasons` (der letzte
/// gilt weiter), ohne Eintrag gar nicht; auf die Rückfrage wie `person`.
fn open(
    app: &App<MockRuntime>,
    label: &str,
    reasons: Vec<UpdateReasons>,
    person: Person,
    journal: &Journal,
) -> Window<MockRuntime> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .build()
        .expect("das Fenster sollte sich öffnen")
        .as_ref()
        .window();
    app.state::<ProjectWindows>().assign(
        label,
        WindowContent::Project {
            path: format!("C:/projekt-{label}").into(),
        },
    );
    answer_polls(app, label, reasons, journal);
    answer_confirm(app, &window, person, journal);
    window
}

/// Antwortet wie `answerPolls` in `App.tsx` auf `window-poll` mit dem Befehl
/// `window_poll_answer`, wie eine Webview aus einem eigenen Thread.
fn answer_polls(
    app: &App<MockRuntime>,
    label: &str,
    reasons: Vec<UpdateReasons>,
    journal: &Journal,
) {
    let (handle, label, journal) = (app.handle().clone(), label.to_owned(), journal.clone());
    let asked = Arc::new(Mutex::new(0usize));
    let reasons = Arc::new(reasons);
    app.listen_any("window-poll", move |event| {
        let (handle, label, journal) = (handle.clone(), label.clone(), journal.clone());
        let (asked, reasons) = (asked.clone(), reasons.clone());
        let poll: Value = serde_json::from_str(event.payload()).unwrap();
        std::thread::spawn(move || {
            let answer = match poll["question"].as_str().unwrap() {
                "updateReasons" => {
                    let mut asked = asked.lock().unwrap();
                    let Some(now) = reasons.get((*asked).min(reasons.len().saturating_sub(1)))
                    else {
                        return;
                    };
                    *asked += 1;
                    serde_json::to_value(now).unwrap()
                }
                "saveArrangement" => {
                    journal.lock().unwrap().push(format!("Aufteilung {label}"));
                    json!(true)
                }
                other => panic!("unbekannte Frage {other}"),
            };
            let Some(window) = handle.get_webview_window(&label) else {
                return;
            };
            let id = poll["id"].as_str().unwrap().to_owned();
            window_poll_answer(window, handle.state(), id, answer);
        });
    });
}

/// Was die Person im Dialog der Rückfrage tut.
#[derive(Clone, Copy)]
enum Person {
    /// „Trotzdem aktualisieren“.
    Proceeds,
    /// „Später“.
    Later,
    /// Sie schließt das fragende Fenster, statt zu antworten.
    ClosesWindow,
    /// Sie antwortet nicht.
    Waits,
}

/// Zeigt die Rückfrage, wenn der Kern sie in `window` verlangt, und antwortet
/// wie `person`. Das Journal nennt das Fenster und die Anlässe.
fn answer_confirm(
    app: &App<MockRuntime>,
    window: &Window<MockRuntime>,
    person: Person,
    journal: &Journal,
) {
    let (handle, window) = (app.handle().clone(), window.clone());
    // Bis der Kern die Antwort verarbeitet, steht dieselbe Rückfrage im Zustand.
    let mut shown: Option<AppUpdateState> = None;
    watch(app, journal, move |state, journal| {
        let asks_here = state.phase == Phase::Confirm
            && state.asker.as_deref() == Some(window.label())
            && state.reasons.is_some();
        if !asks_here || shown.as_ref() == Some(state) {
            return;
        }
        shown = Some(state.clone());
        let reasons = state.reasons.unwrap();
        journal.lock().unwrap().push(format!(
            "Rückfrage {} {}",
            window.label(),
            describe(&reasons)
        ));
        match person {
            Person::Proceeds => app_update_answer(window.clone(), handle.state(), true),
            Person::Later => app_update_answer(window.clone(), handle.state(), false),
            Person::ClosesWindow => crate::on_window_event(&window, &WindowEvent::Destroyed),
            Person::Waits => {}
        }
    });
}

/// Zeigt `watcher` aus einem eigenen Thread immer wieder den Zustand des
/// Kerns, wie ihn ein Fenster mit `app_update_state` liest, bis der Test
/// endet und `journal` fällt.
fn watch(
    app: &App<MockRuntime>,
    journal: &Journal,
    mut watcher: impl FnMut(&AppUpdateState, &Journal) + Send + 'static,
) {
    let (handle, journal) = (app.handle().clone(), Arc::downgrade(journal));
    std::thread::spawn(move || {
        while let Some(journal) = journal.upgrade() {
            watcher(&handle.state::<AppUpdates>().state(), &journal);
            drop(journal);
            std::thread::sleep(Duration::from_millis(1));
        }
    });
}

/// Die Anlässe kurz, etwa `agents=2 unsaved=1`, ohne die leeren.
fn describe(reasons: &UpdateReasons) -> String {
    let all = [
        ("unsaved", reasons.unsaved_files),
        ("processes", reasons.running_processes),
        ("agents", reasons.working_agents),
        ("background", reasons.background_agents),
        ("silent", reasons.silent_windows),
    ];
    all.iter()
        .filter(|(_, count)| *count > 0)
        .map(|(name, count)| format!("{name}={count}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn state(app: &App<MockRuntime>) -> AppUpdateState {
    app.state::<AppUpdates>().state()
}

/// „Jetzt aktualisieren“ in `window`; kehrt zurück, wenn der Ablauf endet.
fn update_now(app: &App<MockRuntime>, window: &Window<MockRuntime>) {
    block_on(app_update_now(
        app.handle().clone(),
        window.clone(),
        app.state(),
    ))
    .expect("der Ablauf meldet Fehlschläge über den Zustand");
}

fn entries(journal: &Journal) -> Vec<String> {
    journal.lock().unwrap().clone()
}

#[test]
fn ohne_anlass_laeuft_jetzt_aktualisieren_ohne_rueckfrage_bis_zum_installer() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );

    update_now(&app, &main);

    assert_eq!(
        entries(&journal),
        vec!["Aufteilung main", "Installer mit Notiz"]
    );
    // Der vorgespielte Installer kehrt zurück, und das Angebot steht wieder.
    let offered = state(&app);
    assert_eq!(offered.phase, Phase::Offered);
    assert_eq!(offered.error, None);
    // Die Notiz für den Neustart ist verworfen.
    let store = app.state::<ArrangementStore>();
    assert!(store.take_restart_windows("0.6.0").is_empty());
}

#[test]
fn die_anlaesse_mehrerer_fenster_kommen_zusammen_in_die_rueckfrage_des_fragenden_fensters() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );
    let busy = UpdateReasons {
        working_agents: 2,
        unsaved_files: 1,
        ..UpdateReasons::NONE
    };
    let _other = open(&app, OTHER, vec![busy], Person::Proceeds, &journal);

    update_now(&app, &main);

    let journal = entries(&journal);
    assert_eq!(journal[0], "Rückfrage main unsaved=1 agents=2");
    // Nach dem Download gibt es keinen neuen Anlass, also keine zweite Rückfrage.
    assert_eq!(
        journal
            .iter()
            .filter(|e| e.starts_with("Rückfrage"))
            .count(),
        1
    );
    assert!(journal.contains(&"Aufteilung window-1".to_owned()));
    assert_eq!(journal.last().unwrap(), "Installer mit Notiz");
}

#[test]
fn spaeter_in_der_rueckfrage_bricht_ab_und_fuehrt_zum_angebot_zurueck() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let busy = UpdateReasons {
        running_processes: 1,
        ..UpdateReasons::NONE
    };
    let main = open(&app, MAIN, vec![busy], Person::Later, &journal);

    update_now(&app, &main);

    assert_eq!(entries(&journal), vec!["Rückfrage main processes=1"]);
    let offered = state(&app);
    assert_eq!(offered.phase, Phase::Offered);
    assert_eq!(offered.asker, None);
    assert_eq!(offered.reasons, None);
}

#[test]
fn ein_stummes_fenster_verlangt_die_rueckfrage() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Later,
        &journal,
    );
    let _silent = open(&app, OTHER, vec![], Person::Proceeds, &journal);

    update_now(&app, &main);

    assert_eq!(entries(&journal), vec!["Rückfrage main silent=1"]);
}
#[test]
fn ein_neuer_anlass_waehrend_des_downloads_fragt_vor_der_installation_erneut() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );
    let working = UpdateReasons {
        working_agents: 1,
        ..UpdateReasons::NONE
    };
    let _other = open(
        &app,
        OTHER,
        vec![UpdateReasons::NONE, working],
        Person::Proceeds,
        &journal,
    );

    update_now(&app, &main);

    let journal = entries(&journal);
    assert_eq!(journal[0], "Rückfrage main agents=1");
    let at = |entry: &str| journal.iter().position(|e| e.starts_with(entry)).unwrap();
    assert!(at("Rückfrage") < at("Aufteilung"), "{journal:?}");
    assert_eq!(journal.last().unwrap(), "Installer mit Notiz");
}

#[test]
fn weniger_anlaesse_nach_dem_download_fragen_nicht_erneut() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let busy = UpdateReasons {
        working_agents: 2,
        unsaved_files: 1,
        ..UpdateReasons::NONE
    };
    // Ein Agent ist während des Downloads fertig geworden; das ist weniger, nicht neu.
    let calmer = UpdateReasons {
        working_agents: 1,
        ..busy
    };
    let main = open(&app, MAIN, vec![busy, calmer], Person::Proceeds, &journal);

    update_now(&app, &main);

    assert_eq!(
        entries(&journal),
        vec![
            "Rückfrage main unsaved=1 agents=2",
            "Aufteilung main",
            "Installer mit Notiz"
        ]
    );
}

#[test]
fn schliesst_sich_das_fragende_fenster_vor_dem_download_endet_der_ablauf_wie_mit_spaeter() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::ClosesWindow,
        &journal,
    );
    let busy = UpdateReasons {
        unsaved_files: 1,
        ..UpdateReasons::NONE
    };
    let _other = open(&app, OTHER, vec![busy], Person::Proceeds, &journal);

    update_now(&app, &main);

    assert_eq!(entries(&journal), vec!["Rückfrage main unsaved=1"]);
    let offered = state(&app);
    assert_eq!(offered.phase, Phase::Offered);
    assert_eq!(offered.reasons, None);
}

/// Lädt `window` neu, `delay` nachdem es die Rückfrage übernommen hat, also
/// während der Kern die Rundfrage abschließt und die Rückfrage stellt. Wartet
/// dazu am Zustand, genauer als mit `watch`.
fn reload_after(app: &App<MockRuntime>, window: &Window<MockRuntime>, delay: Duration) {
    let (handle, window) = (app.handle().clone(), window.clone());
    std::thread::spawn(move || {
        let asks = || {
            let state = handle.state::<AppUpdates>().state();
            state.phase == Phase::Confirm && state.asker.as_deref() == Some(window.label())
        };
        while !asks() {
            std::thread::yield_now();
        }
        let until = std::time::Instant::now() + delay;
        while std::time::Instant::now() < until {
            std::hint::spin_loop();
        }
        app_update_cancel(handle.clone(), window, handle.state());
    });
}

#[test]
fn laedt_das_fragende_fenster_neu_waehrend_der_kern_die_rueckfrage_stellt_endet_der_ablauf() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let busy = UpdateReasons {
        unsaved_files: 1,
        ..UpdateReasons::NONE
    };
    let main = open(&app, MAIN, vec![busy], Person::Waits, &journal);

    // Der Zeitpunkt wandert von Runde zu Runde, damit das Neuladen mal vor,
    // mal mitten in und mal nach dem Stellen der Rückfrage ankommt.
    for round in 0..1000u64 {
        reload_after(&app, &main, Duration::from_micros(round % 250 * 2));
        let (handle, window) = (app.handle().clone(), main.clone());
        let (ended, ends) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            block_on(app_update_now(handle.clone(), window, handle.state())).unwrap();
            let _ = ended.send(());
        });

        // Bliebe die Antwort nach dem Neuladen liegen, wartete der Ablauf ewig.
        ends.recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|_| panic!("der Ablauf hängt in Runde {round}"));
        let offered = state(&app);
        assert_eq!(offered.phase, Phase::Offered, "Runde {round}");
        assert_eq!(offered.asker, None, "Runde {round}");
    }
}

/// Schließt `window`, sobald der Zustand den Download zeigt.
fn close_while_downloading(
    app: &App<MockRuntime>,
    window: &Window<MockRuntime>,
    journal: &Journal,
) {
    let window = window.clone();
    let mut closed = false;
    watch(app, journal, move |state, _| {
        if state.phase == Phase::Downloading && !closed {
            closed = true;
            crate::on_window_event(&window, &WindowEvent::Destroyed);
        }
    });
}

#[test]
fn schliesst_sich_das_fragende_fenster_waehrend_des_downloads_endet_der_ablauf_mit_dessen_ende() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::from_millis(30), data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );
    let _other = open(
        &app,
        OTHER,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );
    let progress = record_progress(&app);
    close_while_downloading(&app, &main, &journal);

    update_now(&app, &main);

    // Der Download lief zu Ende, danach wurde weder gespeichert noch installiert.
    assert_eq!(progress.lock().unwrap().last(), Some(&100));
    assert_eq!(entries(&journal), Vec::<String>::new());
    let offered = state(&app);
    assert_eq!(offered.phase, Phase::Offered);
    assert_eq!(offered.asker, None);
    // Ein anderes Fenster kann es erneut versuchen.
    let other = app.get_webview_window(OTHER).unwrap().as_ref().window();
    update_now(&app, &other);
    let journal = entries(&journal);
    assert!(journal.contains(&"Aufteilung window-1".to_owned()));
    assert_eq!(journal.last().unwrap(), "Installer mit Notiz");
}

#[test]
fn erst_speichern_alle_fenster_ihre_aufteilung_dann_folgen_notiz_und_installer() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );
    let _other = open(
        &app,
        OTHER,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );

    update_now(&app, &main);

    let mut journal = entries(&journal);
    // Die Fenster antworten in beliebiger Reihenfolge.
    journal[..2].sort();
    assert_eq!(
        journal,
        vec![
            "Aufteilung main",
            "Aufteilung window-1",
            "Installer mit Notiz"
        ]
    );
}

#[test]
fn scheitert_der_installer_zeigen_alle_fenster_den_fehlschlag_und_die_notiz_ist_verworfen() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(
        Some(FailureCause::Installer),
        Duration::ZERO,
        data.path(),
        &journal,
    );
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );

    update_now(&app, &main);

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

/// Jeder Fortschritt, den der Kern allen Fenstern meldet, in Prozent. Er
/// kommt vollständig und in Reihenfolge an, weil nur der Ablauf sendet.
fn record_progress(app: &App<MockRuntime>) -> Arc<Mutex<Vec<u8>>> {
    let progress = Arc::new(Mutex::new(Vec::new()));
    let recorded = progress.clone();
    app.listen_any("app-update-changed", move |event| {
        let state: Value = serde_json::from_str(event.payload()).unwrap();
        if let Some(percent) = state["progress"].as_u64() {
            recorded.lock().unwrap().push(percent as u8);
        }
    });
    progress
}

#[test]
fn der_vorgespielte_download_meldet_fortschritt_in_zehn_schritten() {
    let data = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let app = kredr(None, Duration::ZERO, data.path(), &journal);
    let main = open(
        &app,
        MAIN,
        vec![UpdateReasons::NONE],
        Person::Proceeds,
        &journal,
    );
    let progress = record_progress(&app);

    update_now(&app, &main);

    assert_eq!(
        *progress.lock().unwrap(),
        vec![0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    );
}

#[test]
fn der_vorgespielte_download_scheitert_im_netz_und_an_der_signatur() {
    let cases = [
        (FailureCause::Network, "error sending request for url"),
        (FailureCause::Signature, "The signature verification failed"),
    ];
    for (cause, text) in cases {
        let data = tempfile::tempdir().unwrap();
        let journal = Journal::default();
        let app = kredr(Some(cause), Duration::ZERO, data.path(), &journal);
        let main = open(
            &app,
            MAIN,
            vec![UpdateReasons::NONE],
            Person::Proceeds,
            &journal,
        );
        let progress = record_progress(&app);

        update_now(&app, &main);

        let failed = state(&app);
        assert_eq!(failed.phase, Phase::Failed, "{cause:?}");
        assert_eq!(failed.cause, Some(cause));
        assert!(
            failed.error.as_deref().unwrap().starts_with(text),
            "{failed:?}"
        );
        // Er scheitert nach der Hälfte, nicht schon vor dem ersten Fortschritt.
        assert_eq!(*progress.lock().unwrap(), vec![0, 10, 20, 30, 40, 50]);
        // Weder gespeichert noch installiert.
        assert_eq!(entries(&journal), Vec::<String>::new());
    }
}

#[test]
fn ohne_vorgespielte_version_findet_die_entwicklungsfassung_nichts() {
    let app = crate::manage_per_window(mock_builder())
        .manage(AppUpdates::new(
            "0.5.0".into(),
            None,
            false,
            Updater::Simulated(SimulatedUpdater::new(None, None, Duration::ZERO)),
        ))
        .build(mock_context(noop_assets()))
        .expect("die Mock-App sollte starten");

    let checked = block_on(app_update_check(app.handle().clone(), app.state()));

    assert_eq!(checked, Ok(CheckResult::Development));
    assert_eq!(state(&app).phase, Phase::None);
}
