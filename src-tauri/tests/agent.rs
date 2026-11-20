//! Tests des Agent-Starts über seine öffentliche Schnittstelle, gegen echte
//! Ordner als Suchpfad.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use kredr_lib::agent::{missing_program, with_status_settings, DEFAULT_START_COMMAND};

/// Ein leerer Ordner, der als Suchpfad dient.
fn search_folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-agent-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("Testordner sollte anlegbar sein");
    dir
}

fn search_path(folders: &[&PathBuf]) -> OsString {
    std::env::join_paths(folders).expect("Suchpfad sollte sich bilden lassen")
}

#[test]
fn standard_startbefehl_ist_claude() {
    assert_eq!(DEFAULT_START_COMMAND, "claude");
}

#[test]
fn fehlendes_programm_wird_beim_namen_genannt() {
    let empty = search_folder("fehlt");

    let missing = missing_program("claude", &search_path(&[&empty]));

    assert_eq!(missing.as_deref(), Some("claude"));
}

#[test]
fn installiertes_programm_wird_im_suchpfad_gefunden() {
    let empty = search_folder("leer");
    // So legt npm Claude Code ab: als Skript ohne `.exe`.
    let npm = search_folder("npm");
    std::fs::write(npm.join("claude.cmd"), "").unwrap();
    // So legt es der eigene Installer von Claude Code ab.
    let native = search_folder("native");
    std::fs::write(native.join("claude.exe"), "").unwrap();

    assert_eq!(
        missing_program("claude", &search_path(&[&empty, &npm])),
        None
    );
    assert_eq!(missing_program("claude", &search_path(&[&native])), None);
}

#[test]
fn zusaetze_im_startbefehl_gehoeren_nicht_zum_programm() {
    let folder = search_folder("zusaetze");
    std::fs::write(folder.join("claude.exe"), "").unwrap();
    let path = search_path(&[&folder]);

    assert_eq!(missing_program("claude --model opus", &path), None);
    assert_eq!(
        missing_program("  anderes-programm --model opus", &path).as_deref(),
        Some("anderes-programm")
    );
}

#[test]
fn ein_ordner_mit_dem_namen_des_programms_zaehlt_nicht() {
    let folder = search_folder("ordner");
    std::fs::create_dir_all(folder.join("claude")).unwrap();

    let missing = missing_program("claude", &search_path(&[&folder]));

    assert_eq!(missing.as_deref(), Some("claude"));
}

#[test]
fn was_kein_schlichter_programmname_ist_entscheidet_die_shell() {
    let empty = search_path(&[&search_folder("shell")]);

    // Pfade, Aufrufe mit `&` und ein leerer Befehl lassen sich nicht im
    // Suchpfad nachschlagen; sie gelten nicht als fehlend.
    assert_eq!(missing_program(r"C:\Werkzeuge\claude.exe", &empty), None);
    assert_eq!(
        missing_program(r#"& "C:\Mit Leerzeichen\claude.exe""#, &empty),
        None
    );
    assert_eq!(missing_program("$env:AGENT", &empty), None);
    assert_eq!(missing_program("   ", &empty), None);
}

#[test]
fn der_startbefehl_bekommt_die_konfiguration_fuer_den_agentenstatus_mit() {
    let settings = Path::new(r"C:\Temp\kredr\terminal-3.json");

    assert_eq!(
        with_status_settings("claude", settings),
        r"claude --settings 'C:\Temp\kredr\terminal-3.json'"
    );
    // Zusätze des Nutzers bleiben erhalten und stehen weiter am Ende.
    assert_eq!(
        with_status_settings("claude --model opus; echo fertig", settings),
        r"claude --settings 'C:\Temp\kredr\terminal-3.json' --model opus; echo fertig"
    );
    assert_eq!(
        with_status_settings(r"  C:\Werkzeuge\Claude.exe -c", settings),
        r"C:\Werkzeuge\Claude.exe --settings 'C:\Temp\kredr\terminal-3.json' -c"
    );
}

#[test]
fn ein_pfad_mit_leerzeichen_und_apostroph_bleibt_ein_argument() {
    let settings = Path::new(r"C:\Users\Max O'Neil\Temp\terminal-3.json");

    assert_eq!(
        with_status_settings("claude", settings),
        r"claude --settings 'C:\Users\Max O''Neil\Temp\terminal-3.json'"
    );
}

#[test]
fn andere_programme_als_claude_code_starten_unveraendert() {
    let settings = Path::new(r"C:\Temp\kredr\terminal-3.json");

    // Der Agentenstatus gilt nur für Claude Code; ein fremdes Programm
    // könnte an der unbekannten Option scheitern.
    for command in [
        "anderer-agent --schnell",
        "claude-wrapper",
        "$env:AGENT",
        r#"& "C:\Mit Leerzeichen\claude.exe""#,
        "",
    ] {
        assert_eq!(with_status_settings(command, settings), command);
    }
}
