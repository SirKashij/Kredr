//! Agentenstatus: nimmt Statusmeldungen laufender Agenten entgegen und
//! ordnet sie dem richtigen Terminal zu.
//!
//! Für jedes Terminal, in dem ein Agent startet, entsteht eine eigene
//! Konfigurationsdatei im Laufzeitordner von Kredr. Claude Code bekommt sie
//! beim Start über `--settings` mit und meldet dann Ereignisse per HTTP-Hook
//! an einen Empfänger auf dem eigenen Rechner. Die Adresse in der Datei
//! enthält die Terminal-Kennung und ein Kennwort; darüber findet jede Meldung
//! ihr Terminal. Einstellungen von Claude Code selbst werden weder gelesen
//! noch geschrieben.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tiny_http::{Method, Response, Server};

/// Länger als so viele Zeichen wird die letzte Aktion nicht.
const ACTION_LIMIT: usize = 120;
/// Größer ist keine Meldung, die der Empfänger liest.
const BODY_LIMIT: u64 = 4 * 1024 * 1024;
/// So viele Sekunden wartet Claude Code höchstens auf den Empfänger.
const HOOK_TIMEOUT: u32 = 5;

/// Ereignisse, die Claude Code ohne Einschränkung meldet.
/// `SessionStart` fehlt: Claude Code meldet es nur Befehls-Hooks, nicht per HTTP.
const EVENTS: [&str; 8] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SessionEnd",
];
/// Meldungen, mit denen Claude Code den Nutzer um eine Eingabe bittet.
const WAITING_NOTIFICATIONS: [&str; 4] = [
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
];
/// Die Meldung, dass Claude Code seit einer Weile auf die nächste Eingabe wartet.
const IDLE_NOTIFICATION: &str = "idle_prompt";

/// Der Zustand eines Agenten aus Sicht der Person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Kein erkannter Agent, oder er hat sich noch nicht gemeldet.
    Unknown,
    Working,
    Done,
    /// Der Agent wartet auf Eingabe.
    Waiting,
}

/// Der Agentenstatus eines Terminals nach einer Meldung.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdate {
    pub state: AgentState,
    /// Was der Agent zuletzt getan, gefragt oder gesagt hat, in einer Zeile.
    pub last_action: Option<String>,
    /// Ob sich der Zustand geändert hat und nicht nur die letzte Aktion.
    pub state_changed: bool,
    /// Der Auftrag: der erste Prompt seit dem Start des Agenten oder dem
    /// letzten Leeren des Gesprächs, im Wortlaut.
    pub assignment: Option<String>,
    /// Die Kennung des Gesprächs, das gerade im Terminal läuft; `None`,
    /// sobald der Agent sich beendet hat.
    pub conversation: Option<String>,
    /// Ob sich das Gespräch, mit dem der Agent startete, nicht fortsetzen
    /// ließ. Die Fehlermeldung des Agenten steht dann in der Shell.
    pub resume_failed: bool,
}

/// Ein gespeichertes Gespräch, das ein Agent beim Start fortsetzt.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resumed {
    /// Die Kennung des Gesprächs.
    pub conversation: String,
    /// Der Auftrag des Gesprächs; der erste Prompt nach dem Fortsetzen
    /// ersetzt ihn nicht.
    pub assignment: Option<String>,
}

/// Der Laufzeitordner des Kredr-Prozesses `pid` unterhalb von `temp`, dem
/// temporären Verzeichnis des Benutzers.
pub fn runtime_folder_of(temp: &Path, pid: u32) -> PathBuf {
    temp.join(format!("{RUNTIME_FOLDER_PREFIX}{pid}"))
}

const RUNTIME_FOLDER_PREFIX: &str = "kredr-";

/// Entfernt aus `temp` die Laufzeitordner von Kredr-Prozessen, die nicht mehr
/// laufen: Wird Kredr beendet, bleibt sein Ordner sonst liegen. Der Ordner
/// eines laufenden Prozesses bleibt unberührt, ebenso alles, was nicht die
/// Konfigurationsdatei eines Terminals ist.
pub fn remove_orphaned_runtime_folders(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = name
            .to_str()
            .and_then(|name| name.strip_prefix(RUNTIME_FOLDER_PREFIX))
            .and_then(|pid| pid.parse::<u32>().ok());
        let Some(pid) = pid else { continue };
        if is_running(pid) {
            continue;
        }
        let folder = entry.path();
        let Ok(files) = std::fs::read_dir(&folder) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("terminal-") && name.ends_with(".json") {
                let _ = std::fs::remove_file(file.path());
            }
        }
        // Gelingt nur, wenn der Ordner jetzt leer ist.
        let _ = std::fs::remove_dir(&folder);
    }
}

/// Ob es einen laufenden Prozess mit dieser Kennung gibt. Im Zweifel ja:
/// Dann bleibt sein Ordner stehen.
fn is_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: Die Kennung des Prozesses wird nur hier benutzt und wieder
    // geschlossen; `code` ist ein gültiger Platz für das Ergebnis.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            // Diesen Fehler meldet Windows, wenn es den Prozess nicht gibt.
            return std::io::Error::last_os_error().raw_os_error()
                != Some(ERROR_INVALID_PARAMETER as i32);
        }
        let mut code = 0;
        let known = GetExitCodeProcess(process, &mut code) != 0;
        CloseHandle(process);
        !known || code == STILL_ACTIVE as u32
    }
}

type Listener = Box<dyn Fn(StatusUpdate) + Send>;

struct Registration {
    token: String,
    settings: PathBuf,
    known: Known,
    /// Ob der Agent gestartet ist. Ein fortgesetzter Agent ist es erst mit
    /// seiner ersten Meldung; findet Claude Code das Gespräch nicht, meldet
    /// es nur `SessionEnd`.
    started: bool,
    on_update: Listener,
}

/// Was Kredr über den Agenten eines Terminals weiß.
#[derive(Clone, PartialEq, Eq)]
struct Known {
    /// Der Agentenstatus.
    state: AgentState,
    /// Was der Agent zuletzt getan, gefragt oder gesagt hat.
    last_action: Option<String>,
    /// Der Auftrag des laufenden Gesprächs.
    assignment: Option<String>,
    /// Die Kennung des laufenden Gesprächs.
    conversation: Option<String>,
}

impl Registration {
    /// Übernimmt den neuen Stand und meldet ihn, wenn sich etwas geändert hat.
    fn apply(&mut self, next: Known) {
        if next == self.known {
            return;
        }
        self.report(next, false);
    }

    /// Das Gespräch ließ sich nicht fortsetzen: Kredr vergisst es und meldet das.
    fn fail_resume(&mut self) {
        let nothing = Known {
            state: AgentState::Unknown,
            last_action: None,
            assignment: None,
            conversation: None,
        };
        self.report(nothing, true);
    }

    fn report(&mut self, next: Known, resume_failed: bool) {
        let state_changed = next.state != self.known.state;
        self.known = next;
        let known = self.known.clone();
        (self.on_update)(StatusUpdate {
            state: known.state,
            last_action: known.last_action,
            state_changed,
            assignment: known.assignment,
            conversation: known.conversation,
            resume_failed,
        });
    }
}

type Registrations = Arc<Mutex<HashMap<u32, Registration>>>;

/// Der Empfänger für Statusmeldungen aller Agenten dieses Kredr-Prozesses.
pub struct AgentStatus {
    server: Arc<Server>,
    port: u16,
    dir: PathBuf,
    registrations: Registrations,
}

impl AgentStatus {
    /// Öffnet den Empfänger auf dem eigenen Rechner. In `dir` entstehen die
    /// Konfigurationsdateien der Agenten; der Ordner gehört Kredr allein.
    pub fn start(dir: PathBuf) -> io::Result<AgentStatus> {
        std::fs::create_dir_all(&dir)?;
        let server = Arc::new(Server::http("127.0.0.1:0").map_err(io::Error::other)?);
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| io::Error::other("no ip address"))?
            .port();
        let registrations = Registrations::default();

        let incoming = server.clone();
        let known = registrations.clone();
        thread::spawn(move || {
            for mut request in incoming.incoming_requests() {
                let mut body = String::new();
                let readable = request
                    .as_reader()
                    .take(BODY_LIMIT)
                    .read_to_string(&mut body)
                    .is_ok();
                let accepted = *request.method() == Method::Post
                    && receive(&known, request.url(), readable.then_some(&body));
                // Eine leere Antwort heißt für Claude Code: keine Entscheidung.
                let code = if accepted { 200 } else { 404 };
                let _ = request.respond(Response::empty(code));
            }
        });

        Ok(AgentStatus {
            server,
            port,
            dir,
            registrations,
        })
    }

    /// Meldet das Terminal an, in dem ein Agent startet, und liefert die
    /// Konfigurationsdatei, die der Agent beim Start mitbekommt.
    /// `on_update` erhält danach jede Änderung des Agentenstatus dieses
    /// Terminals, der Reihe nach aus einem Hintergrund-Thread. Setzt der
    /// Agent ein Gespräch fort (`resumed`), gelten dessen Kennung und
    /// Auftrag von Anfang an.
    pub fn register(
        &self,
        terminal: u32,
        resumed: Option<Resumed>,
        on_update: impl Fn(StatusUpdate) + Send + 'static,
    ) -> io::Result<PathBuf> {
        let token = random_token();
        let url = format!("http://127.0.0.1:{}/hook/{terminal}/{token}", self.port);
        let settings = self.dir.join(format!("terminal-{terminal}.json"));
        std::fs::write(&settings, hook_settings(&url).to_string())?;
        let registration = Registration {
            token,
            settings: settings.clone(),
            started: resumed.is_none(),
            known: Known {
                state: AgentState::Unknown,
                last_action: None,
                assignment: resumed.as_ref().and_then(|r| r.assignment.clone()),
                conversation: resumed.map(|r| r.conversation),
            },
            on_update: Box::new(on_update),
        };
        self.registrations
            .lock()
            .map_err(|e| io::Error::other(e.to_string()))?
            .insert(terminal, registration);
        Ok(settings)
    }

    /// Meldet das Terminal ab, weil es geschlossen wurde oder seine Shell
    /// endete. Sein Status fällt auf „unbekannt“, die Konfigurationsdatei
    /// verschwindet, spätere Meldungen werden abgewiesen.
    pub fn forget(&self, terminal: u32) {
        let Ok(mut registrations) = self.registrations.lock() else {
            return;
        };
        if let Some(mut registration) = registrations.remove(&terminal) {
            registration.apply(Known {
                state: AgentState::Unknown,
                last_action: None,
                assignment: None,
                conversation: None,
            });
            let _ = std::fs::remove_file(&registration.settings);
        }
    }
}

impl Drop for AgentStatus {
    fn drop(&mut self) {
        self.server.unblock();
        if let Ok(registrations) = self.registrations.lock() {
            for registration in registrations.values() {
                let _ = std::fs::remove_file(&registration.settings);
            }
        }
        // Gelingt nur, wenn der Ordner leer ist.
        let _ = std::fs::remove_dir(&self.dir);
    }
}

/// Verarbeitet eine Meldung an `url`. Liefert, ob sie zu einem angemeldeten
/// Terminal gehört; ihr Inhalt darf unlesbar sein.
fn receive(registrations: &Registrations, url: &str, body: Option<&String>) -> bool {
    let mut parts = url.trim_start_matches('/').split('/');
    let (Some("hook"), Some(terminal), Some(token), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Ok(terminal) = terminal.parse::<u32>() else {
        return false;
    };
    let Ok(mut registrations) = registrations.lock() else {
        return false;
    };
    let Some(registration) = registrations.get_mut(&terminal) else {
        return false;
    };
    if registration.token != token {
        return false;
    }
    let event = body.and_then(|body| serde_json::from_str::<Value>(body).ok());
    if let Some(event) = event {
        if event["hook_event_name"] != "SessionEnd" {
            registration.started = true;
        } else if !registration.started {
            registration.fail_resume();
            return true;
        }
        let known = &registration.known;
        let status = next_status(known.state, &known.last_action, &event);
        let (state, last_action) =
            status.unwrap_or_else(|| (known.state, known.last_action.clone()));
        let next = Known {
            state,
            last_action,
            assignment: next_assignment(&known.assignment, &event),
            conversation: next_conversation(&known.conversation, &event),
        };
        registration.apply(next);
    }
    true
}

/// Der Auftrag nach dem Ereignis `event`: Nur der erste Prompt einer Sitzung
/// zählt. Mit dem Ende der Sitzung, auch durch `/clear`, ist er vergessen;
/// der nächste Prompt beginnt die neue Sitzung.
fn next_assignment(assignment: &Option<String>, event: &Value) -> Option<String> {
    match event["hook_event_name"].as_str() {
        Some("UserPromptSubmit") if assignment.is_none() => {
            let prompt = event["prompt"].as_str()?.trim();
            (!prompt.is_empty()).then(|| prompt.to_owned())
        }
        Some("SessionEnd") => None,
        _ => assignment.clone(),
    }
}

/// Das Gespräch nach dem Ereignis `event`: das, dessen Kennung die Meldung
/// trägt. Beendet sich der Agent, gibt es keines mehr, auch nach `/clear`:
/// Das neue Gespräch kommt mit dem nächsten Prompt.
fn next_conversation(conversation: &Option<String>, event: &Value) -> Option<String> {
    if event["hook_event_name"] == "SessionEnd" {
        return None;
    }
    match event["session_id"].as_str() {
        Some(id) if !id.is_empty() => Some(id.to_owned()),
        _ => conversation.clone(),
    }
}

/// Der Status nach dem Ereignis `event`, wie Claude Code es einem Hook
/// übergibt; `None`, wenn das Ereignis nichts ändert.
fn next_status(
    state: AgentState,
    last_action: &Option<String>,
    event: &Value,
) -> Option<(AgentState, Option<String>)> {
    let text = |field: &str| event[field].as_str().and_then(one_line);
    match event["hook_event_name"].as_str()? {
        "UserPromptSubmit" => Some((AgentState::Working, None)),
        "PreToolUse" if event["tool_name"] == "AskUserQuestion" => {
            let question = event["tool_input"]["questions"][0]["question"]
                .as_str()
                .and_then(one_line);
            Some((AgentState::Waiting, question.or_else(|| tool_action(event))))
        }
        "PreToolUse" => Some((AgentState::Working, tool_action(event))),
        "PostToolUse" | "PostToolUseFailure" => Some((AgentState::Working, last_action.clone())),
        "PermissionRequest" => Some((AgentState::Waiting, tool_action(event))),
        "Notification" => {
            let kind = event["notification_type"].as_str()?;
            if WAITING_NOTIFICATIONS.contains(&kind) {
                // Die Rückfrage selbst ist meist schon genauer gemeldet.
                let action = match state {
                    AgentState::Waiting => last_action.clone(),
                    _ => text("message"),
                };
                Some((AgentState::Waiting, action))
            } else if kind == IDLE_NOTIFICATION && state == AgentState::Working {
                // Nach einer Unterbrechung durch den Nutzer meldet Claude
                // Code kein Ende der Antwort.
                Some((AgentState::Done, last_action.clone()))
            } else {
                None
            }
        }
        "Stop" => Some((AgentState::Done, text("last_assistant_message"))),
        "StopFailure" => Some((
            AgentState::Done,
            text("last_assistant_message").or_else(|| text("error")),
        )),
        "SessionEnd" => Some((AgentState::Unknown, None)),
        _ => None,
    }
}

/// Der Werkzeugaufruf eines Ereignisses als `Werkzeug(Ziel)`.
fn tool_action(event: &Value) -> Option<String> {
    let tool = event["tool_name"].as_str()?;
    let input = &event["tool_input"];
    let target = [
        "file_path",
        "command",
        "pattern",
        "url",
        "query",
        "description",
    ]
    .iter()
    .find_map(|field| {
        let value = input[*field].as_str()?;
        if *field != "file_path" {
            return Some(value);
        }
        // Dateien im Startordner des Agenten kürzer, wie Claude Code sie zeigt.
        let relative = event["cwd"]
            .as_str()
            .and_then(|cwd| Path::new(value).strip_prefix(cwd).ok())
            .and_then(Path::to_str);
        Some(relative.unwrap_or(value))
    });
    let room = ACTION_LIMIT
        .saturating_sub(tool.chars().count() + 2)
        .max(20);
    Some(match target.and_then(|target| shorten(target, room)) {
        Some(target) => format!("{tool}({target})"),
        None => tool.to_owned(),
    })
}

/// Der erste Absatz von `text` als eine Zeile, gekürzt auf die Länge der
/// letzten Aktion.
fn one_line(text: &str) -> Option<String> {
    shorten(text, ACTION_LIMIT)
}

/// Der erste Absatz von `text` als eine Zeile aus höchstens `limit` Zeichen.
fn shorten(text: &str, limit: usize) -> Option<String> {
    let text = text.replace('\r', "");
    let paragraph = text.trim().split("\n\n").next()?;
    let line = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= limit {
        return Some(line);
    }
    let mut short: String = line.chars().take(limit - 1).collect();
    short.push('…');
    Some(short)
}

/// Die Konfiguration, die einen Agenten seine Ereignisse an `url` melden lässt.
fn hook_settings(url: &str) -> Value {
    let hook = json!({ "type": "http", "url": url, "timeout": HOOK_TIMEOUT });
    let mut hooks = serde_json::Map::new();
    for event in EVENTS {
        hooks.insert(event.to_owned(), json!([{ "hooks": [hook] }]));
    }
    let mut notifications = WAITING_NOTIFICATIONS.to_vec();
    notifications.push(IDLE_NOTIFICATION);
    hooks.insert(
        "Notification".to_owned(),
        json!([{ "matcher": notifications.join("|"), "hooks": [hook] }]),
    );
    json!({ "hooks": hooks })
}

/// Ein nicht erratbares Kennwort; den Zufall liefert das Betriebssystem
/// über die Schlüssel der Standard-Hashtabelle.
fn random_token() -> String {
    let part = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", part(), part())
}
