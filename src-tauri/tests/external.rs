//! Tests für das Öffnen außerhalb von Kredr über die öffentliche
//! Schnittstelle, gegen echte Dateien in einem temporären Ordner. Was dabei
//! tatsächlich ein Programm starten würde, wird nicht ausgelöst.

use std::path::{Path, PathBuf};

use kredr_lib::external::{open_file, open_url, resolve_file, runs_when_opened};

fn temp_project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-external-{name}"));
    std::fs::create_dir_all(dir.join("src")).expect("Testordner sollte anlegbar sein");
    std::fs::write(dir.join("src").join("main.rs"), "fn main() {}").unwrap();
    std::fs::write(dir.join("LIES MICH.md"), "# Test").unwrap();
    dir
}

#[test]
fn relativer_pfad_gilt_ab_dem_startordner() {
    let project = temp_project("relativ");

    let expected = Some(project.join("src").join("main.rs"));
    assert_eq!(resolve_file(&project, "src/main.rs"), expected);
    assert_eq!(resolve_file(&project, r"src\main.rs"), expected);
    assert_eq!(resolve_file(&project, "./src/../src/main.rs"), expected);
}

#[test]
fn absoluter_pfad_gilt_unabhaengig_vom_startordner() {
    let project = temp_project("absolut");
    let file = project.join("LIES MICH.md");

    let elsewhere = std::env::temp_dir();
    assert_eq!(resolve_file(&elsewhere, file.to_str().unwrap()), Some(file));
}

#[test]
fn was_keine_vorhandene_datei_ist_wird_nicht_aufgeloest() {
    let project = temp_project("fehlt");

    assert_eq!(resolve_file(&project, "src/fehlt.rs"), None);
    // Ein Ordner ist keine Datei.
    assert_eq!(resolve_file(&project, "src"), None);
    assert_eq!(resolve_file(&project, ""), None);
}

#[test]
fn skripte_und_programme_wuerden_beim_oeffnen_laufen() {
    for name in ["setup.exe", "build.bat", "run.CMD", "index.js", "tool.py"] {
        assert!(runs_when_opened(Path::new(name)), "{name}");
    }
    for name in ["README.md", "main.rs", "App.tsx", "daten.json", "Makefile"] {
        assert!(!runs_when_opened(Path::new(name)), "{name}");
    }
}

#[test]
fn nur_web_adressen_werden_als_link_geoeffnet() {
    assert!(open_url("file:///C:/Windows/System32/calc.exe").is_err());
    assert!(open_url("calc.exe").is_err());
    assert!(open_url("javascript:alert(1)").is_err());
}

#[test]
fn fehlende_datei_laesst_sich_nicht_oeffnen() {
    let project = temp_project("oeffnen");

    assert!(open_file(&project.join("fehlt.txt")).is_err());
    // Ein Ordner ist keine Datei.
    assert!(open_file(&project.join("src")).is_err());
}
