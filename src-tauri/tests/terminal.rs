//! Tests des Terminal-Dienstes über seine öffentliche Schnittstelle,
//! gegen eine echte PowerShell.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::agent::shell_start_command;
use kredr_lib::agent_status::TerminalHooks;
use kredr_lib::terminal::{
    available_shells, startable_shell, Shell, Terminal, TerminalEvent, TerminalOptions,
};

const TIMEOUT: Duration = Duration::from_secs(30);

/// Damit beginnt jede Ausgabe des Test-Ersatzes für `claude`.
const FAKE_CLAUDE_MARK: &str = "claude-args: ";

struct TestTerminal {
    terminal: Terminal,
    events: Receiver<TerminalEvent>,
    output: String,
}

impl TestTerminal {
    fn open(cwd: PathBuf) -> TestTerminal {
        TestTerminal::open_with(cwd, Shell::Powershell, None)
    }

    fn open_with(cwd: PathBuf, shell: Shell, start_command: Option<&str>) -> TestTerminal {
        let (sender, events) = channel();
        let options = TerminalOptions {
            shell,
            cwd,
            cols: 200,
            rows: 30,
            start_command: start_command.map(str::to_owned),
        };
        let terminal = Terminal::open(options, move |event| {
            let _ = sender.send(event);
        })
        .expect("Die Shell sollte starten");
        TestTerminal {
            terminal,
            events,
            output: String::new(),
        }
    }

    fn send_line(&self, line: &str) {
        self.terminal
            .write(format!("{line}\r").as_bytes())
            .expect("Eingabe sollte ankommen");
    }

    /// Liest Ereignisse, bis die gesamte bisherige Ausgabe `needle` enthält.
    fn wait_for_output(&mut self, needle: &str) {
        let deadline = Instant::now() + TIMEOUT;
        while !self.output.contains(needle) {
            match self.next_event(deadline) {
                Some(TerminalEvent::Output(bytes)) => self.receive(&bytes),
                Some(TerminalEvent::Exited) => {}
                None => panic!(
                    "Ausgabe enthielt nie {needle:?}. Bisherige Ausgabe:\n{}",
                    self.output
                ),
            }
        }
    }

    /// Spielt die Rolle des Terminals: ConPTY fragt beim Start die
    /// Cursorposition ab und wartet auf die Antwort, die sonst xterm.js gibt.
    fn receive(&mut self, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes);
        if text.contains("\x1b[6n") {
            self.terminal
                .write(b"\x1b[1;1R")
                .expect("Antwort auf die Cursorabfrage sollte ankommen");
        }
        self.output.push_str(&text);
    }

    /// Die Argumente, mit denen der Test-Ersatz für `claude` (siehe
    /// `fake_claude`) zuletzt aufgerufen wurde, sobald er sie ausgegeben hat.
    fn claude_args(&mut self) -> String {
        let mut calls = self.wait_for_claude_calls(1);
        calls.pop().expect("Mindestens ein Aufruf")
    }

    /// Die Argumente der nächsten `count` Aufrufe des Test-Ersatzes für
    /// `claude`, in ihrer Reihenfolge. Bereits gelesene Ausgabe zählt nicht mit.
    fn next_claude_calls(&mut self, count: usize) -> Vec<String> {
        self.output.clear();
        self.wait_for_claude_calls(count)
    }

    /// Liest Ereignisse, bis die bisherige Ausgabe mindestens `count`
    /// vollständige Aufrufe des Test-Ersatzes enthält, und liefert alle.
    fn wait_for_claude_calls(&mut self, count: usize) -> Vec<String> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let calls: Vec<String> = self
                .output
                .match_indices(FAKE_CLAUDE_MARK)
                .filter_map(|(start, _)| {
                    let rest = &self.output[start + FAKE_CLAUDE_MARK.len()..];
                    rest.find(['\r', '\n'])
                        .map(|end| rest[..end].trim_end().to_owned())
                })
                .collect();
            if calls.len() >= count {
                return calls;
            }
            match self.next_event(deadline) {
                Some(TerminalEvent::Output(bytes)) => self.receive(&bytes),
                Some(TerminalEvent::Exited) => {}
                None => panic!(
                    "claude wurde keine {count} Mal aufgerufen. Bisherige Ausgabe:\n{}",
                    self.output
                ),
            }
        }
    }

    fn wait_for_exit(&mut self) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            match self.next_event(deadline) {
                Some(TerminalEvent::Exited) => return,
                Some(TerminalEvent::Output(bytes)) => self.receive(&bytes),
                None => panic!("Das Prozessende wurde nie gemeldet"),
            }
        }
    }

    /// Wartet, bis `condition` gilt, und nimmt währenddessen Ausgabe entgegen.
    fn wait_until(&mut self, expectation: &str, condition: impl Fn(&Terminal) -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        while !condition(&self.terminal) {
            assert!(Instant::now() < deadline, "{expectation}");
            let poll = Instant::now() + Duration::from_millis(100);
            if let Some(TerminalEvent::Output(bytes)) = self.next_event(poll) {
                self.receive(&bytes);
            }
        }
    }

    fn next_event(&self, deadline: Instant) -> Option<TerminalEvent> {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        self.events.recv_timeout(remaining).ok()
    }
}

fn temp_project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-{name}"));
    std::fs::create_dir_all(&dir).expect("Testordner sollte anlegbar sein");
    dir
}

#[test]
fn gesendeter_befehl_liefert_seine_ausgabe() {
    let mut terminal = TestTerminal::open(temp_project("befehl"));

    terminal.send_line("echo \"kredr-$(6*7)\"");

    terminal.wait_for_output("kredr-42");
}

#[test]
fn shell_startet_im_startordner() {
    let project = temp_project("startordner");
    let folder_name = project.file_name().unwrap().to_str().unwrap().to_owned();

    let mut terminal = TestTerminal::open(project);
    terminal.send_line("echo \"ort=$((Get-Location).Path)|\"");

    terminal.wait_for_output(&format!("{folder_name}|"));
}

#[test]
fn startbefehl_laeuft_sofort_und_die_shell_bleibt_danach_offen() {
    let project = temp_project("startbefehl");
    let start_command = "echo \"agent-$(6*7) mit 'Zusatz'\"";

    let mut terminal = TestTerminal::open_with(project, Shell::Powershell, Some(start_command));

    // Ohne jede Eingabe: Der Startbefehl ist schon gelaufen.
    terminal.wait_for_output("agent-42 mit 'Zusatz'");

    // Nach dem Ende des Startbefehls nimmt die Shell weiter Eingaben an.
    terminal.send_line("echo \"danach-$(6*7)\"");
    terminal.wait_for_output("danach-42");
}

#[test]
fn groessenaenderung_kommt_in_der_shell_an() {
    let mut terminal = TestTerminal::open(temp_project("groesse"));

    terminal
        .terminal
        .resize(132, 40)
        .expect("Größe sollte änderbar sein");
    terminal.send_line("echo \"breite=$($Host.UI.RawUI.WindowSize.Width)\"");

    terminal.wait_for_output("breite=132");
}

#[test]
fn laufender_kindprozess_wird_erkannt() {
    let mut terminal = TestTerminal::open(temp_project("kindprozess"));
    terminal.send_line("echo \"bereit-$(6*7)\"");
    terminal.wait_for_output("bereit-42");

    // Eine Shell, die nur auf Eingabe wartet, hat keinen Kindprozess.
    assert!(!terminal.terminal.has_child_process());

    terminal.send_line("ping -n 4 127.0.0.1");
    terminal.wait_until("ping sollte als Kindprozess laufen", |terminal| {
        terminal.has_child_process()
    });

    // Nach wenigen Sekunden endet ping von selbst; danach wartet die Shell wieder.
    terminal.wait_until("ping sollte beendet sein", |terminal| {
        !terminal.has_child_process()
    });
}

#[test]
fn beendete_shell_hat_keinen_kindprozess() {
    let mut terminal = TestTerminal::open(temp_project("beendet"));

    terminal.send_line("exit");
    terminal.wait_for_exit();

    assert!(!terminal.terminal.has_child_process());
}

#[test]
fn prozessende_wird_nach_der_letzten_ausgabe_gemeldet() {
    let mut terminal = TestTerminal::open(temp_project("ende"));

    terminal.send_line("echo \"letzte-$(6*7)\"; exit");

    terminal.wait_for_exit();

    // Was die Shell vor ihrem Ende ausgegeben hat, ist dann schon angekommen.
    assert!(terminal.output.contains("letzte-42"));
}

#[test]
fn powershell_wird_immer_angeboten() {
    assert_eq!(available_shells().first(), Some(&Shell::Powershell));
}

#[test]
fn fehlt_die_gewuenschte_shell_startet_das_terminal_mit_powershell() {
    // Git für Windows wurde deinstalliert, die Einstellung nennt noch Git Bash.
    assert_eq!(
        startable_shell(Shell::GitBash, &[Shell::Powershell]),
        Shell::Powershell
    );
    assert_eq!(
        startable_shell(Shell::GitBash, &[Shell::Powershell, Shell::GitBash]),
        Shell::GitBash
    );
    assert_eq!(
        startable_shell(Shell::Powershell, &[Shell::Powershell]),
        Shell::Powershell
    );
}

/// Git Bash gehört zu Git für Windows; ohne es gibt es hier nichts zu prüfen.
fn git_bash_found() -> bool {
    let found = available_shells().contains(&Shell::GitBash);
    if !found {
        eprintln!("Git Bash wurde nicht gefunden; Test übersprungen");
    }
    found
}

#[test]
fn git_bash_fuehrt_bash_befehle_aus() {
    if !git_bash_found() {
        return;
    }
    let mut terminal = TestTerminal::open_with(temp_project("git-bash"), Shell::GitBash, None);

    // Diese Ersetzung kennt nur Bash; PowerShell meldet daran einen Fehler.
    terminal.send_line("echo \"kredr-$((6*7))-${BASH_VERSION:+bash}\"");

    terminal.wait_for_output("kredr-42-bash");
}

#[test]
fn git_bash_startet_im_startordner() {
    if !git_bash_found() {
        return;
    }
    let project = temp_project("git-bash-startordner");
    let folder_name = project.file_name().unwrap().to_str().unwrap().to_owned();

    let mut terminal = TestTerminal::open_with(project, Shell::GitBash, None);
    terminal.send_line("echo \"ort=$(pwd)|\"");

    terminal.wait_for_output(&format!("{folder_name}|"));
}

#[test]
fn startbefehl_laeuft_auch_in_git_bash_und_die_shell_bleibt_offen() {
    if !git_bash_found() {
        return;
    }
    let project = temp_project("git-bash-startbefehl");
    let start_command = "echo \"agent-$((6*7)) mit 'Zusatz'\"";

    let mut terminal = TestTerminal::open_with(project, Shell::GitBash, Some(start_command));

    // Ohne jede Eingabe: Der Startbefehl ist schon gelaufen.
    terminal.wait_for_output("agent-42 mit 'Zusatz'");

    // Nach dem Ende des Startbefehls nimmt die Shell weiter Eingaben an.
    terminal.send_line("echo \"danach-$((6*7))-${BASH_VERSION:+bash}\"");
    terminal.wait_for_output("danach-42-bash");
}

/// Ein Ordner mit einem Test-Ersatz für das installierte Programm `claude`,
/// der nur seine Argumente ausgibt. Geliefert wird die PowerShell-Zeile, die
/// den Ordner vor alle anderen im Suchpfad stellt.
fn fake_claude(name: &str) -> String {
    fake_claude_running(name, &format!("echo {FAKE_CLAUDE_MARK}%*"))
}

/// Wie `fake_claude`, der Test-Ersatz führt aber `script` aus (Batch-Befehle).
fn fake_claude_running(name: &str, script: &str) -> String {
    let folder = temp_project(&format!("claude-{name}"));
    std::fs::write(
        folder.join("claude.cmd"),
        format!("@echo off\r\n{script}\r\n"),
    )
    .expect("Test-Ersatz sollte anlegbar sein");
    format!("$env:Path = '{};' + $env:Path", folder.display())
}

/// Die Konfigurationsdatei eines Terminals, mit Leerzeichen und Apostroph im Pfad.
fn terminal_settings() -> PathBuf {
    std::env::temp_dir()
        .join("kredr test's")
        .join("terminal-7.json")
}

/// Öffnet eine PowerShell, wie Kredr sie startet. `profile` läuft vorher,
/// so wie das Profil der Person.
fn open_powershell(name: &str, profile: &str, agent_command: Option<&str>) -> TestTerminal {
    // Ohne Empfänger: Die Meldung der Rückkehr von `claude` geht ins Leere.
    let hooks = TerminalHooks {
        settings: terminal_settings(),
        exited_url: "http://127.0.0.1:9/hook/7/kennwort/exited".to_owned(),
    };
    let start = shell_start_command(Shell::Powershell, Some(&hooks), agent_command)
        .expect("Mit Konfigurationsdatei sollte es einen Startbefehl geben");
    let start = format!("{profile}; {start}");
    TestTerminal::open_with(temp_project(name), Shell::Powershell, Some(&start))
}

#[test]
fn claude_im_terminal_bekommt_die_konfigurationsdatei_des_terminals() {
    let path = fake_claude("argumente");
    let mut terminal = open_powershell("claude-argumente", &path, None);

    terminal.send_line("claude --model x \"zwei Worte\"");

    let settings = terminal_settings().display().to_string();
    assert_eq!(
        terminal.claude_args(),
        format!("--settings \"{settings}\" --model x \"zwei Worte\"")
    );
}

#[test]
fn nur_aufrufe_mit_sitzung_bekommen_die_konfigurationsdatei() {
    let path = fake_claude("ohne-sitzung");
    let mut terminal = open_powershell("claude-ohne-sitzung", &path, None);
    let settings = format!("--settings \"{}\"", terminal_settings().display());
    let cases = [
        ("-p \"x\"", "-p x".to_owned()),
        ("--print x", "--print x".to_owned()),
        ("--version", "--version".to_owned()),
        ("-v", "-v".to_owned()),
        ("--help", "--help".to_owned()),
        ("-h", "-h".to_owned()),
        ("mcp list", "mcp list".to_owned()),
        ("--model x -p y", "--model x -p y".to_owned()),
        ("", settings.clone()),
        ("--model x", format!("{settings} --model x")),
        ("-c", format!("{settings} -c")),
        ("\"zwei Worte\"", format!("{settings} \"zwei Worte\"")),
    ];

    let line = cases
        .iter()
        .map(|(args, _)| format!("claude {args}"))
        .collect::<Vec<_>>()
        .join("; ");
    terminal.send_line(&line);

    let calls = terminal.next_claude_calls(cases.len());
    let expected: Vec<String> = cases.into_iter().map(|(_, passed)| passed).collect();
    assert_eq!(calls, expected);
}

/// Prüft, dass `claude` trotz `definition` aus dem Profil beim installierten
/// Programm ankommt.
fn assert_profile_overridden(name: &str, definition: &str) {
    let profile = format!("{}; {definition}", fake_claude(name));
    let mut terminal = open_powershell(&format!("claude-{name}"), &profile, None);

    terminal.send_line("claude --model x");

    let args = terminal.claude_args();
    assert!(args.starts_with("--settings"), "{args}");
    assert!(args.ends_with("--model x"), "{args}");
}

#[test]
fn alias_claude_aus_dem_profil_wird_uebergangen() {
    assert_profile_overridden("alias", "Set-Alias claude Get-Date");
}

#[test]
fn funktion_claude_aus_dem_profil_wird_uebergangen() {
    assert_profile_overridden("funktion", "function claude { 'aus dem Profil' }");
}

#[test]
fn eingabe_aus_der_pipeline_kommt_bei_claude_an() {
    let path = fake_claude_running(
        "pipeline",
        &format!("set /p line=\r\necho {FAKE_CLAUDE_MARK}%* mit %line%"),
    );
    let mut terminal = open_powershell("claude-pipeline", &path, None);

    terminal.send_line("'zeile-' + 6*7 | claude -p x");

    let args = terminal.claude_args();
    assert!(args.ends_with("-p x mit zeile-42"), "{args}");
}

#[test]
fn agent_von_kredr_startet_ueber_die_funktion_mit_einer_konfigurationsdatei() {
    let path = fake_claude("agent");
    let mut terminal = open_powershell("claude-agent", &path, Some("claude --resume abc-123"));

    let args = terminal.claude_args();

    assert_eq!(args.matches("--settings").count(), 1, "{args}");
    assert!(args.ends_with("--resume abc-123"), "{args}");
}

#[test]
fn ohne_konfigurationsdatei_startet_das_terminal_wie_bisher() {
    assert_eq!(shell_start_command(Shell::Powershell, None, None), None);
    assert_eq!(
        shell_start_command(Shell::Powershell, None, Some("claude --resume x")).as_deref(),
        Some("claude --resume x")
    );
}

// Git Bash verhält sich wie PowerShell: Auch dort legt Kredr eine Funktion
// `claude` an.

/// Ein Ordner mit einem Test-Ersatz `claude` für Git Bash, der jedes Argument
/// in eckigen Klammern ausgibt. Geliefert wird die Bash-Zeile, die den Ordner
/// vor alle anderen im Suchpfad stellt.
fn fake_claude_for_bash(name: &str) -> String {
    let folder = temp_project(&format!("bash-claude-{name}"));
    std::fs::write(
        folder.join("claude"),
        format!("#!/bin/sh\nprintf '{FAKE_CLAUDE_MARK}'\nprintf '[%s] ' \"$@\"\necho\n"),
    )
    .expect("Test-Ersatz sollte anlegbar sein");
    format!("PATH=\"$(cygpath -u '{}'):$PATH\"", folder.display())
}

/// Öffnet eine Git Bash, wie Kredr sie startet. `profile` läuft vorher, so
/// wie die `.bashrc` der Person.
fn open_git_bash(name: &str, profile: &str, agent_command: Option<&str>) -> TestTerminal {
    // Ohne Empfänger: Die Meldung der Rückkehr von `claude` geht ins Leere.
    let hooks = TerminalHooks {
        settings: terminal_settings(),
        exited_url: "http://127.0.0.1:9/hook/7/kennwort/exited".to_owned(),
    };
    let start = shell_start_command(Shell::GitBash, Some(&hooks), agent_command)
        .expect("Mit Konfigurationsdatei sollte es einen Startbefehl geben");
    let start = format!("{profile}\n{start}");
    TestTerminal::open_with(temp_project(name), Shell::GitBash, Some(&start))
}

/// Die Argumente, wie der Test-Ersatz für Git Bash sie ausgibt.
fn bracketed(args: &[&str]) -> String {
    args.iter()
        .map(|arg| format!("[{arg}]"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn claude_in_git_bash_bekommt_die_konfigurationsdatei_des_terminals() {
    if !git_bash_found() {
        return;
    }
    let path = fake_claude_for_bash("argumente");
    let mut terminal = open_git_bash("bash-claude-argumente", &path, None);

    terminal.send_line("claude --model x \"zwei Worte\"");

    let settings = terminal_settings().display().to_string();
    assert_eq!(
        terminal.claude_args(),
        bracketed(&["--settings", &settings, "--model", "x", "zwei Worte"])
    );
}

#[test]
fn in_git_bash_bekommen_nur_aufrufe_mit_sitzung_die_konfigurationsdatei() {
    if !git_bash_found() {
        return;
    }
    let path = fake_claude_for_bash("ohne-sitzung");
    let mut terminal = open_git_bash("bash-claude-ohne-sitzung", &path, None);
    let settings = terminal_settings().display().to_string();
    let with_settings = |args: &[&str]| {
        let mut all = vec!["--settings", settings.as_str()];
        all.extend_from_slice(args);
        bracketed(&all)
    };
    let cases = [
        ("-p \"x\"", bracketed(&["-p", "x"])),
        ("--print x", bracketed(&["--print", "x"])),
        ("--version", bracketed(&["--version"])),
        ("-v", bracketed(&["-v"])),
        ("--help", bracketed(&["--help"])),
        ("-h", bracketed(&["-h"])),
        ("mcp list", bracketed(&["mcp", "list"])),
        ("--model x -p y", bracketed(&["--model", "x", "-p", "y"])),
        ("", with_settings(&[])),
        ("--model x", with_settings(&["--model", "x"])),
        ("-c", with_settings(&["-c"])),
        ("-P", with_settings(&["-P"])),
        ("\"zwei Worte\"", with_settings(&["zwei Worte"])),
    ];

    let line = cases
        .iter()
        .map(|(args, _)| format!("claude {args}"))
        .collect::<Vec<_>>()
        .join("; ");
    terminal.send_line(&line);

    let calls = terminal.next_claude_calls(cases.len());
    let expected: Vec<String> = cases.into_iter().map(|(_, passed)| passed).collect();
    assert_eq!(calls, expected);
}

#[test]
fn ein_prompt_mit_grossbuchstaben_startet_auch_mit_nocasematch_eine_sitzung() {
    if !git_bash_found() {
        return;
    }
    // `nocasematch` aus der `.bashrc` darf `Hilfe` nicht zum Unterbefehl machen.
    let profile = format!(
        "{}\nshopt -s nocasematch",
        fake_claude_for_bash("nocasematch")
    );
    let mut terminal = open_git_bash("bash-claude-nocasematch", &profile, None);

    terminal.send_line("claude Hilfe; shopt -q nocasematch && echo \"noch-$((6*7))\"");

    let settings = terminal_settings().display().to_string();
    assert_eq!(
        terminal.claude_args(),
        bracketed(&["--settings", &settings, "Hilfe"])
    );
    // Die Einstellung der Person bleibt, wie sie war.
    terminal.wait_for_output("noch-42");
}

#[test]
fn claude_aus_der_bashrc_wird_uebergangen() {
    if !git_bash_found() {
        return;
    }
    for (name, definition) in [
        ("alias", "alias claude=date"),
        ("funktion", "claude() { echo 'aus der .bashrc'; }"),
    ] {
        let profile = format!("{}\n{definition}", fake_claude_for_bash(name));
        let mut terminal = open_git_bash(&format!("bash-claude-{name}"), &profile, None);

        terminal.send_line("claude --model x");

        let settings = terminal_settings().display().to_string();
        assert_eq!(
            terminal.claude_args(),
            bracketed(&["--settings", &settings, "--model", "x"]),
            "{name}"
        );
    }
}

#[test]
fn agent_von_kredr_startet_in_git_bash_ueber_die_funktion() {
    if !git_bash_found() {
        return;
    }
    let path = fake_claude_for_bash("agent");
    let settings = terminal_settings().display().to_string();
    // Bash unterscheidet bei Funktionen Groß- und Kleinschreibung, Windows
    // beim Programm nicht: `Claude` bekommt die Datei trotzdem genau einmal.
    for program in ["claude", "Claude"] {
        let mut terminal = open_git_bash(
            &format!("bash-claude-agent-{}", program.to_lowercase()),
            &path,
            Some(&format!("{program} --resume abc-123")),
        );

        assert_eq!(
            terminal.claude_args(),
            bracketed(&["--settings", &settings, "--resume", "abc-123"]),
            "{program}"
        );
    }
}
