//! Tests des Agent-Starts über seine öffentliche Schnittstelle, gegen echte
//! Ordner als Suchpfad.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use kredr_lib::agent::{missing_program, resuming, with_status_settings, DEFAULT_START_COMMAND};
use kredr_lib::terminal::Shell;

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
        with_status_settings("claude", settings, Shell::Powershell),
        r"claude --settings 'C:\Temp\kredr\terminal-3.json'"
    );
    // Zusätze des Nutzers bleiben erhalten und stehen weiter am Ende.
    assert_eq!(
        with_status_settings(
            "claude --model opus; echo fertig",
            settings,
            Shell::Powershell
        ),
        r"claude --settings 'C:\Temp\kredr\terminal-3.json' --model opus; echo fertig"
    );
    assert_eq!(
        with_status_settings(r"  C:\Werkzeuge\Claude.exe -c", settings, Shell::Powershell),
        r"C:\Werkzeuge\Claude.exe --settings 'C:\Temp\kredr\terminal-3.json' -c"
    );
}

#[test]
fn ein_fortgesetzter_agent_bekommt_sein_gespraech_mit() {
    let conversation = "7f455d1c-5cdc-4520-a47e-ef395089b530";

    assert_eq!(
        resuming("claude", conversation).as_deref(),
        Some("claude --resume 7f455d1c-5cdc-4520-a47e-ef395089b530")
    );
    // Zusätze des Nutzers bleiben erhalten, auch mit der Konfiguration davor.
    let command = resuming("claude --model opus", conversation).unwrap();
    assert_eq!(
        with_status_settings(
            &command,
            Path::new(r"C:\Temp\terminal-3.json"),
            Shell::Powershell
        ),
        r"claude --settings 'C:\Temp\terminal-3.json' --resume 7f455d1c-5cdc-4520-a47e-ef395089b530 --model opus"
    );
}

#[test]
fn ohne_claude_oder_mit_fremder_kennung_wird_nichts_fortgesetzt() {
    // Andere Agenten kennen das Fortsetzen (noch) nicht.
    assert_eq!(resuming("codex", "abc123"), None);
    assert_eq!(resuming("& 'C:\\Claude\\claude.exe'", "abc123"), None);
    // Was keine Kennung von Claude Code sein kann, kommt nicht in die Shell.
    assert_eq!(resuming("claude", "abc; rm -rf ~"), None);
    assert_eq!(resuming("claude", "$(boese)"), None);
    assert_eq!(resuming("claude", ""), None);
}

#[test]
fn ein_pfad_mit_leerzeichen_und_apostroph_bleibt_ein_argument() {
    let settings = Path::new(r"C:\Users\Max O'Neil\Temp\terminal-3.json");

    assert_eq!(
        with_status_settings("claude", settings, Shell::Powershell),
        r"claude --settings 'C:\Users\Max O''Neil\Temp\terminal-3.json'"
    );
}

#[test]
fn in_git_bash_ist_der_pfad_nach_den_regeln_der_bash_zitiert() {
    // Backslashes und Leerzeichen bleiben in einfachen Anführungszeichen,
    // wie sie sind.
    assert_eq!(
        with_status_settings(
            "claude --model opus",
            Path::new(r"C:\Users\Max Muster\Temp\terminal-3.json"),
            Shell::GitBash
        ),
        r"claude --settings 'C:\Users\Max Muster\Temp\terminal-3.json' --model opus"
    );
    // Ein verdoppelter Apostroph wie in PowerShell ginge in Bash verloren.
    assert_eq!(
        with_status_settings(
            "claude",
            Path::new(r"C:\Users\Max O'Neil\Temp\terminal-3.json"),
            Shell::GitBash
        ),
        r"claude --settings 'C:\Users\Max O'\''Neil\Temp\terminal-3.json'"
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
        for shell in [Shell::Powershell, Shell::GitBash] {
            assert_eq!(with_status_settings(command, settings, shell), command);
        }
    }
}
