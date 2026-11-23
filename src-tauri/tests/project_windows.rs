//! Tests der Zuordnung von Fenstern zu ihrem Fensterinhalt über ihre
//! öffentliche Schnittstelle, gegen echte Ordner im temporären Verzeichnis.

use std::path::{Path, PathBuf};

use kredr_lib::project_windows::{project_from_args, ProjectWindows, WindowContent};

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

/// Ein Fenster, das ein einzelnes Projekt zeigt.
fn single(folder: &Path) -> WindowContent {
    WindowContent::Project {
        path: folder.to_path_buf(),
    }
}

/// Ein Fenster, das einen Workspace mit diesen Projekten zeigt.
fn workspace(projects: &[&Path]) -> WindowContent {
    WindowContent::Workspace {
        id: "workspace-1".to_string(),
        name: "Unbenannt".to_string(),
        projects: projects.iter().map(|folder| folder.to_path_buf()).collect(),
    }
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
fn mit_kredr_oeffnen_im_laufwerksstamm_oeffnet_das_laufwerk() {
    let cwd = temp_dir("laufwerk");
    let drive = cwd.to_str().unwrap()[..2].to_owned();
    // Der Explorer ruft `"kredr.exe" "C:\"` auf. Windows liest den Backslash
    // vor dem Anführungszeichen als dessen Maskierung: Es kommt `C:"` an.
    let argument = format!("{drive}\"");

    assert_eq!(
        project_from_args(&args(&["kredr.exe", &argument]), &cwd),
        Some(PathBuf::from(format!("{drive}\\")))
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
    windows.assign("main", single(&project));

    let other_spelling = format!("{}\\", project.to_str().unwrap().to_uppercase());

    assert_eq!(
        windows.window_of(other_spelling.as_ref()),
        Some("main".to_string())
    );
    assert_eq!(windows.content_of("main"), single(&project));
}

#[test]
fn ein_projekt_in_einem_workspace_gilt_als_offen() {
    let first = temp_dir("workspace-erstes");
    let second = temp_dir("workspace-zweites");
    let elsewhere = temp_dir("workspace-anderswo");
    let windows = ProjectWindows::default();
    windows.assign("window-1", workspace(&[&first, &second]));

    let other_spelling = second.to_str().unwrap().to_uppercase();

    assert_eq!(
        windows.window_of(other_spelling.as_ref()),
        Some("window-1".to_string())
    );
    assert_eq!(windows.window_of(&first), Some("window-1".to_string()));
    assert_eq!(windows.window_of(&elsewhere), None);
    assert_eq!(
        windows.content_of("window-1").projects(),
        [first.clone(), second.clone()]
    );
}

#[test]
fn ein_projekt_das_anderswo_offen_ist_kommt_nicht_in_einen_zweiten_workspace() {
    let first = temp_dir("anderswo-erstes");
    let second = temp_dir("anderswo-zweites");
    let windows = ProjectWindows::default();
    windows.assign("main", single(&first));
    windows.assign("window-1", single(&second));

    let other_spelling = PathBuf::from(second.to_str().unwrap().to_uppercase());
    let refused = windows.claim("main", workspace(&[&first, &other_spelling]));

    assert_eq!(refused, Err("window-1".to_string()));
    // Das Fenster zeigt weiter, was es zeigte.
    assert_eq!(windows.content_of("main"), single(&first));
}

#[test]
fn ein_workspace_oeffnet_nicht_wenn_eines_seiner_projekte_anderswo_offen_ist() {
    let first = temp_dir("oeffnen-erstes");
    let second = temp_dir("oeffnen-zweites");
    let windows = ProjectWindows::default();
    windows.assign("main", WindowContent::StartPage);
    windows.assign("window-1", workspace(&[&second]));

    let refused = windows.claim("main", workspace(&[&first, &second]));

    assert_eq!(refused, Err("window-1".to_string()));
    // Das Fenster bleibt auf der Startseite, und das erste Projekt ist nicht offen.
    assert_eq!(windows.start_page_window(), Some("main".to_string()));
    assert_eq!(windows.window_of(&first), None);
}

#[test]
fn ein_workspace_oeffnet_auf_der_startseite_wenn_seine_projekte_frei_sind() {
    let first = temp_dir("frei-erstes");
    let second = temp_dir("frei-zweites");
    let windows = ProjectWindows::default();
    windows.assign("main", WindowContent::StartPage);
    windows.assign("window-1", single(&temp_dir("frei-anderes")));

    assert_eq!(windows.claim("main", workspace(&[&first, &second])), Ok(()));
    assert_eq!(windows.window_of(&second), Some("main".to_string()));
    assert_eq!(windows.start_page_window(), None);
}

#[test]
fn ein_fenster_darf_seine_eigenen_projekte_in_einen_workspace_nehmen() {
    let first = temp_dir("eigen-erstes");
    let second = temp_dir("eigen-zweites");
    let windows = ProjectWindows::default();
    windows.assign("main", single(&first));
    windows.assign("window-1", single(&temp_dir("eigen-anderes")));

    assert_eq!(windows.claim("main", workspace(&[&first, &second])), Ok(()));
    assert_eq!(windows.window_of(&second), Some("main".to_string()));

    // Nach dem Schließen seines Fensters ist ein Projekt wieder frei.
    windows.release("main");
    assert_eq!(windows.claim("window-1", workspace(&[&second])), Ok(()));
}

#[test]
fn ein_workspace_ohne_projekte_ist_keine_startseite() {
    let windows = ProjectWindows::default();
    windows.assign("window-1", workspace(&[]));

    assert_eq!(windows.start_page_window(), None);
    assert!(windows.content_of("window-1").projects().is_empty());
}

#[test]
fn nach_dem_schliessen_des_fensters_ist_das_projekt_nicht_mehr_offen() {
    let project = temp_dir("geschlossen");
    let windows = ProjectWindows::default();
    windows.assign("main", single(&project));

    windows.release("main");

    assert_eq!(windows.window_of(&project), None);
    assert_eq!(windows.content_of("main"), WindowContent::StartPage);
}

#[test]
fn ein_fenster_ohne_projekt_zeigt_die_startseite_bis_es_ein_projekt_bekommt() {
    let project = temp_dir("startseite");
    let windows = ProjectWindows::default();
    windows.assign("main", single(&temp_dir("startseite-anderes")));
    assert_eq!(windows.start_page_window(), None);

    windows.assign("window-1", WindowContent::StartPage);
    assert_eq!(windows.start_page_window(), Some("window-1".to_string()));

    windows.assign("window-1", single(&project));
    assert_eq!(windows.start_page_window(), None);
    assert_eq!(windows.window_of(&project), Some("window-1".to_string()));
}

#[test]
fn die_oberflaeche_erhaelt_den_fensterinhalt_mit_seiner_art() {
    let folder = PathBuf::from("C:\\Projekte\\Kredr");

    assert_eq!(
        serde_json::to_value(WindowContent::StartPage).unwrap(),
        serde_json::json!({ "kind": "startPage" })
    );
    assert_eq!(
        serde_json::to_value(single(&folder)).unwrap(),
        serde_json::json!({ "kind": "project", "path": "C:\\Projekte\\Kredr" })
    );
    assert_eq!(
        serde_json::to_value(workspace(&[&folder])).unwrap(),
        serde_json::json!({
            "kind": "workspace",
            "id": "workspace-1",
            "name": "Unbenannt",
            "projects": ["C:\\Projekte\\Kredr"],
        })
    );
}

#[test]
fn jedes_neue_fenster_bekommt_eine_eigene_kennung() {
    let windows = ProjectWindows::default();

    assert_ne!(windows.next_label(), windows.next_label());
}
