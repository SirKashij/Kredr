//! Die Befehle der Terminals für die Oberfläche und die Verwaltung der
//! laufenden Terminals je Fenster. Die Logik liegt in `terminal`, `agent` und
//! `agent_status`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::agent_status::{AgentStatus, Resumed, StatusUpdate};
use crate::settings::{SettingsStore, Shell};
use crate::terminal::{self, Terminal, TerminalEvent, TerminalOptions};
use crate::{agent, paths};

/// Die laufenden Terminals, nach Kennung.
#[derive(Default)]
pub(crate) struct Terminals {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Arc<Terminal>>>,
    /// Zu welchem Fenster ein Terminal gehört.
    owners: Mutex<HashMap<u32, String>>,
}

impl Terminals {
    /// Beendet die Terminals eines geschlossenen Fensters; der Prozess läuft
    /// für die übrigen Fenster weiter.
    pub(crate) fn close_all_of(&self, window: &str) {
        let Ok(mut owners) = self.owners.lock() else {
            return;
        };
        let Ok(mut open) = self.open.lock() else {
            return;
        };
        owners.retain(|id, owner| {
            let keep = owner != window;
            if !keep {
                open.remove(id);
            }
            keep
        });
    }

    /// Liefert das Terminal, ohne die Sperre über alle Terminals zu halten:
    /// eine Shell, die ihre Eingabe nicht liest, bremst so keine andere.
    fn get(&self, id: u32) -> Result<Arc<Terminal>, String> {
        let open = self.open.lock().map_err(|e| e.to_string())?;
        open.get(&id)
            .cloned()
            .ok_or_else(|| format!("terminal {id} not found"))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedTerminal {
    id: u32,
    /// Das Programm des Agent-Startbefehls, wenn ein Agent starten sollte,
    /// es aber im Suchpfad nicht zu finden ist. Der Startbefehl läuft
    /// trotzdem: Ein Alias oder eine Funktion aus dem Profil der Shell kennt
    /// nur die Shell selbst.
    missing_agent_program: Option<String>,
    /// Die gewünschte Shell, wenn es sie auf diesem Rechner nicht (mehr)
    /// gibt. Das Terminal läuft dann mit PowerShell.
    missing_shell: Option<Shell>,
    /// Ob ein Agent gestartet ist. Ein Gespräch lässt sich nur mit einem
    /// Startbefehl fortsetzen, der mit `claude` beginnt; sonst bleibt die
    /// Shell ohne Agent.
    agent_started: bool,
}

/// Der Empfänger für den Agentenstatus. Er fehlt, wenn er sich beim Start
/// nicht öffnen ließ; Agenten starten dann ohne Agentenstatus.
pub(crate) type AgentStatusReceiver = Option<Arc<AgentStatus>>;

/// Öffnet ein Terminal mit der gewählten Shell. Mit `agent` startet darin
/// sofort der Agent, mit `resume` setzt er dieses Gespräch fort;
/// `on_agent_status` erhält dann jede Änderung seines Agentenstatus.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn terminal_open(
    window: tauri::Window,
    terminals: State<'_, Terminals>,
    agent_status: State<'_, AgentStatusReceiver>,
    settings: State<'_, SettingsStore>,
    shell: Option<Shell>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    agent: bool,
    resume: Option<Resumed>,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<()>,
    on_agent_status: Channel<StatusUpdate>,
) -> Result<OpenedTerminal, String> {
    let id = terminals.next_id.fetch_add(1, Ordering::Relaxed);
    // Ohne Angabe gilt die Standard-Shell aus den Einstellungen.
    let wanted = shell.unwrap_or_else(|| settings.get().default_shell);
    let shell = terminal::startable_shell(wanted, &terminal::available_shells());
    let missing_shell = (shell != wanted).then_some(wanted);
    // Der Agent-Startbefehl wird bei jedem Start frisch gelesen, damit eine
    // Änderung in den Einstellungen sofort gilt.
    let mut start_command = agent.then(|| settings.get().agent_command);
    if let Some(resumed) = &resume {
        start_command =
            start_command.and_then(|command| agent::resuming(&command, &resumed.conversation));
    }
    let agent_started = start_command.is_some();
    let search_path = paths::search_path();
    let missing_agent_program = start_command
        .as_deref()
        .and_then(|command| agent::missing_program(command, &search_path));
    // Der Agent meldet seinen Status über eine Konfiguration, die nur für
    // dieses Terminal gilt. Lässt sie sich nicht anlegen, startet er ohne.
    let status = agent_status
        .inner()
        .clone()
        .filter(|_| start_command.is_some());
    if let (Some(status), Some(command)) = (&status, &mut start_command) {
        let settings_file = status.register(id, resume, move |update| {
            // Hier beginnt jede Reaktion des Kerns auf einen Statuswechsel.
            let _ = on_agent_status.send(update);
        });
        if let Ok(settings_file) = settings_file {
            *command = agent::with_status_settings(command, &settings_file, shell);
        }
    }
    let options = TerminalOptions {
        shell,
        cwd,
        cols,
        rows,
        start_command,
    };
    let exited_status = status.clone();
    let terminal = Terminal::open(options, move |event| {
        // Scheitert das Senden, ist das Fenster bereits geschlossen.
        let _ = match event {
            TerminalEvent::Output(bytes) => on_output.send(InvokeResponseBody::Raw(bytes)),
            TerminalEvent::Exited => {
                if let Some(status) = &exited_status {
                    status.forget(id);
                }
                on_exit.send(())
            }
        };
    })
    .map_err(|e| {
        if let Some(status) = &status {
            status.forget(id);
        }
        e.to_string()
    })?;

    terminals
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Arc::new(terminal));
    if let Ok(mut owners) = terminals.owners.lock() {
        owners.insert(id, window.label().to_string());
    }
    Ok(OpenedTerminal {
        id,
        missing_agent_program,
        missing_shell,
        agent_started,
    })
}

#[tauri::command]
pub(crate) fn terminal_write(
    terminals: State<'_, Terminals>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let terminal = terminals.get(id)?;
    terminal.write(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn terminal_resize(
    terminals: State<'_, Terminals>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminal = terminals.get(id)?;
    terminal.resize(cols, rows).map_err(|e| e.to_string())
}

/// Ob im Terminal noch ein Kindprozess läuft; danach richtet sich die
/// Rückfrage beim Schließen.
#[tauri::command]
pub(crate) fn terminal_has_child_process(
    terminals: State<'_, Terminals>,
    id: u32,
) -> Result<bool, String> {
    Ok(terminals.get(id)?.has_child_process())
}

#[tauri::command]
pub(crate) fn terminal_close(
    terminals: State<'_, Terminals>,
    agent_status: State<'_, AgentStatusReceiver>,
    id: u32,
) -> Result<(), String> {
    if let Some(status) = agent_status.inner() {
        status.forget(id);
    }
    terminals
        .open
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Ok(mut owners) = terminals.owners.lock() {
        owners.remove(&id);
    }
    Ok(())
}
