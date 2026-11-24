//! Tests des Agentenstatus über seine öffentliche Schnittstelle.
//!
//! Die meisten Fälle prüfen den `TrackedAgent` direkt: Die Tests spielen die
//! Rolle von Claude Code und übergeben ihm die Ereignisse im dokumentierten
//! Format. Am Ende stehen die Tests des Empfangs, die dieselben Ereignisse
//! per HTTP an die Adresse aus der Konfiguration schicken. Ein echtes Claude
//! Code startet nicht.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::agent::{shell_start_command, with_status_settings};
use kredr_lib::agent_status::{
    remove_orphaned_runtime_folders, runtime_folder_of, AgentState, AgentStatus, BackgroundTask,
    Resumed, StatusUpdate, SubagentState, TerminalHooks, TrackedAgent,
};
use kredr_lib::terminal::{
    available_shells, git_bash, Shell, Terminal, TerminalEvent, TerminalOptions,
};
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(10);

/// Ein leerer Ordner für die Konfigurationen eines Tests.
fn runtime_folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-agentenstatus-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Ein Ereignis `event`, wie Claude Code es einem Hook übergibt, mit den
/// Feldern, die jede Meldung trägt, und zusätzlich `fields`.
fn hook_event(event: &str, fields: Value) -> Value {
    let mut body = json!({
        "session_id": "abc123",
        "transcript_path": "C:\\Users\\test\\.claude\\projects\\p\\abc123.jsonl",
        "cwd": "C:\\Projekte\\kredr",
        "hook_event_name": event,
    });
    for (key, value) in fields.as_object().expect("Felder als Objekt") {
        body[key] = value.clone();
    }
    body
}

/// Ein Agent aus Sicht des Tests: sein `TrackedAgent` und die Meldungen, die
/// dieser geliefert und der Test noch nicht abgeholt hat.
struct TestAgent {
    tracked: RefCell<TrackedAgent>,
    updates: RefCell<VecDeque<StatusUpdate>>,
}

impl TestAgent {
    fn start() -> TestAgent {
        TestAgent::register(None)
    }

    /// Ein Agent, der ein gespeichertes Gespräch fortsetzt.
    fn resume(resumed: Resumed) -> TestAgent {
        TestAgent::register(Some(resumed))
    }

    fn register(resumed: Option<Resumed>) -> TestAgent {
        TestAgent {
            tracked: RefCell::new(TrackedAgent::new(resumed)),
            updates: RefCell::default(),
        }
    }

    /// Meldet ein Ereignis so, wie Claude Code es täte, und merkt sich die
    /// Meldung, falls eine kommt.
    fn report(&self, event: &str, fields: Value) {
        let update = self
            .tracked
            .borrow_mut()
            .on_event(&hook_event(event, fields));
        self.updates.borrow_mut().extend(update);
    }

    /// Das Programm `claude` ist zurückgekehrt; so meldet es die Shell-Funktion.
    fn claude_exited(&self) {
        let update = self.tracked.borrow_mut().claude_exited();
        self.updates.borrow_mut().extend(update);
    }

    /// Das Terminal endet.
    fn forget(&self) -> Option<StatusUpdate> {
        self.tracked.borrow_mut().forget()
    }

    /// Die älteste Meldung, die der Test noch nicht abgeholt hat.
    fn next(&self) -> StatusUpdate {
        self.updates
            .borrow_mut()
            .pop_front()
            .expect("Eine Statusmeldung sollte gekommen sein")
    }

    fn next_state(&self) -> AgentState {
        self.next().state
    }

    /// Erwartet, dass sich in allen noch nicht abgeholten Meldungen allein
    /// die Subagenten ändern: Zustand und letzte Aktion des Agenten bleiben
    /// `state` und `last_action`.
    fn expect_only_subagents(&self, state: AgentState, last_action: Option<&str>) {
        for update in self.updates.borrow_mut().drain(..) {
            assert_eq!(update.state, state, "{update:?}");
            assert_eq!(update.last_action.as_deref(), last_action, "{update:?}");
            assert!(!update.state_changed, "{update:?}");
        }
    }

    /// Erwartet, dass jedes Ereignis seit der zuletzt abgeholten Meldung
    /// keine Meldung ergeben hat.
    fn expect_silence(&self) {
        let updates = self.updates.borrow();
        assert!(updates.is_empty(), "Unerwartete Statusmeldung: {updates:?}");
    }
}

/// Die letzte der noch nicht abgeholten Meldungen; es muss eine geben.
fn settle(agent: &TestAgent) -> StatusUpdate {
    let mut updates = agent.updates.borrow_mut();
    let last = updates
        .pop_back()
        .expect("Eine Statusmeldung sollte gekommen sein");
    updates.clear();
    last
}

#[test]
fn eine_abgeschickte_eingabe_laesst_den_agenten_arbeiten() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue das Ticket" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert!(update.state_changed);
}

#[test]
fn ein_arbeitsgang_durchlaeuft_arbeitet_wartet_arbeitet_fertig() {
    let agent = TestAgent::start();
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
    let agent = TestAgent::start();
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
    let agent = TestAgent::start();

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
    let agent = TestAgent::start();
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

/// Die Felder, mit denen Claude Code ein Ereignis eines Subagenten kennzeichnet.
fn from_subagent(agent_id: &str, fields: Value) -> Value {
    let mut fields = fields;
    fields["agent_id"] = json!(agent_id);
    fields["agent_type"] = json!("Explore");
    fields
}

#[test]
fn werkzeugaufrufe_von_subagenten_aendern_den_agenten_nicht() {
    let agent = TestAgent::start();
    let read = |file: &str| json!({ "tool_name": "Read", "tool_input": { "file_path": file } });

    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "Untersuche das Projekt" }),
    );
    agent.next();
    agent.report(
        "PreToolUse",
        json!({ "tool_name": "Agent", "tool_input": { "description": "Datei a lesen", "subagent_type": "Explore" } }),
    );
    assert_eq!(
        agent.next().last_action.as_deref(),
        Some("Agent(Datei a lesen)")
    );

    // Zwei Subagenten lesen gleichzeitig.
    for (id, file) in [("a1", "a.txt"), ("b2", "b.txt")] {
        agent.report("SubagentStart", from_subagent(id, json!({})));
        agent.report("PreToolUse", from_subagent(id, read(file)));
        agent.report("PostToolUse", from_subagent(id, read(file)));
        agent.report("PostToolUseFailure", from_subagent(id, read(file)));
    }

    // Es ändern sich nur die Subagenten.
    agent.expect_only_subagents(AgentState::Working, Some("Agent(Datei a lesen)"));
}

#[test]
fn ein_hintergrund_subagent_laesst_den_fertigen_agenten_fertig() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "cargo test" } });

    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "Teste im Hintergrund" }),
    );
    agent.report("SubagentStart", from_subagent("a1", json!({})));
    agent.report(
        "Stop",
        json!({ "last_assistant_message": "Läuft im Hintergrund." }),
    );
    assert_eq!(settle(&agent).state, AgentState::Done);

    agent.report("PreToolUse", from_subagent("a1", bash.clone()));
    agent.report("PostToolUse", from_subagent("a1", bash));
    agent.report(
        "SubagentStop",
        from_subagent(
            "a1",
            json!({ "last_assistant_message": "Alle Tests grün." }),
        ),
    );

    agent.expect_only_subagents(AgentState::Done, Some("Läuft im Hintergrund."));
}

#[test]
fn das_ende_eines_subagenten_beendet_weder_arbeit_noch_auftrag_noch_gespraech() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 43" }));
    let started = agent.next();
    agent.report(
        "SubagentStop",
        from_subagent(
            "a1",
            json!({ "last_assistant_message": "Fertig.", "agent_transcript_path": "C:\\t\\agent-a1.jsonl" }),
        ),
    );
    // Auch die Nebenläufe von Claude Code ohne Typ melden ihr Ende.
    agent.report(
        "SubagentStop",
        json!({ "agent_id": "x9", "agent_type": "", "last_assistant_message": "Stay silent." }),
    );

    agent.expect_silence();
    assert_eq!(started.state, AgentState::Working);
    assert_eq!(started.assignment.as_deref(), Some("Baue Ticket 43"));
    assert_eq!(started.conversation.as_deref(), Some("abc123"));
}

#[test]
fn eine_rueckfrage_aus_einem_subagenten_laesst_den_agenten_warten() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "echo hallo > c.txt" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Schreibe c.txt" }));
    agent.report(
        "Stop",
        json!({ "last_assistant_message": "Der Subagent schreibt." }),
    );
    agent.next();
    assert_eq!(agent.next_state(), AgentState::Done);

    agent.report("PreToolUse", from_subagent("a1", bash.clone()));
    agent.report("PermissionRequest", from_subagent("a1", bash.clone()));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert!(update.state_changed);
    // Wonach der Subagent fragt, steht in seiner Zeile, nicht beim Agenten.
    assert_eq!(
        update.last_action.as_deref(),
        Some("Der Subagent schreibt.")
    );

    // Genehmigt: Der Subagent macht weiter, der Agent ist wieder fertig.
    agent.report("PostToolUse", from_subagent("a1", bash));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Done);
    assert_eq!(
        update.last_action.as_deref(),
        Some("Der Subagent schreibt.")
    );
}

/// Die Meldung, mit der Claude Code etwa sechs Sekunden nach einer
/// Genehmigungsabfrage noch einmal auf sie aufmerksam macht, ohne `agent_id`.
fn permission_notification() -> Value {
    json!({ "message": "Claude needs your permission", "notification_type": "permission_prompt" })
}

#[test]
fn die_spaete_meldung_einer_beantworteten_rueckfrage_laesst_den_agenten_fertig() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "echo x > d.txt" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Schreibe d.txt" }));
    launch(&agent, "a1", "general-purpose", "Spät schreiben", "t1");
    agent.report("Stop", json!({ "last_assistant_message": "Läuft." }));
    assert_eq!(settle(&agent).state, AgentState::Done);

    agent.report("PermissionRequest", from_subagent("a1", bash.clone()));
    assert_eq!(settle(&agent).state, AgentState::Waiting);
    // Schnell genehmigt, die Meldung von Claude Code kommt erst danach.
    agent.report("PostToolUse", from_subagent("a1", bash));
    assert_eq!(settle(&agent).state, AgentState::Done);
    agent.report("Notification", permission_notification());

    agent.expect_silence();
}

#[test]
fn die_spaete_meldung_einer_eigenen_beantworteten_rueckfrage_laesst_den_agenten_arbeiten() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Veröffentliche" }));
    agent.report("PermissionRequest", bash.clone());
    agent.report("PostToolUse", bash);
    assert_eq!(settle(&agent).state, AgentState::Working);
    agent.report("Notification", permission_notification());

    agent.expect_silence();
}

#[test]
fn eine_eigene_rueckfrage_des_agenten_geht_neben_der_eines_subagenten_nicht_verloren() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    launch(&agent, "a1", "general-purpose", "Veröffentlichen", "t1");
    agent.report("PermissionRequest", from_subagent("a1", bash.clone()));
    assert_eq!(settle(&agent).state, AgentState::Waiting);

    // Ein MCP-Server fragt den Agenten selbst; das meldet nur die Notification.
    agent.report(
        "Notification",
        json!({ "message": "Der Server braucht ein Token", "notification_type": "elicitation_dialog" }),
    );
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(
        update.last_action.as_deref(),
        Some("Der Server braucht ein Token")
    );

    // Die Rückfrage des Subagenten ist beantwortet, die des Agenten noch offen.
    agent.report("PostToolUse", from_subagent("a1", bash));
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(
        update.last_action.as_deref(),
        Some("Der Server braucht ein Token")
    );
}

#[test]
fn eine_eigene_genehmigung_des_agenten_geht_neben_der_eines_subagenten_nicht_verloren() {
    let agent = TestAgent::start();
    let push = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });
    let test = json!({ "tool_name": "Bash", "tool_input": { "command": "cargo test" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    launch(&agent, "a1", "general-purpose", "Veröffentlichen", "t1");
    agent.report("PermissionRequest", from_subagent("a1", push.clone()));
    agent.report("PermissionRequest", test);
    agent.report("Notification", permission_notification());
    agent.report("PostToolUse", from_subagent("a1", push));
    agent.report("Notification", permission_notification());

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.last_action.as_deref(), Some("Bash(cargo test)"));
}

#[test]
fn ein_prompt_der_person_beendet_offene_rueckfragen_von_subagenten() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    launch(&agent, "a1", "general-purpose", "Veröffentlichen", "t1");
    agent.report("Stop", json!({ "last_assistant_message": "Läuft." }));
    agent.report("PermissionRequest", from_subagent("a1", bash));
    assert_eq!(settle(&agent).state, AgentState::Waiting);

    // Abgelehnt, ohne dass Claude Code noch etwas vom Subagenten meldet.
    agent.report("UserPromptSubmit", json!({ "prompt": "Lass das" }));
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(subagent_states(&update), [SubagentState::Working]);
}

/// Ein Aufruf des `Agent`-Werkzeugs, wie ihn Claude Code vor dem Start meldet.
fn agent_call(description: &str, kind: &str, tool_use: &str) -> Value {
    json!({
        "tool_name": "Agent",
        "tool_use_id": tool_use,
        "tool_input": { "description": description, "subagent_type": kind },
    })
}

/// Die Beschreibungen der Subagenten in der Reihenfolge ihres Starts.
fn descriptions(update: &StatusUpdate) -> Vec<Option<String>> {
    update
        .subagents
        .iter()
        .map(|s| s.description.clone())
        .collect()
}

#[test]
fn ein_abgelehnter_aufruf_verschiebt_die_beschreibungen_nach_dem_naechsten_prompt_nicht() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    // Abgelehnt: Es kommen weder Start noch `PostToolUse`.
    agent.report("PreToolUse", agent_call("Abgelehnt", "Explore", "t1"));
    agent.report("UserPromptSubmit", json!({ "prompt": "Dann anders" }));
    agent.report("PreToolUse", agent_call("Datei a lesen", "Explore", "t2"));
    agent.report(
        "SubagentStart",
        json!({ "agent_id": "a1", "agent_type": "Explore" }),
    );

    assert_eq!(
        descriptions(&settle(&agent)),
        [Some("Datei a lesen".to_owned())]
    );
}

#[test]
fn ein_abgelehnter_aufruf_verfaellt_mit_dem_ende_der_antwort() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("PreToolUse", agent_call("Abgelehnt", "Explore", "t1"));
    agent.report("Stop", json!({ "last_assistant_message": "Gut." }));
    // Das Ende eines anderen Subagenten weckt den Agenten, er startet einen neuen.
    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "<task-notification>\n<task-id>x</task-id>\n</task-notification>" }),
    );
    agent.report("PreToolUse", agent_call("Datei b lesen", "Explore", "t2"));
    agent.report(
        "SubagentStart",
        json!({ "agent_id": "b2", "agent_type": "Explore" }),
    );

    assert_eq!(
        descriptions(&settle(&agent)),
        [Some("Datei b lesen".to_owned())]
    );
}

#[test]
fn eine_frage_eines_subagenten_steht_in_seiner_zeile() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    launch(&agent, "a1", "general-purpose", "Planen", "t1");
    agent.report(
        "PreToolUse",
        from_subagent(
            "a1",
            json!({
                "tool_name": "AskUserQuestion",
                "tool_input": { "questions": [{ "question": "Welche Datenbank?" }] },
            }),
        ),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.last_action.as_deref(), Some("Agent(Planen)"));
    assert_eq!(subagent_states(&update), [SubagentState::Waiting]);
    assert_eq!(
        update.subagents[0].last_action.as_deref(),
        Some("Welche Datenbank?")
    );
}

#[test]
fn eine_abgelehnte_rueckfrage_eines_subagenten_endet_mit_seinem_ende() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Veröffentliche" }));
    assert_eq!(agent.next_state(), AgentState::Working);
    agent.report("PermissionRequest", from_subagent("a1", bash));
    assert_eq!(agent.next_state(), AgentState::Waiting);
    // Ein anderer Subagent beendet das Warten nicht.
    agent.report("SubagentStop", from_subagent("b2", json!({})));
    agent.expect_silence();

    // Nach einer Ablehnung meldet Claude Code nur noch das Ende des Subagenten.
    agent.report("SubagentStop", from_subagent("a1", json!({})));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(update.last_action, None);
}

#[test]
fn solange_ein_subagent_fragt_wartet_der_agent_auch_nach_seiner_antwort() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("PermissionRequest", from_subagent("a1", bash.clone()));
    assert_eq!(agent.next_state(), AgentState::Working);
    assert_eq!(agent.next_state(), AgentState::Waiting);

    // Die Rückfrage steht weiter im Terminal, auch wenn der Agent antwortet
    // und Claude Code sie ohne Kennung des Subagenten noch einmal meldet.
    agent.report("Stop", json!({ "last_assistant_message": "Erledigt." }));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.last_action.as_deref(), Some("Erledigt."));
    agent.report("Notification", permission_notification());
    agent.expect_silence();

    // Beantwortet: Es gilt, was der Agent inzwischen gemeldet hat.
    agent.report("PostToolUse", from_subagent("a1", bash));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Done);
    assert_eq!(update.last_action.as_deref(), Some("Erledigt."));
}

#[test]
fn das_ende_eines_hintergrund_subagenten_weckt_den_agenten_ohne_neuen_auftrag() {
    let agent = TestAgent::start();
    let notification = "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n\
                        <summary>Agent \"Datei a lesen\" finished</summary>\n</task-notification>";

    // Nach `/clear` kann die Meldung eines Subagenten vor dem nächsten Prompt kommen.
    agent.report("UserPromptSubmit", json!({ "prompt": notification }));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(update.assignment, None);

    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 43" }));
    assert_eq!(agent.next().assignment.as_deref(), Some("Baue Ticket 43"));
}

/// Was die Person von einem Subagenten sieht: Kennung, Typ, Beschreibung, Zustand.
fn shown_subagents(update: &StatusUpdate) -> Vec<(String, String, Option<String>, SubagentState)> {
    update
        .subagents
        .iter()
        .map(|s| (s.id.clone(), s.kind.clone(), s.description.clone(), s.state))
        .collect()
}

/// Startet einen Subagenten so, wie Claude Code 2.1.330 es meldet.
fn launch(agent: &TestAgent, id: &str, kind: &str, description: &str, tool_use: &str) {
    let input = json!({ "description": description, "subagent_type": kind, "prompt": "…" });
    agent.report(
        "PreToolUse",
        json!({ "tool_name": "Agent", "tool_use_id": tool_use, "tool_input": input }),
    );
    agent.report(
        "SubagentStart",
        json!({ "agent_id": id, "agent_type": kind }),
    );
    agent.report(
        "PostToolUse",
        json!({
            "tool_name": "Agent",
            "tool_use_id": tool_use,
            "tool_input": input,
            "tool_response": { "status": "async_launched", "agentId": id, "description": description },
        }),
    );
}

#[test]
fn gestartete_subagenten_erscheinen_mit_beschreibung_beim_agenten() {
    let agent = TestAgent::start();

    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "Untersuche das Projekt" }),
    );
    launch(&agent, "a1", "Explore", "Datei a lesen", "t1");
    launch(&agent, "b2", "Explore", "Datei b lesen", "t2");

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(
        shown_subagents(&update),
        [
            (
                "a1".into(),
                "Explore".into(),
                Some("Datei a lesen".into()),
                SubagentState::Working
            ),
            (
                "b2".into(),
                "Explore".into(),
                Some("Datei b lesen".into()),
                SubagentState::Working
            ),
        ]
    );
}

#[test]
fn ein_ereignis_eines_fremden_ablaufs_legt_keinen_subagenten_an() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.next();
    // Die Nebenläufe von Claude Code melden nur ihr Ende, ohne Typ.
    agent.report(
        "SubagentStop",
        json!({ "agent_id": "x9", "agent_type": "", "last_assistant_message": "Stay silent." }),
    );
    agent.report(
        "SubagentStart",
        json!({ "agent_id": "x8", "agent_type": "" }),
    );

    agent.expect_silence();
}

#[test]
fn ein_ereignis_eines_subagenten_wird_seine_letzte_aktion() {
    let agent = TestAgent::start();
    let grep = json!({ "tool_name": "Grep", "tool_input": { "pattern": "agent_id" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Suche" }));
    launch(&agent, "a1", "Explore", "Felder finden", "t1");
    agent.report("PreToolUse", from_subagent("a1", grep.clone()));
    agent.report("PostToolUse", from_subagent("a1", grep));

    let update = settle(&agent);
    assert_eq!(
        update.subagents[0].last_action.as_deref(),
        Some("Grep(agent_id)")
    );
    // Die Aktion des Subagenten wird nicht die des Agenten.
    assert_eq!(update.last_action.as_deref(), Some("Agent(Felder finden)"));
}

/// Die Zustände der Subagenten in der Reihenfolge ihres Starts.
fn subagent_states(update: &StatusUpdate) -> Vec<SubagentState> {
    update.subagents.iter().map(|s| s.state).collect()
}

#[test]
fn nur_der_fragende_subagent_wartet_bis_zur_antwort() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "npm.cmd run check" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Prüfe alles" }));
    launch(
        &agent,
        "a1",
        "general-purpose",
        "Prüfung laufen lassen",
        "t1",
    );
    launch(&agent, "b2", "Explore", "Changelog lesen", "t2");
    settle(&agent);

    agent.report("PermissionRequest", from_subagent("a1", bash.clone()));
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(
        subagent_states(&update),
        [SubagentState::Waiting, SubagentState::Working]
    );
    assert_eq!(
        update.subagents[0].last_action.as_deref(),
        Some("Bash(npm.cmd run check)")
    );

    // Genehmigt: Der Subagent arbeitet wieder.
    agent.report("PostToolUse", from_subagent("a1", bash));
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(
        subagent_states(&update),
        [SubagentState::Working, SubagentState::Working]
    );
}

#[test]
fn ein_abgelehnter_subagent_ist_fertig() {
    let agent = TestAgent::start();
    let bash = json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } });

    agent.report("UserPromptSubmit", json!({ "prompt": "Veröffentliche" }));
    launch(&agent, "a1", "Explore", "Veröffentlichen", "t1");
    agent.report("PermissionRequest", from_subagent("a1", bash));
    assert_eq!(subagent_states(&settle(&agent)), [SubagentState::Waiting]);

    agent.report("SubagentStop", from_subagent("a1", json!({})));
    assert_eq!(subagent_states(&settle(&agent)), [SubagentState::Done]);
}

#[test]
fn ohne_bekannte_beschreibung_bleibt_der_typ() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report(
        "SubagentStart",
        json!({ "agent_id": "a1", "agent_type": "Explore" }),
    );

    let update = settle(&agent);
    assert_eq!(
        shown_subagents(&update),
        [("a1".into(), "Explore".into(), None, SubagentState::Working)]
    );
}

#[test]
fn startet_ein_subagent_ohne_spaetere_meldung_gilt_die_beschreibung_seines_aufrufs() {
    // Falls eine Fassung von Claude Code Subagenten wieder synchron startet,
    // kommt `PostToolUse(Agent)` erst an ihrem Ende.
    let agent = TestAgent::start();
    let call = |description: &str, kind: &str, id: &str| {
        json!({
            "tool_name": "Agent",
            "tool_use_id": id,
            "tool_input": { "description": description, "subagent_type": kind },
        })
    };

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("PreToolUse", call("Datei a lesen", "Explore", "t1"));
    agent.report("PreToolUse", call("Plan machen", "Plan", "t2"));
    agent.report("PreToolUse", call("Datei b lesen", "Explore", "t3"));
    for (id, kind) in [("p1", "Plan"), ("a1", "Explore"), ("b2", "Explore")] {
        agent.report(
            "SubagentStart",
            json!({ "agent_id": id, "agent_type": kind }),
        );
    }

    let update = settle(&agent);
    let descriptions: Vec<_> = update
        .subagents
        .iter()
        .map(|s| (s.id.as_str(), s.description.as_deref()))
        .collect();
    assert_eq!(
        descriptions,
        [
            ("p1", Some("Plan machen")),
            ("a1", Some("Datei a lesen")),
            ("b2", Some("Datei b lesen")),
        ]
    );
}

#[test]
fn ein_fertiger_subagent_bleibt_bis_zum_naechsten_prompt_stehen() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Untersuche" }));
    launch(&agent, "a1", "Explore", "Datei a lesen", "t1");
    launch(&agent, "b2", "Explore", "Im Hintergrund testen", "t2");
    agent.report(
        "SubagentStop",
        from_subagent(
            "a1",
            json!({ "last_assistant_message": "a enthält 3 Zeilen." }),
        ),
    );
    // Claude Code unterrichtet den Agenten; das ist kein Prompt der Person.
    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>" }),
    );
    agent.report(
        "Stop",
        json!({ "last_assistant_message": "a hat 3 Zeilen." }),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Done);
    let states: Vec<_> = update
        .subagents
        .iter()
        .map(|s| (s.id.as_str(), s.state))
        .collect();
    assert_eq!(
        states,
        [("a1", SubagentState::Done), ("b2", SubagentState::Working)]
    );
    assert_eq!(
        update.subagents[0].last_action.as_deref(),
        Some("a enthält 3 Zeilen.")
    );

    // Der nächste Prompt räumt die fertigen ab, der laufende bleibt.
    agent.report("UserPromptSubmit", json!({ "prompt": "Und jetzt?" }));
    let update = settle(&agent);
    let ids: Vec<_> = update.subagents.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["b2"]);
}

#[test]
fn die_uebergabe_eines_subagenten_ist_kein_prompt_der_person() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Untersuche" }));
    launch(&agent, "a1", "Explore", "Datei a lesen", "t1");
    launch(&agent, "b2", "Explore", "Datei b lesen", "t2");
    agent.report("SubagentStop", from_subagent("a1", json!({})));
    // Claude Code 2.1.330 meldet so, wenn der Subagent `SubagentHandback`
    // aufruft; sein `SubagentStop` folgt erst danach.
    agent.report(
        "UserPromptSubmit",
        json!({ "prompt": "<agent-message from=\"b2\">\n[Subagent hand-back] The text below is \
                            the final report of a subagent.\n</agent-message>" }),
    );
    agent.report("SubagentStop", from_subagent("b2", json!({})));

    let update = settle(&agent);
    assert_eq!(update.assignment.as_deref(), Some("Untersuche"));
    let states: Vec<_> = update
        .subagents
        .iter()
        .map(|s| (s.id.as_str(), s.state))
        .collect();
    assert_eq!(
        states,
        [("a1", SubagentState::Done), ("b2", SubagentState::Done)]
    );
}

#[test]
fn beendet_sich_der_agent_sind_seine_subagenten_fort() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    launch(&agent, "a1", "Explore", "Datei a lesen", "t1");
    agent.report("SessionEnd", json!({ "reason": "clear" }));

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Unknown);
    assert!(update.subagents.is_empty());
}

#[test]
fn ein_fehler_der_schnittstelle_beendet_die_arbeit() {
    let agent = TestAgent::start();

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
    let agent = TestAgent::start();
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
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);
    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Unknown);
    assert_eq!(update.last_action, None);
}

#[test]
fn der_erste_prompt_wird_zum_auftrag() {
    let agent = TestAgent::start();

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
    let agent = TestAgent::start();

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
    let agent = TestAgent::start();

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
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "  \n " }));
    agent.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 24" }));

    assert_eq!(agent.next().assignment, None);
    assert_eq!(agent.next().assignment.as_deref(), Some("Baue Ticket 24"));
}

#[test]
fn jeder_agent_hat_seinen_eigenen_auftrag() {
    let first = TestAgent::start();
    let second = TestAgent::start();

    first.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 24" }));
    second.report("UserPromptSubmit", json!({ "prompt": "Baue Ticket 25" }));

    assert_eq!(first.next().assignment.as_deref(), Some("Baue Ticket 24"));
    assert_eq!(second.next().assignment.as_deref(), Some("Baue Ticket 25"));
}

// `SessionStart` meldet Claude Code nur an Befehls-Hooks; der Befehls-Hook der
// Konfiguration reicht es an den Empfänger weiter (Tests weiter unten).

#[test]
fn beim_start_wartet_der_agent_mit_seinem_gespraech() {
    let agent = TestAgent::start();

    agent.report(
        "SessionStart",
        json!({ "session_id": "gespraech-1", "source": "startup" }),
    );

    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert!(update.state_changed);
    assert_eq!(update.last_action, None);
    assert_eq!(update.conversation.as_deref(), Some("gespraech-1"));
    assert_eq!(update.assignment, None);
}

#[test]
fn ein_verspaetetes_sessionstart_laesst_den_arbeitenden_agenten_arbeiten() {
    // Der Befehls-Hook läuft im Hintergrund; tippt die Person schnell, kommt
    // der erste Prompt vor `SessionStart` an.
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);

    agent.report("SessionStart", json!({ "source": "startup" }));

    agent.expect_silence();
}

#[test]
fn ein_sessionstart_nach_dem_ende_seiner_sitzung_erweckt_den_agenten_nicht() {
    // Beendet die Person Claude Code gleich nach dem Start, kann das
    // `SessionEnd` vor dem `SessionStart` aus dem Befehls-Hook ankommen.
    for agent in [TestAgent::start(), resumed()] {
        agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
        agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));
        settle(&agent);

        agent.report("SessionStart", json!({ "source": "startup" }));

        agent.expect_silence();
    }
}

#[test]
fn wird_dasselbe_gespraech_spaeter_neu_gestartet_wartet_der_agent_wieder() {
    // Etwa `/exit` und dann `claude -c` im selben Terminal. Länger als die
    // Laufzeit eines Hooks (5 s) nach dem Ende kann kein verspätetes
    // `SessionStart` mehr kommen.
    let agent = TestAgent::start();
    agent.report("SessionStart", json!({ "source": "startup" }));
    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));
    settle(&agent);
    std::thread::sleep(Duration::from_millis(5100));

    agent.report("SessionStart", json!({ "source": "resume" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.conversation.as_deref(), Some("abc123"));
}

#[test]
fn sessionstart_nach_compact_aendert_den_status_nicht() {
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("Stop", json!({ "last_assistant_message": "Erledigt." }));
    settle(&agent);

    agent.report("SessionStart", json!({ "source": "compact" }));

    agent.expect_silence();
}

#[test]
fn nach_dem_leeren_wartet_der_agent_mit_dem_neuen_gespraech() {
    let agent = TestAgent::start();
    agent.report(
        "UserPromptSubmit",
        json!({ "session_id": "alt", "prompt": "Los" }),
    );
    agent.report(
        "SessionEnd",
        json!({ "session_id": "alt", "reason": "clear" }),
    );
    settle(&agent);

    agent.report(
        "SessionStart",
        json!({ "session_id": "neu", "source": "clear" }),
    );

    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.conversation.as_deref(), Some("neu"));
}

#[test]
fn ein_fortgesetzter_agent_wartet_mit_sessionstart_im_alten_gespraech() {
    let agent = resumed();

    agent.report("SessionStart", json!({ "source": "resume" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.conversation.as_deref(), Some("abc123"));
    assert_eq!(update.assignment.as_deref(), Some("Baue Ticket 24"));
}

// Ohne `SessionStart`, etwa wenn der Befehls-Hook nicht laufen kann, ist das
// Gespräch mit der ersten Meldung bekannt, in der Regel dem ersten Prompt.
#[test]
fn das_gespraech_ist_mit_dem_ersten_prompt_bekannt() {
    let agent = TestAgent::start();

    agent.report(
        "UserPromptSubmit",
        json!({ "session_id": "gespraech-1", "prompt": "Baue Ticket 24" }),
    );

    assert_eq!(agent.next().conversation.as_deref(), Some("gespraech-1"));
}

#[test]
fn nach_dem_leeren_gilt_das_neue_gespraech() {
    let agent = TestAgent::start();

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
        "UserPromptSubmit",
        json!({ "session_id": "neu", "prompt": "Baue Ticket 25" }),
    );

    let update = agent.next();
    assert_eq!(update.conversation.as_deref(), Some("neu"));
    assert_eq!(update.assignment.as_deref(), Some("Baue Ticket 25"));
}

#[test]
fn beendet_sich_der_agent_gibt_es_kein_gespraech_mehr() {
    let agent = TestAgent::start();

    agent.report(
        "UserPromptSubmit",
        json!({ "session_id": "laufend", "prompt": "Los" }),
    );
    assert_eq!(agent.next().conversation.as_deref(), Some("laufend"));
    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));

    assert_eq!(agent.next().conversation, None);
}

/// Ein Agent, der das Gespräch `abc123` mit dem Auftrag „Baue Ticket 24“ fortsetzt.
fn resumed() -> TestAgent {
    TestAgent::resume(Resumed {
        conversation: "abc123".into(),
        assignment: Some("Baue Ticket 24".into()),
    })
}

#[test]
fn ein_fortgesetzter_agent_behaelt_gespraech_und_auftrag() {
    let agent = resumed();

    // Claude Code meldet beim Fortsetzen dieselbe Kennung.
    agent.report("UserPromptSubmit", json!({ "prompt": "Mach weiter" }));

    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(update.conversation.as_deref(), Some("abc123"));
    assert_eq!(update.assignment.as_deref(), Some("Baue Ticket 24"));
}

#[test]
fn jedes_ende_ausser_dem_leeren_beendet_die_sitzung() {
    for reason in [
        "prompt_input_exit",
        "logout",
        "other",
        "bypass_permissions_disabled",
    ] {
        let agent = TestAgent::start();
        agent.report(
            "UserPromptSubmit",
            json!({ "session_id": "laufend", "prompt": "Los" }),
        );
        agent.next();

        agent.report("SessionEnd", json!({ "reason": reason }));

        let update = agent.next();
        assert!(update.session_ended, "{reason}");
        assert_eq!(update.state, AgentState::Unknown);
        assert_eq!(update.conversation, None);
        assert_eq!(update.assignment, None);
    }
}

#[test]
fn leeren_oder_wechseln_des_gespraechs_beendet_die_sitzung_nicht() {
    // `/clear` leert das Gespräch, `/resume` wechselt es; Claude Code läuft weiter.
    for reason in ["clear", "resume"] {
        let agent = TestAgent::start();
        agent.report(
            "UserPromptSubmit",
            json!({ "session_id": "alt", "prompt": "Baue Ticket 24" }),
        );
        agent.next();

        agent.report(
            "SessionEnd",
            json!({ "session_id": "alt", "reason": reason }),
        );

        let update = agent.next();
        assert!(!update.session_ended, "{reason}");
        assert_eq!(update.state, AgentState::Unknown);
        assert_eq!(update.conversation, None);
        assert_eq!(update.assignment, None);
    }
}

#[test]
fn das_ende_einer_sitzung_kommt_auch_ohne_vorherige_meldung_an() {
    // Etwa `claude` und gleich `/exit`, bevor `SessionStart` ankam: Der Tab
    // ist vielleicht schon Agent, und nur diese Meldung macht ihn wieder zum
    // Terminal.
    let agent = TestAgent::start();

    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));

    assert!(agent.next().session_ended);
}

#[test]
fn laesst_sich_das_gespraech_nicht_fortsetzen_ist_die_sitzung_beendet() {
    let agent = resumed();

    // So meldet Claude Code ein Gespräch, das es nicht mehr gibt.
    agent.report("SessionEnd", json!({ "reason": "other" }));

    let update = agent.next();
    assert!(update.session_ended);
    assert_eq!(update.conversation, None);
    assert_eq!(update.assignment, None);
}

// Kehrt das Programm `claude` zurück, meldet die Shell-Funktion das Ende
// selbst, auch nach einem Absturz ohne `SessionEnd` (ADR 0006).

#[test]
fn kehrt_claude_ohne_sessionend_zurueck_ist_die_sitzung_beendet() {
    for agent in [TestAgent::start(), resumed()] {
        agent.report(
            "UserPromptSubmit",
            json!({ "session_id": "laufend", "prompt": "Los" }),
        );
        agent.next();

        agent.claude_exited();

        let update = agent.next();
        assert!(update.session_ended);
        assert_eq!(update.state, AgentState::Unknown);
        assert_eq!(update.conversation, None);
        assert_eq!(update.assignment, None);
    }
}

#[test]
fn kehrt_claude_vor_jeder_meldung_zurueck_ist_die_sitzung_beendet() {
    // Etwa ein Absturz gleich beim Start eines Agenten, den Kredr gestartet
    // hat: Nur diese Meldung macht den Tab wieder zum Terminal.
    for agent in [TestAgent::start(), resumed()] {
        agent.claude_exited();

        assert!(agent.next().session_ended);
    }
}

#[test]
fn kehrt_claude_nach_sessionend_zurueck_passiert_nichts_weiter() {
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("SessionEnd", json!({ "reason": "prompt_input_exit" }));
    settle(&agent);

    agent.claude_exited();

    agent.expect_silence();
}

#[test]
fn kehrt_claude_zweimal_zurueck_endet_die_sitzung_nur_einmal() {
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.claude_exited();
    settle(&agent);

    agent.claude_exited();

    agent.expect_silence();
}

#[test]
fn nach_der_rueckkehr_von_claude_entsteht_im_selben_terminal_ein_neuer_agent() {
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.claude_exited();
    settle(&agent);

    agent.report(
        "SessionStart",
        json!({ "session_id": "zweite", "source": "startup" }),
    );
    let update = agent.next();
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.conversation.as_deref(), Some("zweite"));

    agent.claude_exited();
    assert!(agent.next().session_ended);
}

#[test]
fn ein_sessionstart_nach_der_rueckkehr_von_claude_erweckt_den_agenten_nicht() {
    // Stürzt Claude Code gleich nach dem Start ab, kann das `SessionStart`
    // aus dem Befehls-Hook erst nach der Meldung der Shell-Funktion ankommen.
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.claude_exited();
    settle(&agent);

    agent.report("SessionStart", json!({ "source": "startup" }));

    agent.expect_silence();
}

#[test]
fn nach_dem_ende_entsteht_im_selben_terminal_ein_neuer_agent() {
    let agent = TestAgent::start();
    agent.report(
        "UserPromptSubmit",
        json!({ "session_id": "erste", "prompt": "Los" }),
    );
    agent.report(
        "SessionEnd",
        json!({ "session_id": "erste", "reason": "prompt_input_exit" }),
    );
    settle(&agent);

    agent.report(
        "SessionStart",
        json!({ "session_id": "zweite", "source": "startup" }),
    );

    let update = agent.next();
    assert!(!update.session_ended);
    assert_eq!(update.state, AgentState::Waiting);
    assert_eq!(update.conversation.as_deref(), Some("zweite"));
}

#[test]
fn zwei_agenten_haben_jeder_ihren_eigenen_status() {
    let first = TestAgent::start();
    let second = TestAgent::start();

    first.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    second.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    second.report("Stop", json!({ "last_assistant_message": "Erledigt." }));

    assert_eq!(first.next_state(), AgentState::Working);
    first.expect_silence();
    assert_eq!(second.next_state(), AgentState::Working);
    assert_eq!(second.next_state(), AgentState::Done);
}

#[test]
fn unbekannte_meldungen_aendern_nichts() {
    let mut agent = TrackedAgent::new(None);

    let update = agent.on_event(&json!({ "hook_event_name": "PostCompact" }));

    assert_eq!(update, None);
}

#[test]
fn endet_das_terminal_ist_der_status_unbekannt() {
    let agent = TestAgent::start();
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    assert_eq!(agent.next_state(), AgentState::Working);

    let update = agent.forget().expect("Eine Statusmeldung sollte kommen");

    assert_eq!(update.state, AgentState::Unknown);
    assert!(update.state_changed);
    assert_eq!(update.assignment, None);
    assert_eq!(update.conversation, None);
    // Weiß Kredr noch nichts, ändert sich für die Person nichts.
    assert_eq!(TestAgent::start().forget(), None);
}

// Hintergrundaufgaben: Die Ereignisse sind die, die Claude Code 2.1.330
// gemeldet hat (#68, #69).

/// Eine laufende Shell im Hintergrund, wie `Stop` sie in `background_tasks` meldet.
fn running_shell(id: &str, description: &str, command: &str) -> Value {
    json!({ "id": id, "type": "shell", "status": "running",
            "description": description, "command": command })
}

/// Das Ende der Antwort mit der Liste der Hintergrundaufgaben `tasks`.
fn stop_with(agent: &TestAgent, tasks: Value) {
    agent.report(
        "Stop",
        json!({ "last_assistant_message": "gestartet", "background_tasks": tasks, "session_crons": [] }),
    );
}

#[test]
fn laeuft_nach_der_antwort_eine_hintergrundaufgabe_ist_der_agent_im_hintergrund() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Beobachte die CI" }));
    stop_with(
        &agent,
        json!([running_shell(
            "bz10kzu5q",
            "Run sleep 20 and echo fertig in background",
            "sleep 20; echo fertig"
        )]),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Background);
    assert!(update.state_changed);
    assert_eq!(update.last_action.as_deref(), Some("gestartet"));
    assert_eq!(
        update.background_tasks,
        vec![BackgroundTask {
            id: "bz10kzu5q".to_owned(),
            kind: "shell".to_owned(),
            description: Some("Run sleep 20 and echo fertig in background".to_owned()),
            command: Some("sleep 20; echo fertig".to_owned()),
        }]
    );
}

/// Die Kennungen der Hintergrundaufgaben einer Meldung.
fn task_ids(update: &StatusUpdate) -> Vec<&str> {
    update
        .background_tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect()
}

#[test]
fn es_zaehlen_alle_laufenden_hintergrundaufgaben_ausser_subagenten() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report(
        "Stop",
        json!({
            "last_assistant_message": "gestartet",
            "background_tasks": [
                { "id": "a1", "type": "subagent", "status": "running", "agent_type": "Explore", "description": "Lesen" },
                { "id": "m1", "type": "monitor", "status": "running", "description": "Log beobachten", "command": "tail -f log" },
                { "id": "x1", "type": "kuenftig", "status": "running", "description": "Neuer Typ" },
                { "id": "b1", "type": "shell", "status": "completed", "description": "Schon fertig", "command": "echo" },
            ],
            "session_crons": [{ "id": "c1", "cron": "*/5 * * * *", "prompt": "Prüfe" }],
        }),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Background);
    assert_eq!(task_ids(&update), ["m1", "x1"]);
    assert_eq!(update.background_tasks[1].command, None);
}

#[test]
fn nur_ein_hintergrund_subagent_oder_eine_geplante_aufgabe_laesst_den_agenten_fertig() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report(
        "Stop",
        json!({
            "last_assistant_message": "gestartet",
            "background_tasks": [{ "id": "a1", "type": "subagent", "status": "running", "agent_type": "general-purpose" }],
            "session_crons": [{ "id": "c1", "cron": "*/5 * * * *", "prompt": "Prüfe" }],
        }),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Done);
    assert!(update.background_tasks.is_empty());
}

#[test]
fn im_hintergrund_ersetzt_nur_fertig() {
    let agent = TestAgent::start();
    let shell = json!([running_shell("b1", "CI beobachten", "gh run watch 4711")]);

    agent.report("UserPromptSubmit", json!({ "prompt": "Beobachte die CI" }));
    stop_with(&agent, shell.clone());
    assert_eq!(settle(&agent).state, AgentState::Background);

    // Ein neuer Prompt lässt ihn arbeiten, die Hintergrundaufgabe läuft weiter.
    agent.report("UserPromptSubmit", json!({ "prompt": "Und jetzt?" }));
    let update = agent.next();
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(task_ids(&update), ["b1"]);

    // Eine Rückfrage lässt ihn warten.
    agent.report(
        "PermissionRequest",
        json!({ "tool_name": "Bash", "tool_input": { "command": "git push" } }),
    );
    assert_eq!(agent.next_state(), AgentState::Waiting);

    // Eine Rückfrage eines Subagenten nach der Antwort lässt ihn ebenfalls warten.
    stop_with(&agent, shell);
    assert_eq!(settle(&agent).state, AgentState::Background);
    agent.report("SubagentStart", from_subagent("a1", json!({})));
    agent.report(
        "PermissionRequest",
        from_subagent(
            "a1",
            json!({ "tool_name": "Bash", "tool_input": { "command": "rm x" } }),
        ),
    );
    assert_eq!(settle(&agent).state, AgentState::Waiting);
}

#[test]
fn endet_die_letzte_hintergrundaufgabe_ist_der_agent_mit_dem_naechsten_stop_fertig() {
    let agent = TestAgent::start();
    let notification = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";

    agent.report("UserPromptSubmit", json!({ "prompt": "Beobachte die CI" }));
    stop_with(
        &agent,
        json!([running_shell("b1", "CI beobachten", "gh run watch 4711")]),
    );
    assert_eq!(settle(&agent).state, AgentState::Background);

    agent.report("UserPromptSubmit", json!({ "prompt": notification }));
    assert_eq!(agent.next_state(), AgentState::Working);
    stop_with(&agent, json!([]));

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Done);
    assert!(update.background_tasks.is_empty());
}

/// Ein Aufruf von Bash mit `run_in_background`, wie `PostToolUse` ihn meldet;
/// `fields` ergänzt die Antwort des Werkzeugs.
fn background_bash(command: &str, description: &str, task: &str, fields: Value) -> Value {
    let mut response = json!({
        "stdout": "", "stderr": "", "interrupted": false, "isImage": false,
        "noOutputExpected": false, "backgroundTaskId": task,
    });
    for (key, value) in fields.as_object().expect("Felder als Objekt") {
        response[key] = value.clone();
    }
    json!({
        "tool_name": "Bash",
        "tool_input": { "command": command, "description": description, "run_in_background": true },
        "tool_response": response,
    })
}

#[test]
fn nach_einem_abbruch_mit_esc_ist_eine_gestartete_hintergrundaufgabe_bekannt() {
    let agent = TestAgent::start();
    let idle = json!({ "message": "Claude is waiting for your input", "notification_type": "idle_prompt" });

    agent.report("UserPromptSubmit", json!({ "prompt": "Beobachte die CI" }));
    agent.report(
        "PostToolUse",
        background_bash("gh run watch 4711", "CI beobachten", "b1", json!({})),
    );
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(
        update.background_tasks,
        vec![BackgroundTask {
            id: "b1".to_owned(),
            kind: "shell".to_owned(),
            description: Some("CI beobachten".to_owned()),
            command: Some("gh run watch 4711".to_owned()),
        }]
    );

    // Esc: Claude Code meldet kein `Stop`, nur später `idle_prompt`.
    agent.report("Notification", idle.clone());
    assert_eq!(agent.next_state(), AgentState::Background);

    // Die zuletzt bekannte Liste gilt weiter.
    agent.report("Notification", idle);
    agent.expect_silence();
}

#[test]
fn eine_hintergrundaufgabe_die_mit_ihrem_subagenten_endet_zaehlt_nicht() {
    let agent = TestAgent::start();

    // Gemessen: Ein Subagent im Vordergrund startet eine Shell im
    // Hintergrund. Sie steht in seinem `SubagentStop` und endet mit ihm.
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("SubagentStart", from_subagent("a1", json!({})));
    agent.report(
        "PostToolUse",
        from_subagent(
            "a1",
            background_bash(
                "sleep 35 ; echo sub-done",
                "Sleep 35 seconds",
                "b2",
                json!({ "backgroundEndsWithFinalResponse": true }),
            ),
        ),
    );
    agent.report(
        "SubagentStop",
        from_subagent(
            "a1",
            json!({ "background_tasks": [running_shell("b2", "Sleep 35 seconds", "sleep 35 ; echo sub-done")] }),
        ),
    );
    agent.report(
        "Notification",
        json!({ "message": "Claude is waiting for your input", "notification_type": "idle_prompt" }),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Done);
    assert!(update.background_tasks.is_empty());
}

#[test]
fn die_hintergrundaufgabe_eines_hintergrund_subagenten_die_ihn_ueberdauert_zaehlt() {
    let agent = TestAgent::start();

    // Gemessen: Ein Subagent im Hintergrund startet eine Shell, die ihn
    // überdauert; das nächste `Stop` des Agenten nennt sie als `shell`.
    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    agent.report("SubagentStart", from_subagent("a1", json!({})));
    agent.report(
        "Stop",
        json!({ "background_tasks": [{ "id": "a1", "type": "subagent", "status": "running" }] }),
    );
    assert_eq!(settle(&agent).state, AgentState::Done);

    agent.report(
        "PostToolUse",
        from_subagent(
            "a1",
            background_bash("sleep 40", "Sleep 40 seconds", "b3", json!({})),
        ),
    );
    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Background);
    assert_eq!(task_ids(&update), ["b3"]);
}

#[test]
fn ein_hintergrund_subagent_ist_keine_hintergrundaufgabe() {
    let agent = TestAgent::start();

    agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
    launch(&agent, "a1", "Explore", "Datei a lesen", "t1");
    agent.report(
        "Notification",
        json!({ "message": "Claude is waiting for your input", "notification_type": "idle_prompt" }),
    );

    let update = settle(&agent);
    assert_eq!(update.state, AgentState::Done);
    assert!(update.background_tasks.is_empty());
}

#[test]
fn sessionend_und_das_ende_des_terminals_raeumen_die_hintergrundaufgaben_weg() {
    for end in ["SessionEnd", "forget"] {
        let agent = TestAgent::start();
        agent.report("UserPromptSubmit", json!({ "prompt": "Los" }));
        stop_with(
            &agent,
            json!([running_shell("b1", "CI beobachten", "gh run watch 4711")]),
        );
        assert_eq!(settle(&agent).state, AgentState::Background);

        let update = if end == "forget" {
            agent.forget().expect("Eine Statusmeldung sollte kommen")
        } else {
            // Auch `/clear` endet so.
            agent.report("SessionEnd", json!({ "reason": "clear" }));
            agent.next()
        };
        assert_eq!(update.state, AgentState::Unknown, "{end}");
        assert!(update.background_tasks.is_empty(), "{end}");

        // Nach `/clear` beginnt das neue Gespräch ohne die alten Hintergrundaufgaben.
        agent.report("UserPromptSubmit", json!({ "prompt": "Neu" }));
        agent.report("Stop", json!({ "last_assistant_message": "fertig" }));
        let update = settle(&agent);
        assert_eq!(update.state, AgentState::Done, "{end}");
        assert!(update.background_tasks.is_empty(), "{end}");
    }
}

// Der Empfang: Die folgenden Tests schicken die Meldungen per HTTP. Der
// Empfänger ruft den Listener auf, bevor er antwortet; nach `post` ist also
// jede Meldung schon da, und `try_recv` prüft genau.

/// Ein angemeldetes Terminal aus Sicht des Tests: die Konfiguration, die sein
/// Agent beim Start mitbekommt, und die Meldungen an seinen Listener.
struct Registered {
    hooks: TerminalHooks,
    settings: PathBuf,
    updates: Receiver<StatusUpdate>,
}

impl Registered {
    fn new(status: &AgentStatus, terminal: u32) -> Registered {
        let (sender, updates) = channel();
        let hooks = status
            .register(terminal, None, move |update| {
                let _ = sender.send(update);
            })
            .expect("Die Konfiguration sollte sich anlegen lassen");
        Registered {
            settings: hooks.settings.clone(),
            hooks,
            updates,
        }
    }

    /// Schickt `body` an die Adresse, die in der Konfiguration für `event`
    /// steht, und liefert den Statuscode der Antwort.
    fn post(&self, event: &str, body: &str) -> u16 {
        let url = hook_url(&self.settings, event)
            .unwrap_or_else(|| panic!("Für {event} sollte ein Hook eingetragen sein"));
        post(&url, body)
    }

    /// Erwartet, dass keine Meldung angekommen ist. Nach `forget` ist der
    /// Listener fort; auch dann kommt nichts mehr.
    fn expect_silence(&self) {
        if let Ok(update) = self.updates.try_recv() {
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

/// Ein Prompt der Person als Inhalt einer Meldung.
fn prompt_body() -> String {
    hook_event("UserPromptSubmit", json!({ "prompt": "Los" })).to_string()
}

#[test]
fn der_empfang_weist_meldungen_ohne_gueltiges_kennwort_ab() {
    let status = AgentStatus::start(runtime_folder("kennwort"), no_task_outputs()).unwrap();
    let terminal = Registered::new(&status, 1);
    let url = hook_url(&terminal.settings, "UserPromptSubmit").unwrap();
    let (base, _token) = url.rsplit_once('/').unwrap();

    let code = post(&format!("{base}/geraten"), &prompt_body());

    assert_eq!(code, 404);
    terminal.expect_silence();
}

#[test]
fn die_konfiguration_nennt_alle_ereignisse_mit_hooks_an_den_eigenen_rechner() {
    let folder = runtime_folder("konfiguration");
    let status = AgentStatus::start(folder.clone(), no_task_outputs()).unwrap();
    let terminal = Registered::new(&status, 7);

    assert!(terminal.settings.starts_with(&folder));
    let text = std::fs::read_to_string(&terminal.settings).unwrap();
    let settings: Value = serde_json::from_str(&text).unwrap();
    let keys: Vec<&String> = settings.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["hooks"]);
    let hooks = settings["hooks"].as_object().unwrap();
    // Jedes Ereignis, das der Agentenstatus auswertet.
    let mut events: Vec<&str> = hooks.keys().map(String::as_str).collect();
    events.sort();
    assert_eq!(
        events,
        [
            "Notification",
            "PermissionRequest",
            "PostToolUse",
            "PostToolUseFailure",
            "PreToolUse",
            "SessionEnd",
            "SessionStart",
            "Stop",
            "StopFailure",
            "SubagentStart",
            "SubagentStop",
            "UserPromptSubmit",
        ]
    );
    for (event, entries) in hooks {
        // `SessionStart` meldet Claude Code nur an Befehls-Hooks (Tests unten).
        if event == "SessionStart" {
            continue;
        }
        for entry in entries.as_array().unwrap() {
            for hook in entry["hooks"].as_array().unwrap() {
                assert_eq!(hook["type"], "http", "{event}");
                let url = hook["url"].as_str().unwrap();
                assert!(url.starts_with("http://127.0.0.1:"), "{event}: {url}");
            }
        }
    }
}

#[test]
fn nach_dem_vergessen_weist_der_empfang_meldungen_ab() {
    let status = AgentStatus::start(runtime_folder("terminal-endet"), no_task_outputs()).unwrap();
    let terminal = Registered::new(&status, 1);
    let url = hook_url(&terminal.settings, "Stop").unwrap();
    assert_eq!(terminal.post("UserPromptSubmit", &prompt_body()), 200);
    assert_eq!(
        terminal.updates.try_recv().unwrap().state,
        AgentState::Working
    );

    status.forget(1);

    assert_eq!(
        terminal.updates.try_recv().unwrap().state,
        AgentState::Unknown
    );
    assert!(!terminal.settings.exists());
    // Ein Nachzügler des beendeten Agenten findet kein Terminal mehr.
    let stop = hook_event("Stop", json!({ "last_assistant_message": "Fertig." }));
    assert_eq!(post(&url, &stop.to_string()), 404);
    terminal.expect_silence();
}

#[test]
fn eine_meldung_erreicht_nur_den_listener_ihres_terminals() {
    // Zwei Kredr-Prozesse, etwa die Entwicklungsfassung neben der
    // installierten, haben je einen eigenen Empfänger; ihre
    // Terminal-Kennungen können sich gleichen. Alle Fenster eines Prozesses
    // teilen sich einen Empfänger, jedes Terminal hat darin seine eigene
    // Adresse.
    let process_a = AgentStatus::start(runtime_folder("prozess-a"), no_task_outputs()).unwrap();
    let process_b = AgentStatus::start(runtime_folder("prozess-b"), no_task_outputs()).unwrap();
    let first = Registered::new(&process_a, 1);
    let second = Registered::new(&process_a, 2);
    let other = Registered::new(&process_b, 1);
    assert_ne!(first.settings, second.settings);

    // Was sich nicht lesen lässt, nimmt der Empfang still an: Claude Code
    // darf davon nichts merken.
    assert_eq!(second.post("UserPromptSubmit", "kein json"), 200);
    second.expect_silence();
    assert_eq!(second.post("UserPromptSubmit", &prompt_body()), 200);

    let update = second
        .updates
        .try_recv()
        .expect("Die Meldung sollte da sein");
    assert_eq!(update.state, AgentState::Working);
    assert_eq!(update.assignment.as_deref(), Some("Los"));
    // Weder ein anderes Terminal desselben Prozesses noch das Terminal mit
    // derselben Kennung im anderen Prozess erfährt davon.
    first.expect_silence();
    other.expect_silence();
}

// Der Befehls-Hook für `SessionStart`: Claude Code führt ihn in der Shell aus,
// die es für Hooks benutzt, und gibt ihm das Ereignis auf der Standardeingabe.

/// Der Befehl, den die Konfiguration für `SessionStart` einträgt.
fn session_start_command(settings: &Path) -> String {
    let text = std::fs::read_to_string(settings).unwrap();
    let settings: Value = serde_json::from_str(&text).unwrap();
    let hook = &settings["hooks"]["SessionStart"][0]["hooks"][0];
    assert_eq!(hook["type"], "command");
    // Claude Code wartet nicht auf ihn.
    assert_eq!(hook["async"], true);
    hook["command"].as_str().unwrap().to_owned()
}

/// Eine Shell, in der Claude Code einen Befehls-Hook ausführen kann.
struct HookShell {
    name: &'static str,
    program: PathBuf,
    /// Was vor dem Befehl steht.
    args: &'static [&'static str],
}

/// Die Shells, in denen Claude Code den Hook ausführen kann.
fn hook_shells() -> Vec<HookShell> {
    let mut shells = vec![HookShell {
        name: "PowerShell",
        program: "powershell.exe".into(),
        args: &["-NoProfile", "-Command"],
    }];
    match git_bash() {
        Some(bash) => shells.push(HookShell {
            name: "Git Bash",
            program: bash,
            args: &["-c"],
        }),
        None => eprintln!("Git Bash wurde nicht gefunden; nur PowerShell geprüft"),
    }
    shells
}

/// Führt `command` mit `shell` aus, `input` auf der Standardeingabe. Liefert,
/// ob er gelang, und wie lange er brauchte.
fn run_hook(shell: &HookShell, command: &str, input: &str) -> (bool, Duration) {
    use std::process::{Command, Stdio};
    let started = Instant::now();
    let mut child = Command::new(&shell.program)
        .args(shell.args)
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Die Shell sollte starten");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let errors = String::from_utf8_lossy(&output.stderr);
    assert!(errors.trim().is_empty(), "Fehlerausgabe: {errors}");
    (output.status.success(), started.elapsed())
}

#[test]
fn sessionstart_kommt_ueber_den_befehls_hook_beim_richtigen_terminal_an() {
    let status = AgentStatus::start(runtime_folder("sessionstart"), no_task_outputs()).unwrap();
    let other = Registered::new(&status, 1);
    let terminal = Registered::new(&status, 2);
    let command = session_start_command(&terminal.settings);

    for shell in hook_shells() {
        let name = shell.name;
        // Die Meldung kommt als UTF-8, auch mit Umlauten.
        let event = hook_event(
            "SessionStart",
            json!({ "session_id": format!("gespräch-{name}"), "source": "startup" }),
        );
        let (success, _) = run_hook(&shell, &command, &event.to_string());

        assert!(success, "{name}");
        let update = terminal.wait();
        assert_eq!(update.state, AgentState::Waiting, "{name}");
        let conversation = format!("gespräch-{name}");
        assert_eq!(update.conversation.as_deref(), Some(conversation.as_str()));
        // Für die nächste Shell beginnt die Sitzung neu.
        let end = hook_event("SessionEnd", json!({ "reason": "clear" }));
        assert_eq!(terminal.post("SessionEnd", &end.to_string()), 200);
        assert_eq!(terminal.wait().state, AgentState::Unknown);
    }
    other.expect_silence();
}

#[test]
fn ohne_empfaenger_scheitert_der_befehls_hook_nicht() {
    let status = AgentStatus::start(runtime_folder("ohne-empfaenger"), no_task_outputs()).unwrap();
    let terminal = Registered::new(&status, 1);
    let command = session_start_command(&terminal.settings);
    let event = hook_event("SessionStart", json!({ "source": "startup" })).to_string();

    // Erst ist das Terminal abgemeldet, dann ist Kredr ganz fort.
    status.forget(1);
    let mut outcomes = Vec::new();
    for shell in hook_shells() {
        let name = shell.name;
        outcomes.push((name, run_hook(&shell, &command, &event)));
    }
    drop(status);
    for shell in hook_shells() {
        let name = shell.name;
        outcomes.push((name, run_hook(&shell, &command, &event)));
    }

    for (name, (success, took)) in outcomes {
        assert!(success, "{name}");
        assert!(took < Duration::from_secs(5), "{name}: {took:?}");
    }
}

// Die Ausgabedateien der Hintergrundaufgaben: Ein Abbruch über `/tasks`
// meldet Claude Code nicht. Die Tests legen die Dateien selbst an, so wie
// Claude Code 2.1.330 sie schreibt.

/// Ein Ordner ohne Ausgabedateien für Tests, die sie nicht brauchen.
fn no_task_outputs() -> PathBuf {
    std::env::temp_dir().join("kredr-test-agentenstatus-ohne-ausgabedateien")
}

/// Die Ausgabedatei der Aufgabe `task` im Ordner `claude` (steht für
/// `%TEMP%\claude`): darunter ein Ordner je Projekt, darin einer je Gespräch.
fn task_output(claude: &Path, session: &str, task: &str) -> PathBuf {
    let tasks = claude.join("cd89d0ef490bcaf1").join(session).join("tasks");
    std::fs::create_dir_all(&tasks).unwrap();
    tasks.join(format!("{task}.output"))
}

/// Ein Empfänger, der die Ausgabedateien in seinem eigenen Ordner `claude`
/// sucht, mit einem angemeldeten Terminal.
fn with_task_outputs(name: &str) -> (PathBuf, AgentStatus, Registered) {
    let folder = runtime_folder(name);
    let claude = folder.join("claude");
    let status = AgentStatus::start(folder.join("laufzeit"), claude.clone()).unwrap();
    let terminal = Registered::new(&status, 1);
    (claude, status, terminal)
}

impl Registered {
    /// Schickt das Ende einer Antwort, nach der die Hintergrundaufgaben
    /// `tasks` laufen, und liefert die Meldung dazu.
    fn stop_with(&self, tasks: Value) -> StatusUpdate {
        let prompt = hook_event("UserPromptSubmit", json!({ "prompt": "Los" }));
        assert_eq!(self.post("UserPromptSubmit", &prompt.to_string()), 200);
        let stop = hook_event(
            "Stop",
            json!({ "last_assistant_message": "gestartet", "background_tasks": tasks }),
        );
        assert_eq!(self.post("Stop", &stop.to_string()), 200);
        self.updates
            .try_iter()
            .last()
            .expect("Eine Statusmeldung sollte kommen")
    }

    /// Wartet auf die nächste Meldung.
    fn wait(&self) -> StatusUpdate {
        self.updates
            .recv_timeout(TIMEOUT)
            .expect("Eine Statusmeldung sollte kommen")
    }

    /// Erwartet, dass auch nach einer Weile keine Meldung kommt.
    fn expect_lasting_silence(&self) {
        if let Ok(update) = self.updates.recv_timeout(Duration::from_secs(2)) {
            panic!("Unerwartete Statusmeldung: {update:?}");
        }
    }
}

/// Wie Claude Code 2.1.330 die Ausgabedatei einer abgebrochenen Aufgabe
/// abschließt, gleich ob Shell oder Monitor: eine Leerzeile und `[killed]`.
const KILLED: &str = "\n[killed]\n";

#[test]
fn bricht_die_person_eine_hintergrundaufgabe_ab_ist_der_agent_fertig() {
    let (claude, _status, terminal) = with_task_outputs("abbruch");
    let output = task_output(&claude, "abc123", "b1");
    std::fs::write(&output, "Warte auf die CI\n").unwrap();
    let update = terminal.stop_with(json!([
        running_shell("b1", "CI beobachten", "gh run watch 4711"),
        running_shell("b2", "Server", "npm run dev"),
    ]));
    assert_eq!(update.state, AgentState::Background);
    std::fs::write(task_output(&claude, "abc123", "b2"), "bereit\n").unwrap();
    terminal.expect_lasting_silence();

    std::fs::write(&output, format!("Warte auf die CI\n{KILLED}")).unwrap();

    let update = terminal.wait();
    assert_eq!(update.state, AgentState::Background);
    assert_eq!(task_ids(&update), ["b2"]);
    std::fs::write(
        task_output(&claude, "abc123", "b2"),
        format!("bereit\n{KILLED}"),
    )
    .unwrap();
    let update = terminal.wait();
    assert_eq!(update.state, AgentState::Done);
    assert!(update.state_changed);
    assert_eq!(update.last_action.as_deref(), Some("gestartet"));
    assert!(update.background_tasks.is_empty());
}

#[test]
fn verschwindet_die_ausgabedatei_ist_die_hintergrundaufgabe_vorbei() {
    let (claude, _status, terminal) = with_task_outputs("verschwunden");
    let output = task_output(&claude, "abc123", "b1");
    std::fs::write(&output, "läuft\n").unwrap();
    terminal.stop_with(json!([running_shell("b1", "Server", "npm run dev")]));
    terminal.expect_lasting_silence();

    std::fs::remove_file(&output).unwrap();

    let update = terminal.wait();
    assert_eq!(update.state, AgentState::Done);
    assert!(update.background_tasks.is_empty());
}

#[test]
fn ohne_ausgabedatei_oder_mit_unbekanntem_ende_gilt_das_letzte_stop() {
    let (claude, _status, terminal) = with_task_outputs("unbekannt");
    // Eine normal beendete Aufgabe meldet Claude Code selbst; bis zum
    // nächsten `Stop` zählt sie weiter.
    std::fs::write(
        task_output(&claude, "abc123", "b1"),
        "fertig\n\n[exited with code 0]\n",
    )
    .unwrap();
    std::fs::write(task_output(&claude, "abc123", "b2"), "[killed]").unwrap();

    let update = terminal.stop_with(json!([
        running_shell("b1", "Tests", "npm test"),
        running_shell("b2", "Server", "npm run dev"),
        running_shell("b3", "Ohne Datei", "sleep 600"),
    ]));

    assert_eq!(update.state, AgentState::Background);
    terminal.expect_lasting_silence();
}

#[test]
fn nach_clear_findet_sich_die_ausgabedatei_im_ordner_des_ersten_gespraechs() {
    // Claude Code benennt den Gesprächsordner nach dem Gespräch, mit dem es
    // startete; nach `/clear` trägt jede Meldung eine neue `session_id`.
    let (claude, _status, terminal) = with_task_outputs("nach-clear");
    task_output(&claude, "abc123", "anderes");
    let output = task_output(&claude, "erstes-gespraech", "b1");
    std::fs::write(&output, "läuft\n").unwrap();
    terminal.stop_with(json!([running_shell("b1", "Server", "npm run dev")]));

    std::fs::write(&output, format!("läuft\n{KILLED}")).unwrap();

    assert_eq!(terminal.wait().state, AgentState::Done);
}

#[test]
fn die_beobachtung_endet_mit_sessionend_und_dem_terminal() {
    for end in ["SessionEnd", "forget"] {
        let (claude, status, terminal) = with_task_outputs(&format!("ende-{end}"));
        let output = task_output(&claude, "abc123", "b1");
        std::fs::write(&output, "läuft\n").unwrap();
        terminal.stop_with(json!([running_shell("b1", "Server", "npm run dev")]));
        if end == "forget" {
            status.forget(1);
        } else {
            // Auch `/clear` endet so.
            let body = hook_event("SessionEnd", json!({ "reason": "clear" }));
            assert_eq!(terminal.post("SessionEnd", &body.to_string()), 200);
        }
        assert_eq!(terminal.wait().state, AgentState::Unknown, "{end}");

        std::fs::write(&output, format!("läuft\n{KILLED}")).unwrap();

        terminal.expect_lasting_silence();
    }
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

    let status = AgentStatus::start(folder.join("laufzeit"), no_task_outputs()).unwrap();
    let settings = status.register(1, None, |_| {}).unwrap().settings;
    let command = with_status_settings(
        programs.join("claude.cmd").to_str().unwrap(),
        &settings,
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
    assert_eq!(passed.trim(), format!("--settings {}", settings.display()));
    assert_eq!(snapshot(&project), before);
}

#[test]
fn in_git_bash_kommt_die_konfiguration_als_ein_argument_beim_agenten_an() {
    if !git_bash_found() {
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
    let status = AgentStatus::start(
        folder.join("Max O'Neil").join("lauf zeit"),
        no_task_outputs(),
    )
    .unwrap();
    let settings = status.register(1, None, |_| {}).unwrap().settings;
    let program = programs.join("claude").to_str().unwrap().replace('\\', "/");
    let command = with_status_settings(
        &format!("{program} --model opus"),
        &settings,
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
    let settings = settings.display().to_string();
    assert_eq!(
        passed.lines().collect::<Vec<_>>(),
        ["--settings", settings.as_str(), "--model", "opus"]
    );
}

// Das Ende über die Shell-Funktion: eine echte PowerShell, wie Kredr sie
// startet, mit einem Test-Ersatz für `claude`, der kein `SessionEnd` meldet.

/// Eine PowerShell, wie Kredr sie für ein angemeldetes Terminal startet; im
/// Suchpfad steht zuerst ein Test-Ersatz `claude.cmd`, der `script` ausführt.
struct ShellWithClaude {
    terminal: Terminal,
    events: Receiver<TerminalEvent>,
    registered: Registered,
    /// Der Ordner des Test-Ersatzes.
    programs: PathBuf,
    _status: AgentStatus,
}

impl ShellWithClaude {
    fn open(name: &str, script: &str, agent_command: Option<&str>) -> ShellWithClaude {
        ShellWithClaude::open_in(Shell::Powershell, name, script, agent_command)
    }

    /// Wie `open`, aber eine Git Bash; der Test-Ersatz ist ein Shell-Skript
    /// `claude`, das `script` ausführt.
    fn open_git_bash(name: &str, script: &str, agent_command: Option<&str>) -> ShellWithClaude {
        ShellWithClaude::open_in(Shell::GitBash, name, script, agent_command)
    }

    fn open_in(
        shell: Shell,
        name: &str,
        script: &str,
        agent_command: Option<&str>,
    ) -> ShellWithClaude {
        let folder = runtime_folder(name);
        let programs = folder.join("programme");
        std::fs::create_dir_all(&programs).unwrap();
        let (program, content) = match shell {
            Shell::Powershell => ("claude.cmd", format!("@echo off\r\n{script}\r\n")),
            Shell::GitBash => ("claude", format!("#!/bin/sh\n{script}\n")),
        };
        std::fs::write(programs.join(program), content).unwrap();
        let status = AgentStatus::start(folder.join("laufzeit"), no_task_outputs()).unwrap();
        let registered = Registered::new(&status, 1);
        let start = shell_start_command(shell, Some(&registered.hooks), agent_command)
            .expect("Mit Konfigurationsdatei sollte es einen Startbefehl geben");
        let start = match shell {
            Shell::Powershell => {
                format!("$env:Path = '{};' + $env:Path; {start}", programs.display())
            }
            Shell::GitBash => format!(
                "PATH=\"$(cygpath -u '{}'):$PATH\"\n{start}",
                programs.display()
            ),
        };
        let (sender, events) = channel();
        let options = TerminalOptions {
            shell,
            cwd: folder,
            cols: 200,
            rows: 30,
            start_command: Some(start),
        };
        let terminal = Terminal::open(options, move |event| {
            let _ = sender.send(event);
        })
        .expect("Die Shell sollte starten");
        ShellWithClaude {
            terminal,
            events,
            registered,
            programs,
            _status: status,
        }
    }

    fn send_line(&self, line: &str) {
        self.terminal.write(format!("{line}\r").as_bytes()).unwrap();
    }

    /// Bedient das Terminal, bis `condition` gilt.
    fn wait_until(&self, expectation: &str, mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !condition() {
            assert!(Instant::now() < deadline, "{expectation}");
            // ConPTY wartet beim Start auf die Antwort auf seine Cursorabfrage.
            if let Ok(TerminalEvent::Output(bytes)) =
                self.events.recv_timeout(Duration::from_millis(50))
            {
                if String::from_utf8_lossy(&bytes).contains("\x1b[6n") {
                    self.terminal.write(b"\x1b[1;1R").unwrap();
                }
            }
        }
    }

    /// Wartet auf die nächste Statusmeldung des Terminals.
    fn next_update(&self) -> StatusUpdate {
        let mut update = None;
        self.wait_until("Es kam keine Statusmeldung", || {
            update = self.registered.updates.try_recv().ok();
            update.is_some()
        });
        update.unwrap()
    }
}

#[test]
fn kehrt_claude_im_terminal_zurueck_kommt_das_ende_der_sitzung_an() {
    for (case, script) in [("regulaer", "echo gelaufen"), ("fehler", "exit /b 3")] {
        let shell = ShellWithClaude::open(&format!("rueckkehr-{case}"), script, None);

        shell.send_line("claude --model x");

        assert!(shell.next_update().session_ended, "{case}");
    }
}

#[test]
fn wird_claude_hart_beendet_kommt_das_ende_der_sitzung_an() {
    // Der Test-Ersatz schreibt die Kennung seines Prozesses auf und wartet;
    // der Test beendet ihn wie der Task-Manager.
    let script = "powershell -NoProfile -Command \
                  \"(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId\" \
                  > \"%~dp0pid.txt\"\r\nping -n 60 127.0.0.1 > nul";
    let shell = ShellWithClaude::open("hart-beendet", script, None);
    shell.send_line("claude");
    let pid_file = shell.programs.join("pid.txt");
    let mut pid = String::new();
    shell.wait_until("claude wurde nie gestartet", || {
        pid = std::fs::read_to_string(&pid_file).unwrap_or_default();
        pid.trim().parse::<u32>().is_ok()
    });

    let killed = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", pid.trim()])
        .output()
        .unwrap();
    assert!(killed.status.success(), "{killed:?}");

    assert!(shell.next_update().session_ended);
}

#[test]
fn ein_agent_von_kredr_meldet_sein_ende_auch_beim_fortsetzen() {
    let shell = ShellWithClaude::open(
        "agent-von-kredr",
        "exit /b 1",
        Some("claude --resume abc-123"),
    );

    assert!(shell.next_update().session_ended);
}

#[test]
fn ein_agent_mit_pfad_im_startbefehl_meldet_sein_ende() {
    let name = "agent-mit-pfad";
    let program = runtime_folder(name).join("programme").join("claude.cmd");
    let command = format!("{} --model x", program.display());
    let shell = ShellWithClaude::open(name, "exit /b 1", Some(&command));

    assert!(shell.next_update().session_ended);
}

#[test]
fn aufrufe_von_claude_ohne_sitzung_melden_kein_ende() {
    let shell = ShellWithClaude::open(
        "ohne-sitzung-kein-ende",
        "echo %* > \"%~dp0args.txt\"",
        None,
    );
    let args = shell.programs.join("args.txt");

    shell.send_line("claude --version; claude mcp list");
    shell.wait_until("claude wurde nie aufgerufen", || {
        std::fs::read_to_string(&args).is_ok_and(|text| text.contains("mcp list"))
    });
    // Die Meldung wäre spätestens zusammen mit dem nächsten Befehl da.
    shell.send_line("claude --version");
    std::thread::sleep(Duration::from_secs(2));

    shell.registered.expect_silence();
}

// Dasselbe in Git Bash: Dort meldet ein `trap` die Rückkehr.

/// Git Bash gehört zu Git für Windows; ohne es gibt es hier nichts zu prüfen.
fn git_bash_found() -> bool {
    let found = available_shells().contains(&Shell::GitBash);
    if !found {
        eprintln!("Git Bash wurde nicht gefunden; Test übersprungen");
    }
    found
}

#[test]
fn kehrt_claude_in_git_bash_zurueck_kommt_das_ende_der_sitzung_an() {
    if !git_bash_found() {
        return;
    }
    for (case, script) in [("regulaer", "echo gelaufen"), ("fehler", "exit 3")] {
        let shell = ShellWithClaude::open_git_bash(&format!("bash-rueckkehr-{case}"), script, None);

        shell.send_line("claude --model x");

        assert!(shell.next_update().session_ended, "{case}");
    }
}

/// Ein Test-Ersatz für Git Bash, der die Windows-Kennung seines Prozesses in
/// `pid.txt` neben sich schreibt und dann wartet.
///
/// Ab dem Schreiben startet er kein Programm mehr, sondern nutzt nur
/// Builtins; gewartet wird mit `read` auf das Terminal. Mit einem Kind wie
/// `cat` oder `sleep` überlebte er manchmal Strg+C: Trifft das Signal das
/// Kind, während es startet oder endet, stirbt es nicht daran, und Bash
/// beendet das Skript dann auch nicht.
const BASH_CLAUDE_WAITING: &str = "folder=\"$(dirname \"$0\")\"\n\
                                   read -r winpid < /proc/$$/winpid\n\
                                   echo \"$winpid\" > \"$folder/pid.txt\"\n\
                                   read -r -t 60";

/// Wartet, bis der Test-Ersatz aus `BASH_CLAUDE_WAITING` läuft.
fn wait_for_waiting_claude(shell: &ShellWithClaude) -> String {
    let pid_file = shell.programs.join("pid.txt");
    let mut pid = String::new();
    shell.wait_until("claude wurde nie gestartet", || {
        pid = std::fs::read_to_string(&pid_file).unwrap_or_default();
        pid.trim().parse::<u32>().is_ok()
    });
    pid.trim().to_owned()
}

#[test]
fn wird_claude_in_git_bash_hart_beendet_kommt_das_ende_der_sitzung_an() {
    if !git_bash_found() {
        return;
    }
    let shell = ShellWithClaude::open_git_bash("bash-hart-beendet", BASH_CLAUDE_WAITING, None);
    shell.send_line("claude");
    let pid = wait_for_waiting_claude(&shell);

    let killed = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid])
        .output()
        .unwrap();
    assert!(killed.status.success(), "{killed:?}");

    assert!(shell.next_update().session_ended);
}

#[test]
fn bricht_strg_c_claude_in_git_bash_ab_kommt_das_ende_der_sitzung_an() {
    if !git_bash_found() {
        return;
    }
    let shell = ShellWithClaude::open_git_bash("bash-strg-c", BASH_CLAUDE_WAITING, None);
    shell.send_line("claude");
    wait_for_waiting_claude(&shell);

    shell.terminal.write(b"\x03").unwrap();

    assert!(shell.next_update().session_ended);
}

#[test]
fn ein_agent_von_kredr_meldet_sein_ende_auch_in_git_bash() {
    if !git_bash_found() {
        return;
    }
    let name = "bash-agent-mit-pfad";
    let program = runtime_folder(name).join("programme").join("claude");
    let with_path = format!("{} --model x", program.display()).replace('\\', "/");
    for (case, command) in [
        ("bash-agent-von-kredr", "claude --resume abc-123"),
        (name, with_path.as_str()),
    ] {
        let shell = ShellWithClaude::open_git_bash(case, "exit 1", Some(command));

        assert!(shell.next_update().session_ended, "{case}");
    }
}

#[test]
fn aufrufe_von_claude_ohne_sitzung_melden_in_git_bash_kein_ende() {
    if !git_bash_found() {
        return;
    }
    let shell = ShellWithClaude::open_git_bash(
        "bash-ohne-sitzung-kein-ende",
        "echo \"$@\" >> \"$(dirname \"$0\")/args.txt\"",
        None,
    );
    let args = shell.programs.join("args.txt");

    shell.send_line("claude --version; claude mcp list");
    shell.wait_until("claude wurde nie aufgerufen", || {
        std::fs::read_to_string(&args).is_ok_and(|text| text.contains("mcp list"))
    });
    shell.send_line("claude --version");
    std::thread::sleep(Duration::from_secs(2));

    shell.registered.expect_silence();
}
