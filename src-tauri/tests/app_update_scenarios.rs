//! Spielt die gemeinsamen Abläufe aus `src/appUpdateScenarios.json` gegen den
//! Zustand der Aktualisierung im Kern ab. Dieselben Abläufe prüfen in Vitest
//! den Kern der Tests; so laufen die beiden nicht auseinander.

use kredr_lib::app_update::AppUpdateState;
use serde::Deserialize;

/// Das Fenster, in dem die Person klickt.
const MAIN: &str = "main";

#[derive(Deserialize)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    /// `ask`, `cancel`, `download`, `install`, `fail` oder `later`.
    #[serde(rename = "do")]
    action: String,
    /// Was der Aufruf zurückgibt, wo die Oberfläche es auswertet.
    returns: Option<bool>,
    phase: String,
    hidden: bool,
}

/// Führt `action` aus, wie die Befehle des Kerns es für `MAIN` tun.
fn play(state: &mut AppUpdateState, action: &str) -> bool {
    match action {
        "ask" => state.ask(MAIN),
        "cancel" => state.cancel_confirm(MAIN),
        "download" => state.start_download(MAIN) && state.finish_download(),
        "install" => state.start_install(MAIN),
        "fail" => state.window_failed(MAIN, "Fehler".to_string()),
        "later" => state.later(),
        other => panic!("unbekannter Schritt {other}"),
    }
}

#[test]
fn der_kern_folgt_den_gemeinsamen_ablaeufen() {
    let scenarios: Vec<Scenario> =
        serde_json::from_str(include_str!("../../src/appUpdateScenarios.json")).unwrap();
    for scenario in scenarios {
        let mut state = AppUpdateState::new("0.5.0", None);
        state.found("0.6.0".to_string());
        for (index, step) in scenario.steps.iter().enumerate() {
            let at = format!("{}, Schritt {} ({})", scenario.name, index + 1, step.action);
            let returned = play(&mut state, &step.action);
            if let Some(expected) = step.returns {
                assert_eq!(returned, expected, "{at}: Rückgabe");
            }
            let shown = serde_json::to_value(&state).unwrap();
            assert_eq!(shown["phase"], step.phase, "{at}: Phase");
            assert_eq!(shown["hidden"], step.hidden, "{at}: ausgeblendet");
        }
    }
}
