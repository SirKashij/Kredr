//! Agentenstatus: nimmt Statusmeldungen laufender Agenten entgegen und
//! ordnet sie dem richtigen Terminal zu.
//!
//! Für jedes Terminal entsteht eine eigene
//! Konfigurationsdatei im Laufzeitordner von Kredr. Claude Code bekommt sie
//! beim Start über `--settings` mit, auch wenn die Person `claude` von Hand
//! startet (ADR 0006), und meldet dann Ereignisse per HTTP-Hook
//! an einen Empfänger auf dem eigenen Rechner. `SessionStart` meldet Claude
//! Code nur Befehls-Hooks; ein kurzer PowerShell-Aufruf reicht es an
//! dieselbe Adresse weiter. Die Adresse in der Datei
//! enthält die Terminal-Kennung und ein Kennwort; darüber findet jede Meldung
//! ihr Terminal. Einstellungen von Claude Code selbst werden weder gelesen
//! noch geschrieben.
//!
//! Was aus den Meldungen folgt, entscheidet der `TrackedAgent` des Terminals;
//! der Empfang reicht sie nur weiter.

mod task_output;
mod tracked_agent;

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tiny_http::{Method, Response, Server};

pub use tracked_agent::{
    AgentState, BackgroundTask, Resumed, StatusUpdate, Subagent, SubagentState, TrackedAgent,
};
use tracked_agent::{IDLE_NOTIFICATION, WAITING_NOTIFICATIONS};

/// Größer ist keine Meldung, die der Empfänger liest.
const BODY_LIMIT: u64 = 4 * 1024 * 1024;
/// So viele Sekunden wartet Claude Code höchstens auf den Empfänger.
const HOOK_TIMEOUT: u32 = tracked_agent::HOOK_TIMEOUT_SECS as u32;

/// Ereignisse, die Claude Code ohne Einschränkung per HTTP meldet. Die
/// Konfiguration trägt dazu die wartenden Meldungen (`Notification`) ein,
/// eingeschränkt auf die, die zählen, und den Befehls-Hook für `SessionStart`.
const EVENTS: [&str; 10] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];

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
    agent: TrackedAgent,
    on_update: Listener,
}

impl Registration {
    /// Gibt eine Meldung des Automaten an den Listener weiter.
    fn tell(&self, update: Option<StatusUpdate>) {
        if let Some(update) = update {
            (self.on_update)(update);
        }
    }
}

/// Die angemeldeten Terminals mit ihren Agenten.
type Registrations = Mutex<HashMap<u32, Registration>>;

/// Der Empfänger für Statusmeldungen aller Agenten dieses Kredr-Prozesses.
pub struct AgentStatus {
    server: Arc<Server>,
    port: u16,
    dir: PathBuf,
    registrations: Arc<Registrations>,
}

impl AgentStatus {
    /// Öffnet den Empfänger auf dem eigenen Rechner. In `dir` entstehen die
    /// Konfigurationsdateien der Agenten; der Ordner gehört Kredr allein.
    /// Unter `claude_temp`, dem Ordner `%TEMP%\claude`, sucht er die
    /// Ausgabedateien der Hintergrundaufgaben.
    pub fn start(dir: PathBuf, claude_temp: PathBuf) -> io::Result<AgentStatus> {
        std::fs::create_dir_all(&dir)?;
        let server = Arc::new(Server::http("127.0.0.1:0").map_err(io::Error::other)?);
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| io::Error::other("no ip address"))?
            .port();
        let registrations = Arc::<Registrations>::default();

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

        let watched = Arc::downgrade(&registrations);
        thread::spawn(move || task_output::watch(&watched, &claude_temp));

        Ok(AgentStatus {
            server,
            port,
            dir,
            registrations,
        })
    }

    /// Meldet das Terminal an, in dem ein Agent starten kann, und liefert
    /// die Konfigurationsdatei, die der Agent beim Start mitbekommt.
    /// `on_update` erhält danach jede Änderung des Agentenstatus dieses
    /// Terminals, der Reihe nach aus einem Hintergrund-Thread, bevor der
    /// Empfänger die Meldung beantwortet. Setzt der Agent ein Gespräch fort
    /// (`resumed`), gelten dessen Kennung und Auftrag von Anfang an.
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
            agent: TrackedAgent::new(resumed),
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
            let update = registration.agent.forget();
            registration.tell(update);
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
/// Terminal gehört; ihr Inhalt darf unlesbar sein und wird dann verworfen.
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
    if let Some(event) = body.and_then(|body| serde_json::from_str::<Value>(body).ok()) {
        let update = registration.agent.on_event(&event);
        registration.tell(update);
    }
    true
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
    let forward = json!({
        "type": "command",
        "command": forwarding_command(url),
        // Claude Code wartet nicht, bis PowerShell gestartet ist.
        "async": true,
        "timeout": HOOK_TIMEOUT,
    });
    hooks.insert("SessionStart".to_owned(), json!([{ "hooks": [forward] }]));
    json!({ "hooks": hooks })
}

/// Was der Befehls-Hook ausführt: Er schickt die Standardeingabe, das
/// Ereignis als UTF-8, unverändert per POST an `{url}`. Was dabei schiefgeht,
/// bleibt still; Claude Code merkt davon nichts.
const FORWARDING_SCRIPT: &str = "\
$ProgressPreference = 'SilentlyContinue'
try {
  $stdin = [Console]::OpenStandardInput()
  $body = [IO.MemoryStream]::new()
  $stdin.CopyTo($body)
  $bytes = $body.ToArray()
  $request = [Net.HttpWebRequest]::Create('{url}')
  $request.Method = 'POST'
  $request.ContentType = 'application/json'
  $request.Proxy = $null
  $request.Timeout = 3000
  $request.ContentLength = $bytes.Length
  $out = $request.GetRequestStream()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Close()
  $request.GetResponse().Close()
} catch {}
exit 0
";

/// Der Befehl, der das Ereignis eines Befehls-Hooks an `url` weiterreicht.
/// Claude Code führt ihn je nach Rechner in Git Bash oder PowerShell aus; das
/// Skript steht deshalb kodiert darin, ohne Zeichen, die eine der Shells
/// deutet. PowerShell gehört zu Windows.
fn forwarding_command(url: &str) -> String {
    let script = FORWARDING_SCRIPT.replace("{url}", url);
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        base64(&utf16)
    )
}

/// `bytes` in Base64 mit Auffüllung.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |group, (i, &byte)| {
            group | u32::from(byte) << (16 - 8 * i)
        });
        for i in 0..4 {
            if i <= chunk.len() {
                text.push(ALPHABET[(group >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                text.push('=');
            }
        }
    }
    text
}

/// Ein nicht erratbares Kennwort; den Zufall liefert das Betriebssystem
/// über die Schlüssel der Standard-Hashtabelle.
fn random_token() -> String {
    let part = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", part(), part())
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_kodiert_wie_rfc_4648() {
        // Die Testwerte aus RFC 4648, Abschnitt 10: jede Restlänge.
        let cases = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, encoded) in cases {
            assert_eq!(base64(plain.as_bytes()), encoded, "{plain}");
        }
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
    }
}
