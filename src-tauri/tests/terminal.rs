//! Tests des Terminal-Dienstes über seine öffentliche Schnittstelle,
//! gegen eine echte PowerShell.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::terminal::{
    available_shells, startable_shell, Shell, Terminal, TerminalEvent, TerminalOptions,
};

const TIMEOUT: Duration = Duration::from_secs(30);

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
