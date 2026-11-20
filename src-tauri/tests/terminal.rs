//! Tests des Terminal-Dienstes über seine öffentliche Schnittstelle,
//! gegen eine echte PowerShell.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::terminal::{Terminal, TerminalEvent, TerminalOptions};

const TIMEOUT: Duration = Duration::from_secs(30);

struct TestTerminal {
    terminal: Terminal,
    events: Receiver<TerminalEvent>,
    output: String,
}

impl TestTerminal {
    fn open(cwd: PathBuf) -> TestTerminal {
        let (sender, events) = channel();
        let options = TerminalOptions {
            cwd,
            cols: 200,
            rows: 30,
        };
        let terminal = Terminal::open(options, move |event| {
            let _ = sender.send(event);
        })
        .expect("PowerShell sollte starten");
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
fn prozessende_wird_nach_der_letzten_ausgabe_gemeldet() {
    let mut terminal = TestTerminal::open(temp_project("ende"));

    terminal.send_line("echo \"letzte-$(6*7)\"; exit");

    terminal.wait_for_exit();

    // Was die Shell vor ihrem Ende ausgegeben hat, ist dann schon angekommen.
    assert!(terminal.output.contains("letzte-42"));
}
