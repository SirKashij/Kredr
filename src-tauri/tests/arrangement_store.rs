//! Tests des Aufteilungsspeichers über seine öffentliche Schnittstelle,
//! gegen echte Dateien in temporären Ordnern.

use std::path::{Path, PathBuf};

use kredr_lib::arrangement_store::ArrangementStore;

/// Ein leerer Ordner unterhalb des temporären Verzeichnisses.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-speicher-{name}"));
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

fn paths(store: &ArrangementStore) -> Vec<PathBuf> {
    store
        .recent_projects()
        .into_iter()
        .map(|project| project.path)
        .collect()
}

#[test]
fn gemerkte_projekte_ueberstehen_einen_neustart() {
    let root = temp_dir("neustart");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");

    let store = ArrangementStore::new(&data);
    store.remember_project(&alpha).unwrap();
    store.remember_project(&beta).unwrap();

    // Ein neuer Speicher über demselben Ordner entspricht einem Neustart von Kredr.
    let reopened = ArrangementStore::new(&data);
    assert_eq!(paths(&reopened), vec![beta, alpha]);
}

#[test]
fn erneut_geoeffnetes_projekt_rueckt_nach_vorn_statt_doppelt_zu_erscheinen() {
    let root = temp_dir("erneut");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let store = ArrangementStore::new(root.join("daten"));
    store.remember_project(&alpha).unwrap();
    store.remember_project(&beta).unwrap();

    // Windows unterscheidet weder Schreibweise noch abschließenden Trenner.
    let other_spelling = format!("{}\\", alpha.to_str().unwrap().to_uppercase());
    store.remember_project(other_spelling.as_ref()).unwrap();

    let projects = store.recent_projects();
    assert_eq!(projects.len(), 2);
    assert!(projects[0].path.ends_with("ALPHA"));
    assert_eq!(projects[1].path, beta);
}

#[test]
fn nicht_mehr_vorhandener_ordner_bleibt_in_der_liste_und_ist_markiert() {
    let root = temp_dir("verschwunden");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let store = ArrangementStore::new(root.join("daten"));
    store.remember_project(&alpha).unwrap();
    store.remember_project(&beta).unwrap();

    std::fs::remove_dir_all(&alpha).unwrap();

    let projects = store.recent_projects();
    assert_eq!(projects.len(), 2);
    assert_eq!((projects[0].path.clone(), projects[0].exists), (beta, true));
    assert_eq!(
        (projects[1].path.clone(), projects[1].exists),
        (alpha, false)
    );
}

#[test]
fn entferntes_projekt_fehlt_auch_nach_einem_neustart() {
    let root = temp_dir("entfernen");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let store = ArrangementStore::new(&data);
    store.remember_project(&alpha).unwrap();
    store.remember_project(&beta).unwrap();

    store.forget_project(&beta).unwrap();

    assert_eq!(paths(&ArrangementStore::new(&data)), vec![alpha.clone()]);
    // Der Ordner selbst bleibt unberührt.
    assert!(beta.is_dir());
}

#[test]
fn beschaedigte_datei_ergibt_eine_leere_liste_und_wird_beim_naechsten_merken_ersetzt() {
    let root = temp_dir("beschaedigt");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let store = ArrangementStore::new(&data);
    store.remember_project(&alpha).unwrap();

    std::fs::write(data.join("projects.json"), "{ \"version\": 1, \"proj").unwrap();

    assert_eq!(paths(&store), Vec::<PathBuf>::new());
    store.remember_project(&alpha).unwrap();
    assert_eq!(paths(&ArrangementStore::new(&data)), vec![alpha]);
}

#[test]
fn datei_einer_unbekannten_version_ergibt_eine_leere_liste() {
    let root = temp_dir("version");
    let data = root.join("daten");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("projects.json"),
        "{ \"version\": 999, \"projects\": [{ \"path\": \"C:\\\\\" }] }",
    )
    .unwrap();

    assert_eq!(paths(&ArrangementStore::new(&data)), Vec::<PathBuf>::new());
}

#[test]
fn der_speicher_schreibt_nur_in_sein_eigenes_verzeichnis() {
    let root = temp_dir("ort");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");

    ArrangementStore::new(&data)
        .remember_project(&alpha)
        .unwrap();

    assert!(data.join("projects.json").is_file());
    assert_eq!(std::fs::read_dir(&alpha).unwrap().count(), 0);
}
