//! Tests des Aufteilungsspeichers für Aufteilung und Fenstergeometrie eines
//! Projekts, über seine öffentliche Schnittstelle und gegen echte Dateien in
//! temporären Ordnern.

use std::path::{Path, PathBuf};

use kredr_lib::arrangement_store::{ArrangementStore, ProjectState};
use kredr_lib::window_geometry::WindowGeometry;
use serde_json::json;

/// Ein leerer Ordner unterhalb des temporären Verzeichnisses.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-aufteilung-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("Testordner sollte anlegbar sein");
    dir
}

/// Legt unterhalb von `root` einen Ordner an, der als Projekt dient.
fn project(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).expect("Projektordner sollte anlegbar sein");
    dir
}

fn state(tab: &str, x: i32) -> ProjectState {
    ProjectState {
        arrangement: Some(json!({
            "version": 1,
            "root": { "kind": "group", "id": "g2", "tabs": [{ "id": tab, "name": "Server" }], "activeTab": tab },
            "focusedGroup": "g2",
            "nextId": 3
        })),
        window: Some(WindowGeometry {
            x,
            y: 80,
            width: 1400,
            height: 900,
            maximized: true,
        }),
    }
}

/// Die einzige Datei, die der Speicher für Aufteilungen angelegt hat.
fn arrangement_file(data: &Path) -> PathBuf {
    let mut files = std::fs::read_dir(data.join("arrangements"))
        .expect("Ordner der Aufteilungen sollte vorhanden sein")
        .map(|entry| entry.unwrap().path());
    let file = files.next().expect("eine Datei sollte vorhanden sein");
    assert!(files.next().is_none());
    file
}

#[test]
fn aufteilung_und_fenstergeometrie_ueberstehen_einen_neustart() {
    let root = temp_dir("neustart");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");

    ArrangementStore::new(&data)
        .save_project_state(&alpha, &state("t1", 120))
        .unwrap();

    // Ein neuer Speicher über demselben Ordner entspricht einem Neustart von Kredr.
    let reopened = ArrangementStore::new(&data);
    assert_eq!(reopened.project_state(&alpha), state("t1", 120));
}

#[test]
fn jedes_projekt_hat_seine_eigene_aufteilung() {
    let root = temp_dir("je-projekt");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let store = ArrangementStore::new(root.join("daten"));

    store.save_project_state(&alpha, &state("t1", 10)).unwrap();
    store.save_project_state(&beta, &state("t7", 20)).unwrap();
    store.save_project_state(&alpha, &state("t3", 30)).unwrap();

    assert_eq!(store.project_state(&alpha), state("t3", 30));
    assert_eq!(store.project_state(&beta), state("t7", 20));
}

#[test]
fn die_schreibweise_des_projektordners_spielt_keine_rolle() {
    let root = temp_dir("schreibweise");
    let alpha = project(&root, "alpha");
    let store = ArrangementStore::new(root.join("daten"));
    store.save_project_state(&alpha, &state("t1", 10)).unwrap();

    let other_spelling = format!("{}\\", alpha.to_str().unwrap().to_uppercase());

    assert_eq!(
        store.project_state(other_spelling.as_ref()),
        state("t1", 10)
    );
}

#[test]
fn ein_projekt_ohne_gespeicherte_aufteilung_hat_keine() {
    let root = temp_dir("ohne");
    let alpha = project(&root, "alpha");

    let store = ArrangementStore::new(root.join("daten"));

    assert_eq!(store.project_state(&alpha), ProjectState::default());
}

#[test]
fn beschaedigte_datei_ergibt_keine_aufteilung_und_wird_beim_naechsten_speichern_ersetzt() {
    let root = temp_dir("beschaedigt");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let store = ArrangementStore::new(&data);
    store.save_project_state(&alpha, &state("t1", 10)).unwrap();

    std::fs::write(arrangement_file(&data), "{ \"version\": 1, \"arrang").unwrap();

    assert_eq!(store.project_state(&alpha), ProjectState::default());
    store.save_project_state(&alpha, &state("t2", 20)).unwrap();
    assert_eq!(
        ArrangementStore::new(&data).project_state(&alpha),
        state("t2", 20)
    );
}

#[test]
fn datei_einer_anderen_version_ergibt_keine_aufteilung() {
    let root = temp_dir("version");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let store = ArrangementStore::new(&data);
    store.save_project_state(&alpha, &state("t1", 10)).unwrap();

    let file = arrangement_file(&data);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("\"version\": 1"));
    for version in ["0", "999"] {
        let other = text.replacen("\"version\": 1", &format!("\"version\": {version}"), 1);
        std::fs::write(&file, other).unwrap();

        assert_eq!(store.project_state(&alpha), ProjectState::default());
    }
}

#[test]
fn die_aufteilung_liegt_im_verzeichnis_des_speichers_nie_im_projektordner() {
    let root = temp_dir("ort");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");

    ArrangementStore::new(&data)
        .save_project_state(&alpha, &state("t1", 10))
        .unwrap();

    assert!(arrangement_file(&data).starts_with(&data));
    assert_eq!(std::fs::read_dir(&alpha).unwrap().count(), 0);
}

#[test]
fn ein_aus_der_liste_entferntes_projekt_verliert_auch_seine_aufteilung() {
    let root = temp_dir("entfernt");
    let alpha = project(&root, "alpha");
    let store = ArrangementStore::new(root.join("daten"));
    store.remember_project(&alpha).unwrap();
    store.save_project_state(&alpha, &state("t1", 10)).unwrap();

    store.forget_project(&alpha).unwrap();

    assert_eq!(store.project_state(&alpha), ProjectState::default());
}
