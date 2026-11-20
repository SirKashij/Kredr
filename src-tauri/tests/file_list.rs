//! Tests der Dateiliste des Projekts (Kern-Modul Suche) über ihre öffentliche
//! Schnittstelle, gegen echte temporäre Ordner.

use std::fs;
use std::path::Path;
use std::time::Instant;

use kredr_lib::file_list::list_files;
use tempfile::TempDir;

fn temp_project() -> TempDir {
    tempfile::Builder::new()
        .prefix("kredr-test-")
        .tempdir()
        .expect("Testordner sollte anlegbar sein")
}

/// Legt eine leere Datei samt ihrer Ordner an; `path` ist relativ zum Projekt.
fn create(project: &Path, path: &str) {
    let file = project.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, "").unwrap();
}

#[test]
fn liefert_alle_dateien_relativ_zum_projekt_und_sortiert() {
    let project = temp_project();
    create(project.path(), "src/ui/App.tsx");
    create(project.path(), "src/main.rs");
    create(project.path(), "README.md");
    fs::create_dir(project.path().join("leer")).unwrap();

    let files = list_files(project.path());

    assert_eq!(files, ["README.md", "src/main.rs", "src/ui/App.tsx"]);
}

#[test]
fn ignorierte_dateien_fehlen() {
    let project = temp_project();
    fs::write(project.path().join(".gitignore"), "target/\n*.log\n").unwrap();
    create(project.path(), "target/debug/kredr.exe");
    create(project.path(), "fehler.log");
    create(project.path(), "src/tief/auch.log");
    create(project.path(), "src/main.rs");

    let files = list_files(project.path());

    assert_eq!(files, [".gitignore", "src/main.rs"]);
}

#[test]
fn ignorier_regeln_eines_unterordners_gelten_dort() {
    let project = temp_project();
    create(project.path(), "web/dist/bundle.js");
    create(project.path(), "web/index.ts");
    create(project.path(), "dist/bleibt.txt");
    fs::write(project.path().join("web/.gitignore"), "dist/\n").unwrap();

    let files = list_files(project.path());

    assert_eq!(files, ["dist/bleibt.txt", "web/.gitignore", "web/index.ts"]);
}

#[test]
fn versteckte_dateien_gehoeren_dazu_der_git_ordner_nicht() {
    let project = temp_project();
    create(project.path(), ".git/HEAD");
    create(project.path(), ".git/objects/ab/cdef");
    create(project.path(), ".github/workflows/pruefen.yml");
    create(project.path(), ".env");

    let files = list_files(project.path());

    assert_eq!(files, [".env", ".github/workflows/pruefen.yml"]);
}

#[test]
fn sonderzeichen_und_leerzeichen_in_namen_bleiben_erhalten() {
    let project = temp_project();
    create(project.path(), "Größe & Maße/Über uns (neu).md");
    create(project.path(), "日本語/ファイル.txt");

    let files = list_files(project.path());

    assert_eq!(
        files,
        ["Größe & Maße/Über uns (neu).md", "日本語/ファイル.txt"]
    );
}

#[test]
fn ein_fehlender_ordner_ergibt_eine_leere_liste() {
    let project = temp_project();

    let files = list_files(&project.path().join("gibt-es-nicht"));

    assert!(files.is_empty());
}

/// Messlauf zum Akzeptanzkriterium „zehntausende Dateien ohne spürbare
/// Verzögerung“: 30 000 Dateien in 600 Ordnern, dazu 10 000 ignorierte.
/// Die Schranke ist bewusst weit gefasst, damit ein langsamer Prüfrechner
/// nicht scheitert; die gemessene Zeit steht in der Ausgabe. Das Anlegen der
/// Dateien dauert rund eine halbe Minute, deshalb läuft der Messlauf nur auf
/// Wunsch: `cargo test --test file_list -- --ignored --nocapture`.
#[test]
#[ignore = "Messlauf, legt 40 000 Dateien an"]
fn zehntausende_dateien_sind_schnell_aufgelistet() {
    let project = temp_project();
    fs::write(project.path().join(".gitignore"), "node_modules/\n").unwrap();
    for folder in 0..600 {
        let path = project
            .path()
            .join(format!("pakete/bereich-{}/modul-{folder}", folder % 20));
        fs::create_dir_all(&path).unwrap();
        for file in 0..50 {
            fs::write(path.join(format!("datei-{file}.ts")), "").unwrap();
        }
    }
    for folder in 0..100 {
        let path = project.path().join(format!("node_modules/paket-{folder}"));
        fs::create_dir_all(&path).unwrap();
        for file in 0..100 {
            fs::write(path.join(format!("index-{file}.js")), "").unwrap();
        }
    }

    let started = Instant::now();
    let files = list_files(project.path());
    let elapsed = started.elapsed();

    println!("Dateiliste: {} Dateien in {elapsed:?}", files.len());
    assert_eq!(files.len(), 30_001);
    assert!(
        elapsed.as_secs() < 5,
        "Auflisten dauerte {elapsed:?}; erwartet deutlich unter einer Sekunde"
    );
}
