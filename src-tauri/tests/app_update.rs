use std::path::Path;

use kredr_lib::app_update::{
    failure_cause, load_declined, save_declined, search_with, AppUpdateState, AutoCheck, Edition,
    FailureCause, Phase, SearchOutcome, Step,
};
use tauri::async_runtime::block_on;
use tauri_plugin_updater::Error;

/// Eine Suche bei GitHub, die nie gefragt werden darf.
async fn never_asked() -> Result<Option<String>, Error> {
    panic!("die Entwicklungsfassung hat den Updater gefragt")
}

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
fn jetzt_suchen_bietet_auch_eine_auf_spaeter_gestellte_version_an() {
    let mut state = AppUpdateState::new("0.5.0", Some("0.6.0".into()));

    assert!(state.found_on_request("0.6.0".into()));
    assert_eq!(state.phase, Phase::Offered);
    assert_eq!(state.version.as_deref(), Some("0.6.0"));

    state.later();
    assert!(state.found_on_request("0.6.0".into()));
    assert_eq!(state.phase, Phase::Offered);
}

#[test]
fn jetzt_suchen_bietet_nach_einem_fehlschlag_dieselbe_version_wieder_an() {
    let mut state = state();
    state.found("0.6.0".into());
    state.start_download();
    state.fail(FailureCause::Network, "keine Verbindung".into());

    assert!(state.found_on_request("0.6.0".into()));
    assert_eq!(state.phase, Phase::Offered);
    assert_eq!(state.cause, None);
    assert_eq!(state.error, None);
}

#[test]
fn jetzt_suchen_ordnet_den_fehler_wie_beim_download_ein() {
    let error = tauri_plugin_updater::Error::ReleaseNotFound;

    assert_eq!(failure_cause(&error, Step::Check), FailureCause::Network);
}

#[test]
fn die_entwicklungsfassung_fragt_den_updater_nie() {
    let outcome = block_on(search_with(Edition::Development, never_asked));

    assert_eq!(outcome, SearchOutcome::Locked);
}

#[test]
fn die_installierte_fassung_fragt_den_updater() {
    let found = block_on(search_with(Edition::Installed, || async {
        Ok(Some("0.6.0".to_owned()))
    }));
    let current = block_on(search_with(Edition::Installed, || async {
        Ok(None::<String>)
    }));
    let failed = block_on(search_with(Edition::Installed, || async {
        Err::<Option<String>, _>(Error::ReleaseNotFound)
    }));

    assert_eq!(found, SearchOutcome::Found("0.6.0".to_owned()));
    assert_eq!(current, SearchOutcome::Current);
    assert!(matches!(
        failed,
        SearchOutcome::Failed {
            cause: FailureCause::Network,
            ..
        }
    ));
}

/// Ohne Optimierung gebaut läuft die Entwicklungsfassung, wie bei
/// `npm run tauri dev`; ein Release-Build prüft das nicht.
#[cfg(debug_assertions)]
#[test]
fn ohne_optimierung_laeuft_die_entwicklungsfassung() {
    assert_eq!(Edition::current(), Edition::Development);
}

#[test]
fn angeschaltete_suche_sucht_sofort_einmal() {
    let mut auto = AutoCheck::new(false);

    assert!(
        auto.setting_changed(true),
        "Anschalten sollte sofort suchen"
    );
    // Eine andere Einstellung ändert sich, die Suche bleibt an.
    assert!(!auto.setting_changed(true));
    assert!(!auto.setting_changed(false));
    assert!(auto.setting_changed(true));
}

#[test]
fn eine_von_anfang_an_angeschaltete_suche_sucht_nicht_zusaetzlich() {
    let mut auto = AutoCheck::new(true);

    assert!(!auto.setting_changed(true));
}

#[test]
fn jetzt_suchen_stoert_keine_laufende_aktualisierung() {
    let mut state = state();
    state.found("0.6.0".into());
    state.start_download();

    assert!(!state.found_on_request("0.6.0".into()));
    assert_eq!(state.phase, Phase::Downloading);
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
    // „Später“ blendet dann nur den Hinweis aus.
    assert!(state.later());
    assert_eq!(state.phase, Phase::Downloading);
}

#[test]
fn scheitert_die_aktualisierung_laesst_sie_sich_erneut_anstossen() {
    let mut state = state();
    state.found("0.6.0".into());
    state.start_download();

    state.fail(FailureCause::Signature, "Signatur ungültig".into());

    assert_eq!(state.phase, Phase::Failed);
    assert_eq!(state.cause, Some(FailureCause::Signature));
    assert_eq!(state.error.as_deref(), Some("Signatur ungültig"));
    assert!(state.start_download());
    assert_eq!(state.error, None);
    assert_eq!(state.cause, None);
}

#[test]
fn der_download_meldet_den_fortschritt_in_ganzen_prozent() {
    let mut state = state();
    state.found("0.6.0".into());
    state.start_download();
    assert_eq!(state.progress, Some(0));

    // Nur ein neuer ganzer Prozentwert ist eine Änderung.
    assert!(state.downloaded(420, Some(1000)));
    assert_eq!(state.progress, Some(42));
    assert!(!state.downloaded(425, Some(1000)));
    // Ohne bekannte Größe gibt es keinen Prozentwert.
    assert!(state.downloaded(500, None));
    assert_eq!(state.progress, None);
}

#[test]
fn ein_weggeklickter_download_zeigt_nur_das_symbol() {
    let mut state = state();
    state.found("0.6.0".into());
    state.start_download();
    assert!(!state.hidden);

    assert!(state.later());

    assert_eq!(state.phase, Phase::Downloading);
    assert!(state.hidden);
    // Die Version gilt dadurch nicht als abgelehnt.
    assert_eq!(state.declined(), None);
    // Ein Fehlschlag zeigt den Hinweis wieder.
    state.fail(FailureCause::Network, "timeout".into());
    assert!(!state.hidden);
}

#[test]
fn aus_dem_symbol_angestossen_bleibt_der_hinweis_weg() {
    let mut state = state();
    state.found("0.6.0".into());
    state.later();

    state.start_download();

    assert!(state.hidden);
}

#[test]
fn der_grund_eines_fehlschlags_wird_eingeordnet() {
    use tauri_plugin_updater::Error;

    let cases = [
        (
            Error::Network("timeout".into()),
            Step::Download,
            FailureCause::Network,
        ),
        (
            Error::ReleaseNotFound,
            Step::Download,
            FailureCause::Network,
        ),
        (
            Error::MissingSignedVersion,
            Step::Download,
            FailureCause::Signature,
        ),
        (
            Error::SignatureUtf8("x".into()),
            Step::Download,
            FailureCause::Signature,
        ),
        (
            Error::InvalidUpdaterFormat,
            Step::Install,
            FailureCause::Installer,
        ),
        (Error::FormatDate, Step::Download, FailureCause::Unknown),
    ];
    for (error, step, cause) in cases {
        assert_eq!(failure_cause(&error, step), cause, "{error}");
    }
}
