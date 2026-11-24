use kredr_lib::app_update::{AppUpdateState, Phase};

fn state() -> AppUpdateState {
    AppUpdateState::new("0.5.0")
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
