//! Tests der Dateioperationen des Moduls Projektdateien (anlegen, umbenennen,
//! in den Papierkorb verschieben) über seine öffentliche Schnittstelle, gegen
//! echte temporäre Ordner.

use std::fs;

use kredr_lib::project_files::{
    create_file, create_folder, move_to_trash, rename, FileOperationError,
};
use tempfile::TempDir;

fn temp_project() -> TempDir {
    tempfile::Builder::new()
        .prefix("kredr-test-")
        .tempdir()
        .expect("Testordner sollte anlegbar sein")
}

#[test]
fn angelegte_datei_ist_leer_und_liegt_im_gewaehlten_ordner() {
    let project = temp_project();
    let folder = project.path().join("src");
    fs::create_dir(&folder).unwrap();

    create_file(&folder, "neu.ts").expect("Datei sollte anlegbar sein");

    assert_eq!(fs::read(folder.join("neu.ts")).unwrap(), b"");
}

#[test]
fn angelegter_ordner_liegt_im_gewaehlten_ordner() {
    let project = temp_project();

    create_folder(project.path(), "docs").expect("Ordner sollte anlegbar sein");

    assert!(project.path().join("docs").is_dir());
}

#[test]
fn anlegen_unter_vorhandenem_namen_wird_abgelehnt_und_laesst_den_bestand_unberuehrt() {
    let project = temp_project();
    fs::write(project.path().join("README.md"), "wichtig").unwrap();
    fs::create_dir(project.path().join("src")).unwrap();

    // Windows unterscheidet Groß- und Kleinschreibung bei Namen nicht.
    let as_file = create_file(project.path(), "readme.md");
    let as_folder = create_folder(project.path(), "README.md");
    let folder_again = create_folder(project.path(), "src");
    let file_over_folder = create_file(project.path(), "src");

    assert_eq!(as_file, Err(FileOperationError::AlreadyExists));
    assert_eq!(as_folder, Err(FileOperationError::AlreadyExists));
    assert_eq!(folder_again, Err(FileOperationError::AlreadyExists));
    assert_eq!(file_over_folder, Err(FileOperationError::AlreadyExists));
    assert_eq!(
        fs::read_to_string(project.path().join("README.md")).unwrap(),
        "wichtig"
    );
}

#[test]
fn ungueltige_namen_werden_abgelehnt() {
    let project = temp_project();
    let invalid = [
        "",
        "   ",
        ".",
        "..",
        "a/b.txt",
        "a\\b.txt",
        "frage?.txt",
        "stern*.txt",
        "a:b",
        "a<b",
        "a>b",
        "a|b",
        "a\"b",
        "tab\tulator",
        "endet-mit-punkt.",
        "endet-mit-leerzeichen ",
        "CON",
        "nul.txt",
        "com1",
        "LPT9.log",
    ];

    for name in invalid {
        assert_eq!(
            create_file(project.path(), name),
            Err(FileOperationError::InvalidName),
            "Datei {name:?}"
        );
        assert_eq!(
            create_folder(project.path(), name),
            Err(FileOperationError::InvalidName),
            "Ordner {name:?}"
        );
    }
    assert_eq!(fs::read_dir(project.path()).unwrap().count(), 0);
}

#[test]
fn ungewoehnliche_aber_gueltige_namen_werden_angenommen() {
    let project = temp_project();

    for name in [
        ".gitignore",
        "mit leerzeichen.txt",
        "Größe (1).md",
        "console.log",
        "com10",
    ] {
        create_file(project.path(), name).unwrap_or_else(|e| panic!("{name:?}: {e}"));
        assert!(project.path().join(name).is_file(), "{name:?}");
    }
}

#[test]
fn umbenennen_gibt_datei_und_ordner_den_neuen_namen() {
    let project = temp_project();
    fs::write(project.path().join("alt.txt"), "inhalt").unwrap();
    fs::create_dir(project.path().join("ordner")).unwrap();
    fs::write(project.path().join("ordner").join("kind.txt"), "x").unwrap();

    rename(&project.path().join("alt.txt"), "neu.txt").expect("Datei sollte umbenennbar sein");
    rename(&project.path().join("ordner"), "mappe").expect("Ordner sollte umbenennbar sein");

    assert!(!project.path().join("alt.txt").exists());
    assert_eq!(
        fs::read_to_string(project.path().join("neu.txt")).unwrap(),
        "inhalt"
    );
    assert!(!project.path().join("ordner").exists());
    assert!(project.path().join("mappe").join("kind.txt").is_file());
}

#[test]
fn umbenennen_auf_vorhandenen_namen_wird_abgelehnt_und_ueberschreibt_nichts() {
    let project = temp_project();
    fs::write(project.path().join("a.txt"), "a").unwrap();
    fs::write(project.path().join("b.txt"), "b").unwrap();
    fs::create_dir(project.path().join("src")).unwrap();

    let onto_file = rename(&project.path().join("a.txt"), "B.txt");
    let onto_folder = rename(&project.path().join("a.txt"), "src");

    assert_eq!(onto_file, Err(FileOperationError::AlreadyExists));
    assert_eq!(onto_folder, Err(FileOperationError::AlreadyExists));
    assert_eq!(
        fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "a"
    );
    assert_eq!(
        fs::read_to_string(project.path().join("b.txt")).unwrap(),
        "b"
    );
}

#[test]
fn umbenennen_darf_nur_die_gross_und_kleinschreibung_aendern() {
    let project = temp_project();
    fs::write(project.path().join("readme.md"), "x").unwrap();

    rename(&project.path().join("readme.md"), "README.md").expect("sollte gelingen");

    let names: Vec<String> = fs::read_dir(project.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["README.md"]);
}

#[test]
fn umbenennen_auf_den_bisherigen_namen_aendert_nichts() {
    let project = temp_project();
    fs::write(project.path().join("gleich.txt"), "x").unwrap();

    rename(&project.path().join("gleich.txt"), "gleich.txt").expect("sollte gelingen");

    assert!(project.path().join("gleich.txt").is_file());
}

#[test]
fn umbenennen_auf_ungueltigen_namen_wird_abgelehnt() {
    let project = temp_project();
    fs::write(project.path().join("a.txt"), "a").unwrap();

    for name in ["", "..", "unter/ordner.txt", "frage?.txt", "NUL"] {
        assert_eq!(
            rename(&project.path().join("a.txt"), name),
            Err(FileOperationError::InvalidName),
            "{name:?}"
        );
    }
    assert!(project.path().join("a.txt").is_file());
}

#[test]
fn umbenennen_von_etwas_das_es_nicht_mehr_gibt_meldet_das() {
    let project = temp_project();

    let result = rename(&project.path().join("weg.txt"), "neu.txt");

    assert_eq!(result, Err(FileOperationError::NotFound));
}

#[test]
fn papierkorb_nimmt_datei_und_ordner_samt_inhalt_auf() {
    let project = temp_project();
    fs::write(project.path().join("kredr-test-weg.txt"), "x").unwrap();
    let folder = project.path().join("kredr-test-weg");
    fs::create_dir_all(folder.join("tief")).unwrap();
    fs::write(folder.join("tief").join("kind.txt"), "x").unwrap();
    fs::write(project.path().join("bleibt.txt"), "x").unwrap();

    move_to_trash(&project.path().join("kredr-test-weg.txt")).expect("Datei in den Papierkorb");
    move_to_trash(&folder).expect("Ordner in den Papierkorb");

    assert!(!project.path().join("kredr-test-weg.txt").exists());
    assert!(!folder.exists());
    assert!(project.path().join("bleibt.txt").is_file());
}

#[test]
fn papierkorb_meldet_wenn_es_den_eintrag_nicht_mehr_gibt() {
    let project = temp_project();

    let result = move_to_trash(&project.path().join("gibt-es-nicht.txt"));

    assert_eq!(result, Err(FileOperationError::NotFound));
}
