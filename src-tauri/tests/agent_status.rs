//! Tests des Agentenstatus über seine öffentliche Schnittstelle. Die Tests
//! spielen die Rolle von Claude Code: Sie lesen die Konfiguration, die ein
//! Agent beim Start mitbekommt, und senden dessen Meldungen im dokumentierten
//! Format an die dort genannte Adresse. Ein echtes Claude Code startet nicht.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::agent::with_status_settings;
use kredr_lib::agent_status::{
    remove_orphaned_runtime_folders, runtime_folder_of, AgentState, AgentStatus, Resumed,
    StatusUpdate,
};
use kredr_lib::terminal::{available_shells, Shell, Terminal, TerminalEvent, TerminalOptions};
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(10);

/// Ein leerer Ordner für die Konfigurationen eines Tests.
fn runtime_folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-agentenstatus-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Ein Agent aus Sicht des Tests: die Konfiguration, die er beim Start
/// mitbekommt, und die Statusmeldungen, die für sein Terminal ankommen.
struct TestAgent {
    settings: PathBuf,
    updates: Receiver<StatusUpdate>,
}

impl TestAgent {
    fn start(status: &AgentStatus, terminal: u32) -> TestAgent {
        TestAgent::register(status, terminal, None)
    }

    /// Ein Agent, der ein gespeichertes Gespräch fortsetzt.
    fn resume(status: &AgentStatus, terminal: u32, resumed: Resumed) -> TestAgent {
        TestAgent::register(status, terminal, Some(resumed))
    }

    /// Meldet das Terminal an, mit oder ohne fortgesetztes Gespräch.
    fn register(status: &AgentStatus, terminal: u32, resumed: Option<Resumed>) -> TestAgent {
        let (sender, updates) = channel();
        let settings = status
            .register(terminal, resumed, move |update| {
                let _ = sender.send(update);
            })
            .expect("Die Konfiguration sollte sich anlegen lassen");
        TestAgent { settings, updates }
    }

    /// Meldet ein Ereignis so, wie Claude Code es täte: per POST an die
    /// Adresse, die in der Konfiguration für dieses Ereignis steht.
    fn report(&self, event: &str, fields: Value) {
        let url = hook_url(&self.settings, event)
            .unwrap_or_else(|| panic!("Für {event} sollte ein Hook eingetragen sein"));
        let mut body = json!({
            "session_id": "abc123",
            "transcript_path": "C:\\Users\\test\\.claude\\projects\\p\\abc123.jsonl",
            "cwd": "C:\\Projekte\\kredr",
            "hook_event_name": event,
        });
        for (key, value) in fields.as_object().expect("Felder als Objekt") {
            body[key] = value.clone();
        }
        let status = post(&url, &body.to_string());
        assert_eq!(status, 200, "Der Kern sollte {event} annehmen");
    }

    fn next(&self) -> StatusUpdate {
        self.updates
            .recv_timeout(TIMEOUT)
            .expect("Eine Statusmeldung sollte ankommen")
    }

    fn next_state(&self) -> AgentState {
        self.next().state
    }

    fn expect_silence(&self) {
        if let Ok(update) = self.updates.recv_timeout(Duration::from_millis(300)) {
            panic!("Unerwartete Statusmeldung: {update:?}");
        }
    }
}

/// Die Adresse des ersten Hooks, der in der Konfiguration für `event` steht.
fn hook_url(settings: &Path, event: &str) -> Option<String> {
    let text = std::fs::read_to_string(settings).ok()?;
    let settings: Value = serde_json::from_str(&text).expect("Die Konfiguration ist JSON");
    let hook = &settings["hooks"][event][0]["hooks"][0];
    assert_eq!(hook["type"], "http");
    hook["url"].as_str().map(str::to_owned)
}

/// Sendet `body` per POST und liefert den Statuscode der Antwort.
fn post(url: &str, body: &str) -> u16 {
    let rest = url.strip_prefix("http://").expect("eine http-Adresse");
    let (host, path) = rest.split_once('/').expect("Adresse mit Pfad");
    let mut stream = TcpStream::connect(host).expect("Der Kern sollte Verbindungen annehmen");
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    write!(
        stream,
        "POST /{path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("Keine HTTP-Antwort: {response:?}"))
}

#[test]
fn eine_abgeschickte_eingabe_laesst_den_agenten_arbeiten() {
    let status = AgentStatus::start(runtime_folder("arbeitet")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue das Ticket" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert!(update.state_changed);
}

#[test]
fn ein_arbeitsgang_durchlaeuft_arbeitet_wartet_arbeitet_fertig() {
    let status = AgentStatus::start(runtime_folder("arbeitsgang")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let cargo_test = json!({ "tool_name": "Bash", "tool_input": { "command": "cargo test" } });

    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "Lass die Tests laufen" }),
    );
    assert_eq!(agent.next_state(), AgentState::Working);

    agent.report("PreToolUse", cargo_test.clone());
    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert!(!update.state_changed);
    assert_eq!(update.last_action.as_deref(), Some("Bash(cargo test)"));

    agent.report("PermissionRequest", cargo_test.clone());
    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert!(update.state_changed);
    assert_eq!(update.last_action.as_deref(), Some("Bash(cargo test)"));

    agent.report("PostToolUse", cargo_test);
    assert_eq!(agent.next_state(), AgentState::Working);

    agent.report(
        "Stop",
        json!({
            "stop_hook_active": false,
            "last_assistant_message": "\nAlle Tests sind grün.\n\nDetails folgen.",
        }),
    );
    let update = agent.next();
    assert_eq!(update.state, AgentState::Done);
    assert_eq!(update.last_action.as_deref(), Some("Alle Tests sind grün."));
}

#[test]
fn rueckfragen_an_den_nutzer_lassen_den_agenten_warten() {
    let status = AgentStatus::start(runtime_folder("rueckfragen")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let prompt = json!({ "prompt": "Weiter" });

    // Eine Frage mit Antwortmöglichkeiten.
    agent.report("UserPromptSubmit", prompt.clone());
    assert_eq!(agent.next_state(), AgentState::Working);
    agent.report(
        "PreToolUse",
        json!({
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [{ "question": "Welche Datenbank?" }] },
        }),
    );
    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.last_action.as_deref(), Some("Welche Datenbank?"));

    // Die Meldungen, mit denen Claude Code selbst auf sich aufmerksam macht.
    for kind in [
        "permission_prompt",
        "elicitation_dialog",
        "agent_needs_input",
    ] {
        agent.report("UserPromptSubmit", prompt.clone());
        assert_eq!(agent.next_state(), AgentState::Working);
        agent.report(
            "Notification",
            json!({ "message": "Claude needs your permission", "notification_type": kind }),
        );
        assert_eq!(agent.next_state(), AgentState::Waiting, "{kind}");
    }
}

#[test]
fn die_meldung_zur_erlaubnis_ersetzt_die_genauere_letzte_aktion_nicht() {
    let status = AgentStatus::start(runtime_folder("erlaubnis")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report(
        "PermissionRequest",
        json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } }),
    );
    assert_eq!(agent.next_state(), AgentState::Waiting);
    // Etwa sechs Sekunden später meldet Claude Code dieselbe Rückfrage noch einmal.
    agent.report(
        "Notification",
        json!({ "message": "Claude needs your permission", "notification_type": "permission_prompt" }),
    );

    agent.expect_silence();
}

#[test]
fn die_letzte_aktion_nennt_werkzeug_und_ziel() {
    let status = AgentStatus::start(runtime_folder("letzte-aktion")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let cases = [
        (
            json!({ "tool_name": "Edit", "tool_input": { "file_path": "C:\\Projekte\\kredr\\src\\git\\log.rs", "old_string": "a", "new_string": "b" } }),
            "Edit(src\\git\\log.rs)",
        ),
        (
            json!({ "tool_name": "Read", "tool_input": { "file_path": "C:\\Anderswo\\notiz.md" } }),
            "Read(C:\\Anderswo\\notiz.md)",
        ),
        (
            json!({ "tool_name": "Grep", "tool_input": { "pattern": "TODO", "path": "src" } }),
            "Grep(TODO)",
        ),
        (
            json!({ "tool_name": "Bash", "tool_input": { "command": "npm test\nnpm run build" } }),
            "Bash(npm test npm run build)",
        ),
        (
            json!({ "tool_name": "TodoWrite", "tool_input": { "todos": [] } }),
            "TodoWrite",
        ),
    ];

    for (fields, expected) in cases {
        agent.report("PreToolUse", fields);
        assert_eq!(agent.next().last_action.as_deref(), Some(expected));
    }

    // Lange Befehle werden gekürzt, damit die Karte lesbar bleibt.
    let long = "x".repeat(500);
    agent.report(
        "PreToolUse",
        json!({ "tool_name": "Bash", "tool_input": { "command": long } }),
    );
    let action = agent.next().last_action.unwrap();
    assert!(action.chars().count() <= 120, "{action}");
    assert!(action.ends_with("…)"), "{action}");
}

#[test]
fn ein_fehler_der_schnittstelle_beendet_die_arbeit() {
    let status = AgentStatus::start(runtime_folder("fehler")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);
    agent.report(
        "StopFailure",
        json!({ "error": "rate_limit", "last_assistant_message": "API Error: Rate limit reached" }),
    );

    let update = agent.next();
    assert_eq!(update.state, AgentState::Done);
    assert_eq!(
        update.last_action.as_deref(),
        Some("API Error: Rate limit reached")
    );
}

#[test]
fn nach_einer_unterbrechung_gilt_der_agent_als_fertig_sobald_er_unbeschaeftigt_meldet() {
    let status = AgentStatus::start(runtime_folder("unterbrechung")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let idle = json!({ "message": "Claude is waiting for your input", "notification_type": "idle_prompt" });

    // Bricht der Nutzer mit Esc ab, meldet Claude Code kein Ende der Antwort.
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);
    agent.report("Notification", idle.clone());
    assert_eq!(agent.next_state(), AgentState::Done);

    // Ist er schon fertig, ändert die Meldung nichts.
    agent.report("Notification", idle);
    agent.expect_silence();
}

#[test]
fn beendet_sich_der_agent_ist_der_status_unbekannt() {
    let status = AgentStatus::start(runtime_folder("beendet")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);
    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Unknown);
    assert_eq!(update.last_action, None);
}

#[test]
fn der_erste_prompt_wird_zum_auftrag() {
    let status = AgentStatus::start(runtime_folder("auftrag")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "/mattpocock-skills:implement 24" }),
    );

    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(
        update.assignment.as_deref(),
        Some("/mattpocock-skills:implement 24")
    );
}

#[test]
fn weitere_prompts_derselben_sitzung_aendern_den_auftrag_nicht() {
    let status = AgentStatus::start(runtime_folder("auftrag-bleibt")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 24" }));
    agent.report("Stop", json!({ "last_assistant_message": "Fertig." }));
    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "Und jetzt committen" }),
    );

    let assignments: Vec<_> = (0..3).map(|_| agent.next().assignment).collect();
    assert_eq!(assignments, vec![Some("Baue Ticket 24".to_owned()); 3]);
}

#[test]
fn nach_dem_leeren_des_gespraechs_wird_der_naechste_prompt_der_neue_auftrag() {
    let status = AgentStatus::start(runtime_folder("auftrag-clear")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 24" }));
    agent.report("Stop", json!({ "last_assistant_message": "Fertig." }));
    agent.report("SessionEnd", json!({ "reason": "clear" }));
    agent.next();
    agent.next();

    let cleared = agent.next();
    assert_eq!(cleared.state, AgentState::Unknown);
    assert_eq!(cleared.assignment, None);

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 25" }));
    assert_eq!(agent.next().assignment.as_deref(), Some("Baue Ticket 25"));
}

#[test]
fn ein_leerer_prompt_wird_nicht_zum_auftrag() {
    let status = AgentStatus::start(runtime_folder("auftrag-leer")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report("UserPromptSubmit", json!({ "prompt": "  \n " }));
    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 24" }));

    assert_eq!(agent.next().assignment, None);
    assert_eq!(agent.next().assignment.as_deref(), Some("Baue Ticket 24"));
}

#[test]
fn jeder_agent_hat_seinen_eigenen_auftrag() {
    let status = AgentStatus::start(runtime_folder("auftrag-mehrere")).unwrap();
    let first = TestAgent::start(&status, 1);
    let second = TestAgent::start(&status, 2);

    first.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 24" }));
    second.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 25" }));

    assert_eq!(first.next().assignment.as_deref(), Some("Baue Ticket 24"));
    assert_eq!(second.next().assignment.as_deref(), Some("Baue Ticket 25"));
}

#[test]
fn das_gespraech_ist_bekannt_sobald_der_agent_startet() {
    let status = AgentStatus::start(runtime_folder("gespraech-start")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report(
        "SessionStart",
        json!({ "session_id": "gespraech-1", "source": "startup" }),
    );

    let update = agent.next();
    assert_eq!(update.conversation.as_deref(), Some("gespraech-1"));
    assert_eq!(update.state, AgentState::Unknown);
}

#[test]
fn nach_dem_leeren_gilt_das_neue_gespraech() {
    let status = AgentStatus::start(runtime_folder("gespraech-clear")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report(
        "UserPromptSubmit",
        json!({ "session_id": "alt", "prompt": "Baue Ticket 24" }),
    );
    assert_eq!(agent.next().conversation.as_deref(), Some("alt"));
    agent.report(
        "SessionEnd",
        json!({ "session_id": "alt", "reason": "clear" }),
    );
    assert_eq!(agent.next().conversation, None);
    agent.report(
        "SessionStart",
        json!({ "session_id": "neu", "source": "clear" }),
    );

    let update = agent.next();
    assert_eq!(update.conversation.as_deref(), Some("neu"));
    assert_eq!(update.assignment, None);
}

#[test]
fn beendet_sich_der_agent_gibt_es_kein_gespraech_mehr() {
    let status = AgentStatus::start(runtime_folder("gespraech-ende")).unwrap();
    let agent = TestAgent::start(&status, 1);

    agent.report(
        "UserPromptSubmit",
        json!({ "session_id": "laufend", "prompt": "Los" }),
    );
    assert_eq!(agent.next().conversation.as_deref(), Some("laufend"));
    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));

    assert_eq!(agent.next().conversation, None);
}

#[test]
fn ein_fortgesetzter_agent_behaelt_gespraech_und_auftrag() {
    let status = AgentStatus::start(runtime_folder("gespraech-fortsetzen")).unwrap();
    let agent = TestAgent::resume(
        &status,
        1,
        Resumed {
            conversation: "abc123".into(),
            assignment: Some("Baue Ticket 24".into()),
        },
    );

    // Claude Code meldet beim Fortsetzen dieselbe Kennung; das ändert nichts.
    agent.report("SessionStart", json!({ "source": "resume" }));
    agent.expect_silence();
    agent.report("UserPromptSubmit", json!({ "prompt": "Mach weiter" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(update.conversation.as_deref(), Some("abc123"));
    assert_eq!(update.assignment.as_deref(), Some("Baue Ticket 24"));
}

#[test]
fn endet_das_terminal_ist_der_status_unbekannt_und_die_konfiguration_fort() {
    let status = AgentStatus::start(runtime_folder("terminal-endet")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let url = hook_url(&agent.settings, "UserPromptSubmit").unwrap();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);
    status.forget(1);

    assert_eq!(agent.next_state(), AgentState::Unknown);
    assert!(!agent.settings.exists());
    // Ein Nachzügler des beendeten Agenten findet kein Terminal mehr.
    assert_eq!(post(&url, "{\"hook_event_name\":\"Stop\"}"), 404);
    agent.expect_silence();
}

#[test]
fn mehrere_agenten_melden_an_ihr_eigenes_terminal() {
    let status = AgentStatus::start(runtime_folder("mehrere")).unwrap();
    let first = TestAgent::start(&status, 1);
    let second = TestAgent::start(&status, 2);
    assert_ne!(first.settings, second.settings);

    // Ob im selben Projekt oder in verschiedenen Fenstern: Die Meldungen
    // zweier Agenten gleichen sich bis auf die Adresse, an die sie gehen.
    // Alle Fenster teilen sich einen Empfänger, jedes Terminal hat darin
    // seine eigene Kennung.
    first.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    second.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    second.report("Stop", json!({ "last_assistant_message": "Erledigt." }));

    assert_eq!(first.next_state(), AgentState::Working);
    first.expect_silence();
    assert_eq!(second.next_state(), AgentState::Working);
    assert_eq!(second.next_state(), AgentState::Done);
}

#[test]
fn agenten_verschiedener_kredr_prozesse_bleiben_getrennt() {
    // Zwei Kredr-Prozesse, etwa die Entwicklungsfassung neben der
    // installierten, haben je einen eigenen Empfänger; ihre
    // Terminal-Kennungen können sich gleichen.
    let process_a = AgentStatus::start(runtime_folder("prozess-a")).unwrap();
    let process_b = AgentStatus::start(runtime_folder("prozess-b")).unwrap();
    let agent_a = TestAgent::start(&process_a, 1);
    let agent_b = TestAgent::start(&process_b, 1);

    agent_b.report("UserPromptSubmit", json!({ "prompt": "Los" }));

    assert_eq!(agent_b.next_state(), AgentState::Working);
    agent_a.expect_silence();
}

#[test]
fn meldungen_ohne_gueltiges_kennwort_werden_abgewiesen() {
    let status = AgentStatus::start(runtime_folder("kennwort")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let url = hook_url(&agent.settings, "Stop").unwrap();
    let (base, _token) = url.rsplit_once('/').unwrap();

    let code = post(&format!("{base}/geraten"), "{\"hook_event_name\":\"Stop\"}");

    assert_eq!(code, 404);
    agent.expect_silence();
}

#[test]
fn unbekannte_und_unlesbare_meldungen_aendern_nichts() {
    let status = AgentStatus::start(runtime_folder("unlesbar")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let url = hook_url(&agent.settings, "Stop").unwrap();

    // Claude Code darf davon nichts merken: Die Antwort bleibt ein Erfolg.
    assert_eq!(post(&url, "kein json"), 200);
    assert_eq!(post(&url, "{\"hook_event_name\":\"PostCompact\"}"), 200);

    agent.expect_silence();
}

#[test]
fn beim_start_verschwinden_nur_die_laufzeitordner_beendeter_kredr_prozesse() {
    // Steht für `%TEMP%`; aufgeräumt wird nur in diesem Ordner des Tests.
    let temp = runtime_folder("aufraeumen");
    std::fs::create_dir_all(&temp).unwrap();
    // Ein Prozess, der sicher nicht mehr läuft.
    let mut ended = std::process::Command::new("cmd")
        .args(["/c", "exit"])
        .spawn()
        .unwrap();
    let ended_pid = ended.id();
    ended.wait().unwrap();
    let orphaned = runtime_folder_of(&temp, ended_pid);
    std::fs::create_dir_all(&orphaned).unwrap();
    std::fs::write(orphaned.join("terminal-3.json"), "{}").unwrap();
    // Ein Kredr, das noch läuft: hier der Testprozess selbst.
    let running = runtime_folder_of(&temp, std::process::id());
    std::fs::create_dir_all(&running).unwrap();
    std::fs::write(running.join("terminal-1.json"), "{}").unwrap();
    // Was nicht nach einem Laufzeitordner aussieht, gehört jemand anderem.
    let foreign = temp.join("kredr-notizen");
    std::fs::create_dir_all(&foreign).unwrap();
    // Ein Ordner mit fremdem Inhalt wird nicht geleert.
    let mut other = std::process::Command::new("cmd")
        .args(["/c", "exit"])
        .spawn()
        .unwrap();
    let other_pid = other.id();
    other.wait().unwrap();
    let mixed = runtime_folder_of(&temp, other_pid);
    std::fs::create_dir_all(&mixed).unwrap();
    std::fs::write(mixed.join("wichtig.txt"), "nicht von Kredr").unwrap();

    remove_orphaned_runtime_folders(&temp);

    assert!(!orphaned.exists(), "Der verwaiste Ordner sollte fort sein");
    assert!(running.join("terminal-1.json").exists());
    assert!(foreign.exists());
    if mixed != orphaned {
        assert!(mixed.join("wichtig.txt").exists());
    }
}

#[test]
fn die_konfiguration_enthaelt_nur_hooks_an_den_eigenen_rechner() {
    let folder = runtime_folder("konfiguration");
    let status = AgentStatus::start(folder.clone()).unwrap();
    let agent = TestAgent::start(&status, 7);

    assert!(agent.settings.starts_with(&folder));
    let text = std::fs::read_to_string(&agent.settings).unwrap();
    let settings: Value = serde_json::from_str(&text).unwrap();
    let keys: Vec<&String> = settings.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["hooks"]);
    for (event, entries) in settings["hooks"].as_object().unwrap() {
        for entry in entries.as_array().unwrap() {
            for hook in entry["hooks"].as_array().unwrap() {
                assert_eq!(hook["type"], "http", "{event}");
                let url = hook["url"].as_str().unwrap();
                assert!(url.starts_with("http://127.0.0.1:"), "{event}: {url}");
            }
        }
    }
}

/// Alle Dateien unter `dir` mit ihrem Inhalt.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let content = std::fs::read(&path).unwrap();
                files.push((path, content));
            }
        }
    }
    files.sort();
    files
}

#[test]
fn der_agent_startet_mit_der_konfiguration_und_das_projekt_bleibt_unberuehrt() {
    let folder = runtime_folder("agent-start");
    // Ein Projekt mit eigenen Claude-Code-Einstellungen.
    let project = folder.join("projekt");
    std::fs::create_dir_all(project.join(".claude")).unwrap();
    let project_settings =
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo eigener hook"}]}]}}"#;
    std::fs::write(
        project.join(".claude").join("settings.json"),
        project_settings,
    )
    .unwrap();
    std::fs::write(project.join(".claude").join("settings.local.json"), "{}").unwrap();
    let before = snapshot(&project);
    // Anstelle von Claude Code ein Programm gleichen Namens, das nur
    // festhält, womit es aufgerufen wurde.
    let programs = folder.join("programme");
    std::fs::create_dir_all(&programs).unwrap();
    let arguments = programs.join("argumente.txt");
    std::fs::write(
        programs.join("claude.cmd"),
        "@echo off\r\n> \"%~dp0argumente.txt\" echo %*\r\n",
    )
    .unwrap();

    let status = AgentStatus::start(folder.join("laufzeit")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let command = with_status_settings(
        programs.join("claude.cmd").to_str().unwrap(),
        &agent.settings,
        Shell::Powershell,
    );
    let (sender, events) = channel();
    let options = TerminalOptions {
        shell: Shell::Powershell,
        cwd: project.clone(),
        cols: 200,
        rows: 30,
        start_command: Some(command),
    };
    let terminal = Terminal::open(options, move |event| {
        let _ = sender.send(event);
    })
    .expect("PowerShell sollte starten");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !arguments.exists() {
        assert!(Instant::now() < deadline, "Der Agent wurde nie gestartet");
        // ConPTY wartet beim Start auf die Antwort auf seine Cursorabfrage.
        if let Ok(TerminalEvent::Output(bytes)) = events.recv_timeout(Duration::from_millis(50)) {
            if String::from_utf8_lossy(&bytes).contains("\x1b[6n") {
                terminal.write(b"\x1b[1;1R").unwrap();
            }
        }
    }
    // Die Datei entsteht, bevor ihr Inhalt geschrieben ist.
    std::thread::sleep(Duration::from_millis(200));

    let passed = std::fs::read_to_string(&arguments).unwrap();
    assert_eq!(
        passed.trim(),
        format!("--settings {}", agent.settings.display())
    );
    assert_eq!(snapshot(&project), before);
}

#[test]
fn in_git_bash_kommt_die_konfiguration_als_ein_argument_beim_agenten_an() {
    if !available_shells().contains(&Shell::GitBash) {
        eprintln!("Git Bash wurde nicht gefunden; Test übersprungen");
        return;
    }
    let folder = runtime_folder("git-bash");
    let project = folder.join("projekt");
    std::fs::create_dir_all(&project).unwrap();
    // Anstelle von Claude Code ein Skript gleichen Namens, das jedes
    // Argument in eine eigene Zeile schreibt.
    let programs = folder.join("programme");
    std::fs::create_dir_all(&programs).unwrap();
    let arguments = programs.join("argumente.txt");
    std::fs::write(
        programs.join("claude"),
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/argumente.txt\"\n",
    )
    .unwrap();

    // Der Laufzeitordner liegt im Benutzerordner; dessen Name kann
    // Leerzeichen und einen Apostroph enthalten.
    let status = AgentStatus::start(folder.join("Max O'Neil").join("lauf zeit")).unwrap();
    let agent = TestAgent::start(&status, 1);
    let program = programs.join("claude").to_str().unwrap().replace('\\', "/");
    let command = with_status_settings(
        &format!("{program} --model opus"),
        &agent.settings,
        Shell::GitBash,
    );
    let (sender, events) = channel();
    let options = TerminalOptions {
        shell: Shell::GitBash,
        cwd: project,
        cols: 200,
        rows: 30,
        start_command: Some(command),
    };
    let terminal = Terminal::open(options, move |event| {
        let _ = sender.send(event);
    })
    .expect("Git Bash sollte starten");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !arguments.exists() {
        assert!(Instant::now() < deadline, "Der Agent wurde nie gestartet");
        // ConPTY wartet beim Start auf die Antwort auf seine Cursorabfrage.
        if let Ok(TerminalEvent::Output(bytes)) = events.recv_timeout(Duration::from_millis(50)) {
            if String::from_utf8_lossy(&bytes).contains("\x1b[6n") {
                terminal.write(b"\x1b[1;1R").unwrap();
            }
        }
    }
    // Die Datei entsteht, bevor ihr Inhalt geschrieben ist.
    std::thread::sleep(Duration::from_millis(200));

    let passed = std::fs::read_to_string(&arguments).unwrap();
    let settings = agent.settings.display().to_string();
    assert_eq!(
        passed.lines().collect::<Vec<_>>(),
        ["--settings", settings.as_str(), "--model", "opus"]
    );
}
