//! Tests der Einstellungen über ihre öffentliche Schnittstelle, gegen echte
//! Dateien in temporären Ordnern.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kredr_lib::settings::{Language, Settings, SettingsStore, Shell};

/// Ein leerer Ordner, der das Benutzerdatenverzeichnis von Kredr spielt.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kredr-test-einstellungen-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn open(dir: &PathBuf) -> SettingsStore {
    SettingsStore::open(dir, |_| {})
}

fn write_file(dir: &PathBuf, content: &str) {
    std::fs::create_dir_all(dir).expect("Testordner sollte anlegbar sein");
    std::fs::write(dir.join("settings.json"), content).expect("Datei sollte schreibbar sein");
}

fn changed() -> Settings {
    Settings {
        language: Some(Language::En),
        font_family: "Fira Code".into(),
        font_size: 16,
        default_shell: Shell::GitBash,
        agent_command: "claude --model opus".into(),
        notifications: false,
        show_assignment: false,
        resume_agents: false,
    }
}

#[test]
fn ohne_datei_gelten_die_standardwerte() {
    let store = open(&temp_dir("fehlt"));

    let settings = store.get();

    assert_eq!(settings, Settings::default());
    // Ohne gewählte Sprache folgt die Oberfläche der Windows-Sprache.
    assert_eq!(settings.language, None);
    assert_eq!(settings.font_size, 13);
    assert_eq!(settings.default_shell, Shell::Powershell);
    assert_eq!(settings.agent_command, "claude");
    assert!(settings.notifications);
    assert!(settings.show_assignment);
    assert!(settings.resume_agents);
}

#[test]
fn abgeschaltetes_fortsetzen_der_agenten_bleibt_abgeschaltet() {
    let dir = temp_dir("fortsetzen");
    write_file(&dir, r#"{ "version": 1, "resumeAgents": false }"#);

    let settings = open(&dir).get();

    assert!(!settings.resume_agents);
    assert!(settings.show_assignment);
}

#[test]
fn abgeschaltete_benachrichtigungen_bleiben_abgeschaltet() {
    let dir = temp_dir("benachrichtigungen");
    write_file(&dir, r#"{ "version": 1, "notifications": false }"#);

    assert!(!open(&dir).get().notifications);
}

#[test]
fn ein_abgeschalteter_auftrag_am_tab_bleibt_abgeschaltet() {
    let dir = temp_dir("auftrag");
    write_file(&dir, r#"{ "version": 1, "showAssignment": false }"#);

    let settings = open(&dir).get();

    assert!(!settings.show_assignment);
    assert!(settings.notifications);
}

#[test]
fn gespeicherte_einstellungen_werden_wieder_geladen() {
    let dir = temp_dir("hin-und-zurueck");

    open(&dir)
        .set(changed())
        .expect("Speichern sollte gelingen");

    assert_eq!(open(&dir).get(), changed());
}

#[test]
fn speichern_legt_das_verzeichnis_an() {
    let dir = temp_dir("verzeichnis").join("noch").join("nicht-da");

    open(&dir)
        .set(changed())
        .expect("Speichern sollte gelingen");

    assert!(dir.join("settings.json").is_file());
}

#[test]
fn beschaedigte_datei_faellt_auf_standardwerte_zurueck() {
    let dir = temp_dir("beschaedigt");
    write_file(&dir, "{ \"fontSize\": 1");

    assert_eq!(open(&dir).get(), Settings::default());
}

#[test]
fn datei_mit_falschem_inhalt_faellt_auf_standardwerte_zurueck() {
    let dir = temp_dir("falscher-inhalt");
    write_file(&dir, "[1, 2, 3]");

    assert_eq!(open(&dir).get(), Settings::default());
}

#[test]
fn nach_beschaedigter_datei_laesst_sich_wieder_speichern() {
    let dir = temp_dir("beschaedigt-speichern");
    write_file(&dir, "\u{0}\u{0}kein json");

    open(&dir)
        .set(changed())
        .expect("Speichern sollte gelingen");

    assert_eq!(open(&dir).get(), changed());
}

#[test]
fn veraltete_datei_behaelt_bekannte_werte_und_ergaenzt_standardwerte() {
    let dir = temp_dir("veraltet");
    // Ein älteres Format: ohne Version, mit einem inzwischen entfernten Feld
    // und ohne die später hinzugekommenen.
    write_file(&dir, r#"{ "fontSize": 18, "theme": "hell" }"#);

    let settings = open(&dir).get();

    assert_eq!(
        settings,
        Settings {
            font_size: 18,
            ..Settings::default()
        }
    );
}

#[test]
fn ungueltiger_einzelwert_kostet_nicht_die_uebrigen_einstellungen() {
    let dir = temp_dir("einzelwert");
    write_file(
        &dir,
        r#"{ "version": 1, "language": "fr", "fontSize": "gross", "defaultShell": "zsh", "agentCommand": "claude --continue" }"#,
    );

    let settings = open(&dir).get();

    assert_eq!(
        settings,
        Settings {
            agent_command: "claude --continue".into(),
            ..Settings::default()
        }
    );
}

#[test]
fn unbrauchbare_werte_werden_beim_speichern_berichtigt() {
    let store = open(&temp_dir("berichtigt"));

    let saved = store
        .set(Settings {
            font_family: "   ".into(),
            font_size: 500,
            agent_command: "  claude --verbose  ".into(),
            ..Settings::default()
        })
        .expect("Speichern sollte gelingen");

    assert_eq!(saved.font_family, Settings::default().font_family);
    assert_eq!(saved.font_size, 32);
    assert_eq!(saved.agent_command, "claude --verbose");
    assert_eq!(store.get(), saved);
}

#[test]
fn leerer_agent_startbefehl_faellt_auf_den_standard_zurueck() {
    let store = open(&temp_dir("leerer-befehl"));

    let saved = store
        .set(Settings {
            agent_command: String::new(),
            ..changed()
        })
        .expect("Speichern sollte gelingen");

    assert_eq!(saved.agent_command, "claude");
}

#[test]
fn jede_aenderung_wird_gemeldet() {
    let reported = Arc::new(Mutex::new(Vec::new()));
    let sink = reported.clone();
    let store = SettingsStore::open(temp_dir("meldung"), move |settings| {
        sink.lock().unwrap().push(settings.clone());
    });

    store.set(changed()).expect("Speichern sollte gelingen");
    // Dieselben Einstellungen noch einmal sind keine Änderung.
    store.set(changed()).expect("Speichern sollte gelingen");

    assert_eq!(*reported.lock().unwrap(), vec![changed()]);
}
