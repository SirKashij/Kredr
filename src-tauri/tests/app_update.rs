use std::path::Path;

use kredr_lib::app_update::{load_declined, save_declined, AppUpdateState, Phase};

fn state() -> AppUpdateState {
    AppUpdateState::new("0.5.0", None)
}

/// Was Kredr beim Start aus `dir`, dem Benutzerdatenverzeichnis, über die
/// abgelehnte Version weiß.
fn started_from(dir: &Path) -> AppUpdateState {
    AppUpdateState::new("0.5.0", load_declined(dir))
}

#[test]
fn spaeter_merkt_sich_die_version_ueber_einen_neustart() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = started_from(dir.path());
    state.found("0.6.0".into());
    state.later();
    save_declined(
        dir.path(),
        state
            .declined()
            .expect("„Später“ sollte die Version merken"),
    )
    .expect("die Version sollte sich speichern lassen");

    let mut restarted = started_from(dir.path());

    // Dieselbe Version zeigt nur das Symbol, keinen Hinweis.
    assert!(restarted.found("0.6.0".into()));
    assert_eq!(restarted.phase, Phase::Later);
    assert_eq!(restarted.version.as_deref(), Some("0.6.0"));
    // Eine höhere Version bietet sich wieder an.
    assert!(restarted.found("0.7.0".into()));
    assert_eq!(restarted.phase, Phase::Offered);
    assert_eq!(restarted.version.as_deref(), Some("0.7.0"));
}

#[test]
fn eine_fehlende_oder_kaputte_datei_merkt_keine_version() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(load_declined(dir.path()), None);

    std::fs::write(dir.path().join("app-update.json"), "kaputt").unwrap();
    assert_eq!(load_declined(dir.path()), None);
}

#[test]
fn eine_neue_version_ergibt_ein_angebot() {
    let mut state = state();

    assert!(state.found("0.6.0".into()));

    assert_eq!(state.phase, Phase::Offered);
    assert_eq!(state.version.as_deref(), Some("0.6.0"));
    assert_eq!(state.installed, "0.5.0");
}

#[test]
fn nach_spaeter_bietet_dieselbe_version_sich_nicht_erneut_an() {
    let mut state = state();
    state.found("0.6.0".into());
    assert!(state.later());

    assert!(!state.found("0.6.0".into()));
    assert_eq!(state.phase, Phase::Later);

    assert!(state.found("0.7.0".into()));
    assert_eq!(state.phase, Phase::Offered);
    assert_eq!(state.version.as_deref(), Some("0.7.0"));
}

#[test]
fn aktualisieren_laesst_sich_nur_mit_angebot_anstossen() {
    let mut state = state();
    assert!(!state.start_download());

    state.found("0.6.0".into());
    assert!(state.start_download());
    assert_eq!(state.phase, Phase::Downloading);
    // Ein zweiter Klick, auch aus einem anderen Fenster, startet nichts.
    assert!(!state.start_download());
    // Während des Downloads ändert eine Suche nichts.
    assert!(!state.found("0.7.0".into()));
    assert!(!state.later());
}

#[test]
fn scheitert_die_aktualisierung_laesst_sie_sich_erneut_anstossen() {
    let mut state = state();
    state.found("0.6.0".into());
    state.start_download();

    state.fail("Signatur ungültig".into());

    assert_eq!(state.phase, Phase::Failed);
    assert_eq!(state.error.as_deref(), Some("Signatur ungültig"));
    assert!(state.start_download());
    assert_eq!(state.error, None);
}
