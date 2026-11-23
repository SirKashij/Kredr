//! Der Start einer Git Bash mit Startbefehl: Die Funktion `claude` gilt nach
//! der echten `~/.bashrc`, und die Startdatei bleibt nicht liegen.
//!
//! Eigene Testdatei, weil ein Test `HOME` für den ganzen Prozess umsetzt und
//! ein anderer alle Startdateien dieses Prozesses zählt; Cargo startet jede
//! Testdatei als eigenen Prozess. Die Tests hier laufen nacheinander.

use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kredr_lib::agent::shell_start_command;
use kredr_lib::agent_status::TerminalHooks;
use kredr_lib::terminal::{available_shells, Shell, Terminal, TerminalEvent, TerminalOptions};

/// Hält die Tests dieser Datei nacheinander.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn git_bash_found() -> bool {
    let found = available_shells().contains(&Shell::GitBash);
    if !found {
        eprintln!("Git Bash wurde nicht gefunden; Test übersprungen");
    }
    found
}

/// Die Startdateien von Git Bash, die dieser Prozess noch im temporären
/// Verzeichnis hat.
fn start_files_left() -> Vec<PathBuf> {
    let prefix = format!("kredr-bash-{}-", std::process::id());
    std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect()
}

#[test]
fn ein_sofort_geschlossenes_terminal_hinterlaesst_keine_startdatei() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    if !git_bash_found() {
        return;
    }
    let options = TerminalOptions {
        shell: Shell::GitBash,
        cwd: std::env::temp_dir(),
        cols: 80,
        rows: 24,
        start_command: Some("echo gestartet".to_owned()),
    };

    // Geschlossen, bevor Bash ihre Startdatei lesen und löschen konnte.
    let terminal = Terminal::open(options, |_| {}).expect("Git Bash sollte starten");
    drop(terminal);

    assert_eq!(start_files_left(), Vec::<PathBuf>::new());
}

#[test]
fn claude_aus_der_echten_bashrc_wird_uebergangen() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    if !git_bash_found() {
        return;
    }
    let folder = std::env::temp_dir().join("kredr-test-bash-profil");
    let home = folder.join("home");
    let programs = folder.join("programme");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&programs).unwrap();
    // Ein Test-Ersatz für `claude`, der jedes Argument in Klammern ausgibt.
    std::fs::write(
        programs.join("claude"),
        "#!/bin/sh\nprintf 'claude-args:'\nprintf ' [%s]' \"$@\"\necho\n",
    )
    .unwrap();
    // Wie bei Git für Windows lädt `.bash_profile` die `.bashrc`.
    std::fs::write(home.join(".bash_profile"), ". ~/.bashrc\n").unwrap();
    std::fs::write(
        home.join(".bashrc"),
        format!(
            "export PATH=\"$(cygpath -u '{}'):$PATH\"\n\
             export AUS_DER_BASHRC=geladen\n\
             alias claude='echo vom-alias'\n",
            programs.display()
        ),
    )
    .unwrap();
    std::env::set_var("HOME", &home);

    let settings = folder.join("terminal-1.json");
    let hooks = TerminalHooks {
        settings: settings.clone(),
        // Ohne Empfänger: Die Meldung der Rückkehr geht ins Leere.
        exited_url: "http://127.0.0.1:9/hook/1/kennwort/exited".to_owned(),
    };
    let start = shell_start_command(Shell::GitBash, Some(&hooks), None);
    let output = run_in_git_bash(
        folder,
        start,
        "echo \"bashrc=$AUS_DER_BASHRC\"; claude --model x",
        "claude-args:",
    );

    assert!(output.contains("bashrc=geladen"), "{output}");
    assert!(!output.contains("vom-alias"), "{output}");
    let expected = format!(
        "claude-args: [--settings] [{}] [--model] [x]",
        settings.display()
    );
    assert!(output.contains(&expected), "{output}");
}

/// Öffnet eine Git Bash mit `start_command`, tippt `line` und liefert die
/// Ausgabe bis einschließlich der Zeile, die `until` enthält.
fn run_in_git_bash(cwd: PathBuf, start_command: Option<String>, line: &str, until: &str) -> String {
    let (sender, events) = channel();
    let options = TerminalOptions {
        shell: Shell::GitBash,
        cwd,
        cols: 200,
        rows: 30,
        start_command,
    };
    let terminal = Terminal::open(options, move |event| {
        let _ = sender.send(event);
    })
    .expect("Git Bash sollte starten");
    terminal.write(format!("{line}\r").as_bytes()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut output = String::new();
    loop {
        let done = output
            .find(until)
            .is_some_and(|start| output[start..].contains('\n'));
        if done {
            return output;
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or_else(|| panic!("{until:?} kam nie. Bisherige Ausgabe:\n{output}"));
        if let Ok(TerminalEvent::Output(bytes)) = events.recv_timeout(remaining) {
            let text = String::from_utf8_lossy(&bytes);
            // ConPTY wartet beim Start auf die Antwort auf seine Cursorabfrage.
            if text.contains("\x1b[6n") {
                terminal.write(b"\x1b[1;1R").unwrap();
            }
            output.push_str(&text);
        }
    }
}
