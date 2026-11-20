//! Tests der Zuordnung von Projekten zu Fenstern über ihre öffentliche
//! Schnittstelle, gegen echte Ordner im temporären Verzeichnis.

use std::path::PathBuf;

use kredr_lib::project_windows::{project_from_args, ProjectWindows};

/// Ein leerer Ordner unterhalb des temporären Verzeichnisses.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-fenster-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("Testordner sollte anlegbar sein");
    dir
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn kredr_punkt_meint_den_ordner_in_dem_der_befehl_lief() {
    let cwd = temp_dir("punkt");

    assert_eq!(
        project_from_args(&args(&["kredr.exe", "."]), &cwd),
        Some(cwd)
    );
}

#[test]
fn ein_relativer_pfad_gilt_ab_dem_ordner_in_dem_der_befehl_lief() {
    let cwd = temp_dir("relativ");
    let project = cwd.join("mein projekt");
    std::fs::create_dir_all(&project).unwrap();

    assert_eq!(
        project_from_args(&args(&["kredr.exe", "mein projekt"]), &cwd),
        Some(project)
    );
}

#[test]
fn ein_vollstaendiger_pfad_gilt_unabhaengig_vom_ordner_des_befehls() {
    let cwd = temp_dir("voll-cwd");
    let project = temp_dir("voll-projekt");

    assert_eq!(
        project_from_args(&args(&["kredr.exe", project.to_str().unwrap()]), &cwd),
        Some(project)
    );
}

#[test]
fn ohne_ordner_gibt_es_kein_projekt() {
    let cwd = temp_dir("ohne");
    std::fs::write(cwd.join("datei.txt"), "kein Ordner").unwrap();

    assert_eq!(project_from_args(&args(&["kredr.exe"]), &cwd), None);
    assert_eq!(
        project_from_args(&args(&["kredr.exe", "gibt-es-nicht"]), &cwd),
        None
    );
    assert_eq!(
        project_from_args(&args(&["kredr.exe", "datei.txt"]), &cwd),
        None
    );
}

#[test]
fn ein_offenes_projekt_findet_sein_fenster_auch_in_anderer_schreibweise() {
    let project = temp_dir("offen");
    let windows = ProjectWindows::default();
    windows.assign("main", Some(project.clone()));

    let other_spelling = format!("{}\\", project.to_str().unwrap().to_uppercase());

    assert_eq!(
        windows.window_of(other_spelling.as_ref()),
        Some("main".to_string())
    );
    assert_eq!(windows.project_of("main"), Some(project));
}

#[test]
fn nach_dem_schliessen_des_fensters_ist_das_projekt_nicht_mehr_offen() {
    let project = temp_dir("geschlossen");
    let windows = ProjectWindows::default();
    windows.assign("main", Some(project.clone()));

    windows.release("main");

    assert_eq!(windows.window_of(&project), None);
    assert_eq!(windows.project_of("main"), None);
}

#[test]
fn ein_fenster_ohne_projekt_zeigt_die_startseite_bis_es_ein_projekt_bekommt() {
    let project = temp_dir("startseite");
    let windows = ProjectWindows::default();
    windows.assign("main", Some(temp_dir("startseite-anderes")));
    assert_eq!(windows.start_page_window(), None);

    windows.assign("window-1", None);
    assert_eq!(windows.start_page_window(), Some("window-1".to_string()));

    windows.assign("window-1", Some(project.clone()));
    assert_eq!(windows.start_page_window(), None);
    assert_eq!(windows.window_of(&project), Some("window-1".to_string()));
}

#[test]
fn jedes_neue_fenster_bekommt_eine_eigene_kennung() {
    let windows = ProjectWindows::default();

    assert_ne!(windows.next_label(), windows.next_label());
}
