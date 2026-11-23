//! Der Automat des Agentenstatus: Er macht aus den Ereignissen, die Claude
//! Code für ein Terminal meldet, den Agentenstatus, wie die Person ihn sieht.
//! Wie die Ereignisse ankommen, weiß er nicht.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::Value;

/// So viele Sekunden wartet Claude Code höchstens auf einen Hook; danach
/// bricht es ihn ab. Länger nach dem Start kann auch der Befehls-Hook für
/// `SessionStart` nichts mehr melden.
pub(super) const HOOK_TIMEOUT_SECS: u64 = 5;

/// Länger als so viele Zeichen wird die letzte Aktion nicht.
const ACTION_LIMIT: usize = 120;

/// Womit die Prompts beginnen, mit denen Claude Code den Agenten unterrichtet,
/// etwa über das Ende eines Subagenten. Sie stammen nicht von der Person.
/// Ruft ein Subagent zum Schluss `SubagentHandback` auf, kommt sein Bericht
/// als `<agent-message>`, sonst als `<task-notification>` (Claude Code 2.1.330).
const PROMPTS_OF_CLAUDE_CODE: [&str; 3] = [
    "<task-notification>",
    "<agent-message",
    "<cross-session-message",
];
/// Meldungen, mit denen Claude Code den Nutzer um eine Eingabe bittet.
pub(super) const WAITING_NOTIFICATIONS: [&str; 4] = [
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
];
/// Die Meldung, dass Claude Code seit einer Weile auf die nächste Eingabe wartet.
pub(super) const IDLE_NOTIFICATION: &str = "idle_prompt";

/// Die Gründe eines `SessionEnd`, mit denen Claude Code nur das Gespräch
/// leert (`/clear`) oder wechselt (`/resume`) und weiterläuft.
const CONVERSATION_CHANGES: [&str; 2] = ["clear", "resume"];

/// Der Typ, den Claude Code einem Subagenten ohne Angabe gibt.
const DEFAULT_SUBAGENT_TYPE: &str = "general-purpose";

/// Der Zustand eines Agenten aus Sicht der Person.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Kein erkannter Agent, oder er hat sich noch nicht gemeldet.
    #[default]
    Unknown,
    Working,
    Done,
    /// Der Agent ist fertig, aber eine Hintergrundaufgabe läuft noch.
    Background,
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
    /// Ob die Sitzung beendet ist, nicht nur ihr Gespräch geleert (`/clear`)
    /// oder gewechselt (`/resume`):
    /// Das Terminal ist wieder ein gewöhnliches. So endet auch ein Agent,
    /// dessen Gespräch sich nicht fortsetzen ließ; seine Fehlermeldung steht
    /// dann in der Shell.
    pub session_ended: bool,
    /// Die Subagenten des Agenten in der Reihenfolge ihres Starts: die
    /// laufenden und die seit dem letzten Prompt der Person fertigen.
    pub subagents: Vec<Subagent>,
    /// Die laufenden Hintergrundaufgaben des Agenten in der Reihenfolge,
    /// in der Claude Code sie meldet.
    pub background_tasks: Vec<BackgroundTask>,
}

/// Eine laufende Hintergrundaufgabe, wie Claude Code sie in
/// `background_tasks` meldet.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    /// Die Kennung, unter der Claude Code sie führt (`id`).
    pub id: String,
    /// Ihr Typ, etwa `shell` oder `monitor` (`type`).
    pub kind: String,
    /// Die Beschreibung, die der Agent ihr mitgegeben hat.
    pub description: Option<String>,
    /// Der Befehl, den sie ausführt, falls es einen gibt.
    pub command: Option<String>,
}

/// Der Zustand eines Subagenten.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubagentState {
    Working,
    /// Er wartet auf eine Genehmigung oder Eingabe der Person.
    Waiting,
    Done,
}

/// Ein Subagent, wie die Person ihn beim Agenten sieht.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    /// Die Kennung, mit der Claude Code seine Ereignisse meldet (`agent_id`).
    pub id: String,
    /// Sein Typ, etwa `Explore` (`agent_type`).
    pub kind: String,
    /// Die Beschreibung, die der Agent ihm mitgegeben hat; `None`, solange
    /// sie nicht bekannt ist.
    pub description: Option<String>,
    pub state: SubagentState,
    /// Was der Subagent zuletzt getan oder am Ende gesagt hat.
    pub last_action: Option<String>,
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

/// Was Kredr über den Agenten eines Terminals weiß. Jedes Terminal mit
/// Agent hat seinen eigenen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrackedAgent {
    /// Der Agentenstatus nach den eigenen Meldungen des Agenten.
    state: AgentState,
    /// Was der Agent zuletzt getan, gefragt oder gesagt hat.
    last_action: Option<String>,
    /// Die Kennungen der Subagenten mit offener Rückfrage. Sie steht im
    /// Terminal des Agenten, er wartet also.
    asking: Vec<String>,
    /// Wie viele Genehmigungsabfragen (`PermissionRequest`, auch von
    /// Subagenten) Claude Code noch mit einer `Notification` wiederholen kann.
    unrepeated_permissions: u32,
    /// Die Subagenten, die die Person sieht.
    subagents: Vec<Subagent>,
    /// Die Aufrufe des `Agent`-Werkzeugs der laufenden Antwort, deren
    /// Subagent noch nicht gestartet ist, der älteste zuerst.
    launches: Vec<Launch>,
    /// Die laufenden Hintergrundaufgaben.
    background_tasks: Vec<BackgroundTask>,
    /// Der Auftrag des laufenden Gesprächs.
    assignment: Option<String>,
    /// Die Kennung des laufenden Gesprächs.
    conversation: Option<String>,
    /// Die Sitzung, die zuletzt endete: die Kennung ihres Gesprächs und wann.
    ended: Option<(String, Instant)>,
    /// Ob das Ende der Sitzung schon gemeldet ist und seither nichts kam.
    /// Dann ändert die Rückkehr von `claude` nichts mehr.
    end_reported: bool,
}

/// Eine Rückfrage an die Person.
struct Question {
    /// Wonach gefragt wird, als letzte Aktion.
    action: Option<String>,
}

/// Ein Aufruf des `Agent`-Werkzeugs, mit dem der Agent einen Subagenten startet.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Launch {
    tool_use: Option<String>,
    kind: String,
    description: Option<String>,
}

impl TrackedAgent {
    /// Der Stand eines Agenten, der gerade startet. Setzt er ein Gespräch
    /// fort (`resumed`), gelten dessen Kennung und Auftrag von Anfang an.
    pub fn new(resumed: Option<Resumed>) -> TrackedAgent {
        TrackedAgent {
            assignment: resumed.as_ref().and_then(|r| r.assignment.clone()),
            conversation: resumed.map(|r| r.conversation),
            ..TrackedAgent::default()
        }
    }

    /// Nimmt ein Ereignis an, wie Claude Code es einem Hook übergibt. Liefert
    /// den neuen Agentenstatus, wenn sich für die Person etwas sichtbar
    /// ändert, sonst `None`.
    pub fn on_event(&mut self, event: &Value) -> Option<StatusUpdate> {
        match event["hook_event_name"].as_str() {
            Some("SessionStart") if self.is_late_start(event) => return None,
            Some("SessionEnd") => {
                self.ended = event["session_id"]
                    .as_str()
                    .map(|id| (id.to_owned(), Instant::now()));
                // Außer beim Leeren oder Wechseln des Gesprächs ist die
                // Sitzung vorbei, auch wenn sich das Gespräch nicht fortsetzen
                // ließ.
                let reason = event["reason"].as_str().unwrap_or_default();
                if !CONVERSATION_CHANGES.contains(&reason) {
                    return Some(self.end_session());
                }
            }
            _ => {}
        }
        let mut next = self.next(event);
        next.end_reported = false;
        self.apply(next)
    }

    /// Das Programm `claude` ist im Terminal zurückgekehrt, so meldet es die
    /// Shell-Funktion (ADR 0006). Hat Claude Code sein Ende nicht selbst mit
    /// `SessionEnd` gemeldet, etwa nach einem Absturz oder hartem Beenden,
    /// endet die Sitzung jetzt. Sonst liefert es `None`: Der Tab ist dann
    /// schon ein gewöhnliches Terminal.
    pub fn claude_exited(&mut self) -> Option<StatusUpdate> {
        if self.end_reported {
            return None;
        }
        // Das `SessionStart` dieser Sitzung kann noch unterwegs sein.
        if let Some(conversation) = &self.conversation {
            self.ended = Some((conversation.clone(), Instant::now()));
        }
        Some(self.end_session())
    }

    /// Die Sitzung ist vorbei. Das wird immer gemeldet, auch ohne sichtbare
    /// Änderung des Status: Erst damit wird der Tab wieder ein gewöhnliches
    /// Terminal.
    fn end_session(&mut self) -> StatusUpdate {
        let next = TrackedAgent {
            end_reported: true,
            ..self.forgotten()
        };
        self.report(next, true)
    }

    /// Ob `event`, ein `SessionStart`, zu der Sitzung gehört, die gerade
    /// endete. Der Befehls-Hook läuft im Hintergrund; beendet die Person
    /// Claude Code gleich nach dem Start, kommt sein `SessionStart` nach dem
    /// `SessionEnd`. Später als die Laufzeit eines Hooks nach dem Ende ist
    /// es ein neuer Start desselben Gesprächs, etwa mit `claude -c`.
    fn is_late_start(&self, event: &Value) -> bool {
        let Some((ended, at)) = &self.ended else {
            return false;
        };
        event["session_id"] == ended.as_str()
            && at.elapsed() < Duration::from_secs(HOOK_TIMEOUT_SECS)
    }

    /// Das Terminal endet: Der Status fällt auf „unbekannt“. Liefert die
    /// Meldung dazu, wenn sich für die Person etwas ändert.
    pub fn forget(&mut self) -> Option<StatusUpdate> {
        let next = self.forgotten();
        self.apply(next)
    }

    /// Die laufenden Hintergrundaufgaben.
    pub fn background_tasks(&self) -> &[BackgroundTask] {
        &self.background_tasks
    }

    /// Die Kennung des laufenden Gesprächs.
    pub fn conversation(&self) -> Option<&str> {
        self.conversation.as_deref()
    }

    /// Die Hintergrundaufgabe `id` ist vorbei, ohne dass Claude Code es
    /// meldet, etwa nach einem Abbruch über `/tasks`. Liefert die Meldung,
    /// wenn sich für die Person etwas ändert.
    pub fn end_background_task(&mut self, id: &str) -> Option<StatusUpdate> {
        let mut next = self.clone();
        next.background_tasks.retain(|task| task.id != id);
        self.apply(next)
    }

    /// Ein Stand, in dem alles über das Gespräch vergessen ist. Welche
    /// Sitzung zuletzt endete, bleibt.
    fn forgotten(&self) -> TrackedAgent {
        TrackedAgent {
            ended: self.ended.clone(),
            ..TrackedAgent::default()
        }
    }

    /// Zustand und letzte Aktion, wie die Person sie sieht: Solange ein
    /// Subagent fragt, wartet der Agent. Wonach der Subagent fragt, steht in
    /// dessen Zeile; die letzte Aktion des Agenten bleibt. Ein fertiger
    /// Agent mit laufender Hintergrundaufgabe ist im Hintergrund.
    fn displayed_status(&self) -> (AgentState, Option<String>) {
        let state = if !self.asking.is_empty() {
            AgentState::Waiting
        } else if self.state == AgentState::Done && !self.background_tasks.is_empty() {
            AgentState::Background
        } else {
            self.state
        };
        (state, self.last_action.clone())
    }

    /// Übernimmt den neuen Stand und liefert die Meldung, wenn sich für die
    /// Person etwas geändert hat.
    fn apply(&mut self, next: TrackedAgent) -> Option<StatusUpdate> {
        let visible = |agent: &TrackedAgent| {
            (
                agent.displayed_status(),
                agent.assignment.clone(),
                agent.conversation.clone(),
                agent.subagents.clone(),
                agent.background_tasks.clone(),
            )
        };
        if visible(&next) == visible(self) {
            *self = next;
            return None;
        }
        Some(self.report(next, false))
    }

    fn report(&mut self, next: TrackedAgent, session_ended: bool) -> StatusUpdate {
        let (before, _) = self.displayed_status();
        *self = next;
        let (state, last_action) = self.displayed_status();
        StatusUpdate {
            state,
            last_action,
            state_changed: state != before,
            assignment: self.assignment.clone(),
            conversation: self.conversation.clone(),
            session_ended,
            subagents: self.subagents.clone(),
            background_tasks: self.background_tasks.clone(),
        }
    }

    /// Was Kredr nach dem Ereignis `event` über den Agenten weiß.
    fn next(&self, event: &Value) -> TrackedAgent {
        let name = event["hook_event_name"].as_str().unwrap_or_default();
        // Mit dem Leeren oder Wechseln des Gesprächs ist alles vergessen:
        // Status, Rückfragen, Subagenten, Auftrag und Gespräch.
        if name == "SessionEnd" {
            return self.forgotten();
        }
        let subagent = event["agent_id"].as_str().filter(|id| !id.is_empty());
        let mut next = self.clone();
        if is_prompt_of_person(event) {
            // Solange eine Rückfrage im Terminal steht, nimmt Claude Code keinen
            // Prompt an: Alle sind beantwortet, auch die, nach deren Ablehnung
            // Claude Code nichts mehr meldet. Ebenso abgelehnte Aufrufe des
            // `Agent`-Werkzeugs, die keinen Subagenten starten.
            next.asking.clear();
            next.unrepeated_permissions = 0;
            next.launches.clear();
        }
        // Claude Code wiederholt jede Genehmigungsabfrage etwa sechs Sekunden
        // später als `Notification` vom Typ `permission_prompt`, auch die eines
        // Subagenten, dann aber ohne `agent_id`, und mit der allgemeinen Meldung
        // „Claude needs your permission“. Von welcher Abfrage sie stammt und ob
        // sie noch offen ist, steht nicht darin. Darum zählt sie, solange eine
        // Abfrage aussteht, nur als deren Wiederholung und ändert nichts: Der
        // `PermissionRequest` hat das Warten schon gezeigt, und eine inzwischen
        // beantwortete Abfrage darf niemanden mehr warten lassen. Andere
        // wartende Meldungen (etwa `elicitation_dialog`) gehen keinem
        // Hook-Ereignis voraus und sind immer eine Rückfrage des Agenten selbst.
        let repeated_permission =
            name == "Notification" && event["notification_type"] == "permission_prompt";
        if name == "PermissionRequest" {
            next.unrepeated_permissions += 1;
        } else if repeated_permission && next.unrepeated_permissions > 0 {
            next.unrepeated_permissions -= 1;
            return next;
        }
        match subagent {
            // Ereignisse eines Subagenten ändern Status und letzte Aktion des
            // Agenten nicht. Nur seine Rückfragen lassen ihn warten; jedes
            // weitere Ereignis des Subagenten beantwortet sie.
            Some(subagent) => {
                next.asking.retain(|asking| asking != subagent);
                if question_of(event).is_some() {
                    next.asking.push(subagent.to_owned());
                }
            }
            None => {
                if let Some((state, last_action)) =
                    next_status(self.state, &self.last_action, event)
                {
                    next.state = state;
                    next.last_action = last_action;
                }
                if matches!(name, "Stop" | "StopFailure") {
                    // Bis zum Ende der Antwort ist jeder Aufruf des
                    // `Agent`-Werkzeugs gestartet oder abgelehnt.
                    next.launches.clear();
                }
            }
        }
        next.next_subagents(subagent, event);
        next.next_background_tasks(subagent.is_some(), event);
        next.mark_asking();
        next.assignment = next_assignment(&self.assignment, event);
        next.conversation = next_conversation(&self.conversation, event);
        next
    }

    /// Führt die Subagenten und die offenen Aufrufe des `Agent`-Werkzeugs nach
    /// dem Ereignis `event` fort; `subagent` ist die Kennung, falls es von einem
    /// Subagenten stammt.
    ///
    /// Ein Subagent entsteht mit `SubagentStart` und ist mit `SubagentStop`
    /// fertig. Claude Code meldet auch eigene Nebenläufe ohne Typ; sie und
    /// Ereignisse unbekannter Kennungen zählen nicht. Die Beschreibung steht nur
    /// im Aufruf des Agenten: Sicher verknüpft sie `PostToolUse(Agent)` mit der
    /// Kennung; bis dahin gilt der älteste offene Aufruf gleichen Typs.
    fn next_subagents(&mut self, subagent: Option<&str>, event: &Value) {
        let name = event["hook_event_name"].as_str().unwrap_or_default();
        let Some(id) = subagent else {
            let agent_tool = event["tool_name"] == "Agent";
            let tool_use = event["tool_use_id"].as_str().map(str::to_owned);
            match name {
                "PreToolUse" if agent_tool => {
                    let input = &event["tool_input"];
                    self.launches.push(Launch {
                        tool_use,
                        kind: input["subagent_type"]
                            .as_str()
                            .filter(|kind| !kind.is_empty())
                            .unwrap_or(DEFAULT_SUBAGENT_TYPE)
                            .to_owned(),
                        description: input["description"].as_str().and_then(one_line),
                    });
                }
                "PostToolUse" | "PostToolUseFailure" if agent_tool => {
                    if tool_use.is_some() {
                        self.launches.retain(|launch| launch.tool_use != tool_use);
                    }
                    let response = &event["tool_response"];
                    let description = response["description"]
                        .as_str()
                        .or_else(|| event["tool_input"]["description"].as_str())
                        .and_then(one_line);
                    let started = response["agentId"]
                        .as_str()
                        .and_then(|id| self.subagents.iter_mut().find(|known| known.id == id));
                    if let (Some(started), Some(description)) = (started, description) {
                        started.description = Some(description);
                    }
                }
                // Ein Prompt der Person beginnt eine neue Runde: Die fertigen
                // Subagenten der letzten verschwinden.
                _ if is_prompt_of_person(event) => {
                    self.subagents
                        .retain(|known| known.state != SubagentState::Done);
                }
                _ => {}
            }
            return;
        };
        if name == "SubagentStart" {
            let kind = event["agent_type"].as_str().unwrap_or_default();
            if kind.is_empty() || self.subagents.iter().any(|known| known.id == id) {
                return;
            }
            let launch = self
                .launches
                .iter()
                .position(|launch| launch.kind == kind)
                .map(|index| self.launches.remove(index));
            self.subagents.push(Subagent {
                id: id.to_owned(),
                kind: kind.to_owned(),
                description: launch.and_then(|launch| launch.description),
                state: SubagentState::Working,
                last_action: None,
            });
            return;
        }
        let Some(known) = self.subagents.iter_mut().find(|known| known.id == id) else {
            return;
        };
        match name {
            "PreToolUse" | "PermissionRequest" => {
                known.state = SubagentState::Working;
                known.last_action = match question_of(event) {
                    Some(question) => question.action,
                    None => tool_action(event),
                };
            }
            "SubagentStop" => {
                known.state = SubagentState::Done;
                if let Some(message) = event["last_assistant_message"].as_str().and_then(one_line) {
                    known.last_action = Some(message);
                }
            }
            _ => {}
        }
    }

    /// Führt die Hintergrundaufgaben nach dem Ereignis `event` fort;
    /// `from_subagent` sagt, ob es von einem Subagenten stammt.
    ///
    /// Jedes `Stop` des Agenten bringt die vollständige Liste; fehlt sie,
    /// läuft keine. Dazwischen nimmt `PostToolUse` eine gestartete
    /// Hintergrundaufgabe sofort auf, damit sie auch nach einem Abbruch der
    /// Antwort bekannt ist, nach dem kein `Stop` kommt. Startet ein Subagent
    /// eine Hintergrundaufgabe, endet sie meist mit seiner Antwort
    /// (`backgroundEndsWithFinalResponse`) und zählt dann nicht; überdauert
    /// sie ihn, zählt sie wie eine eigene des Agenten. Der Start eines
    /// Hintergrund-Subagenten trägt keine `backgroundTaskId` (gemessen mit
    /// Claude Code 2.1.330). `StopFailure` lässt die Liste, wie sie ist.
    fn next_background_tasks(&mut self, from_subagent: bool, event: &Value) {
        match event["hook_event_name"].as_str() {
            Some("Stop") if !from_subagent => self.background_tasks = background_tasks_of(event),
            Some("PostToolUse") => {
                let response = &event["tool_response"];
                let Some(id) = response["backgroundTaskId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                else {
                    return;
                };
                if response["backgroundEndsWithFinalResponse"] == true
                    || self.background_tasks.iter().any(|task| task.id == id)
                {
                    return;
                }
                let kind = task_kind_of(event["tool_name"].as_str().unwrap_or_default());
                self.background_tasks
                    .push(BackgroundTask::new(id, kind, &event["tool_input"]));
            }
            _ => {}
        }
    }

    /// Lässt die Subagenten mit offener Rückfrage warten und die übrigen, die
    /// noch nicht fertig sind, arbeiten.
    fn mark_asking(&mut self) {
        for subagent in &mut self.subagents {
            if subagent.state != SubagentState::Done {
                subagent.state = if self.asking.contains(&subagent.id) {
                    SubagentState::Waiting
                } else {
                    SubagentState::Working
                };
            }
        }
    }
}

/// Die laufenden Hintergrundaufgaben, die `event` in `background_tasks`
/// meldet. Subagenten zählen nicht, sie erscheinen als Subagenten; Typen, die
/// Kredr nicht kennt, zählen mit.
fn background_tasks_of(event: &Value) -> Vec<BackgroundTask> {
    let Some(tasks) = event["background_tasks"].as_array() else {
        return Vec::new();
    };
    tasks
        .iter()
        .filter(|task| task["status"] == "running" && task["type"] != "subagent")
        .filter_map(|task| {
            let id = task["id"].as_str().filter(|id| !id.is_empty())?;
            let kind = task["type"].as_str().unwrap_or_default().to_owned();
            Some(BackgroundTask::new(id, kind, task))
        })
        .collect()
}

impl BackgroundTask {
    /// Die Hintergrundaufgabe `id` vom Typ `kind`; Beschreibung und Befehl
    /// stehen in `fields` unter `description` und `command`.
    fn new(id: &str, kind: String, fields: &Value) -> BackgroundTask {
        BackgroundTask {
            id: id.to_owned(),
            kind,
            description: fields["description"].as_str().and_then(one_line),
            command: fields["command"].as_str().map(str::to_owned),
        }
    }
}

/// Der Typ einer Hintergrundaufgabe, die das Werkzeug `tool` gestartet hat,
/// wie `Stop` ihn nennen wird. Bis dahin genügt eine Annäherung.
fn task_kind_of(tool: &str) -> String {
    match tool {
        "Bash" | "PowerShell" => "shell".to_owned(),
        _ => tool.to_lowercase(),
    }
}

/// Ob `event` ein Prompt der Person ist. Auch über das Ende eines Subagenten
/// unterrichtet Claude Code den Agenten mit einem Prompt; der zählt nicht.
fn is_prompt_of_person(event: &Value) -> bool {
    event["hook_event_name"] == "UserPromptSubmit"
        && !event["prompt"].as_str().is_some_and(|prompt| {
            let prompt = prompt.trim_start();
            PROMPTS_OF_CLAUDE_CODE
                .iter()
                .any(|start| prompt.starts_with(start))
        })
}

/// Die Rückfrage, die das Ereignis `event` an die Person stellt; `None`,
/// wenn es keine Rückfrage ist.
fn question_of(event: &Value) -> Option<Question> {
    let action = match event["hook_event_name"].as_str()? {
        "PermissionRequest" => tool_action(event),
        "PreToolUse" if event["tool_name"] == "AskUserQuestion" => event["tool_input"]["questions"]
            [0]["question"]
            .as_str()
            .and_then(one_line)
            .or_else(|| tool_action(event)),
        _ => return None,
    };
    Some(Question { action })
}

/// Der Auftrag nach dem Ereignis `event`: Nur der erste Prompt einer Sitzung
/// zählt, der von der Person kommt. Nach dem Ende der Sitzung, auch durch
/// `/clear`, beginnt der nächste Prompt die neue Sitzung.
fn next_assignment(assignment: &Option<String>, event: &Value) -> Option<String> {
    if assignment.is_none() && is_prompt_of_person(event) {
        let prompt = event["prompt"].as_str()?.trim();
        return (!prompt.is_empty()).then(|| prompt.to_owned());
    }
    assignment.clone()
}

/// Das Gespräch nach dem Ereignis `event`: das, dessen Kennung die Meldung
/// trägt. Nach dem Ende der Sitzung, auch durch `/clear`, kommt das neue
/// Gespräch mit dem nächsten Prompt.
fn next_conversation(conversation: &Option<String>, event: &Value) -> Option<String> {
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
    if let Some(question) = question_of(event) {
        return Some((AgentState::Waiting, question.action));
    }
    match event["hook_event_name"].as_str()? {
        // Die Sitzung beginnt: Der Agent wartet auf den ersten Prompt. Kommt
        // `SessionStart` später, etwa nach `/compact` oder verspätet aus dem
        // Befehls-Hook, gilt der Status, den der Agent schon hat.
        "SessionStart" if state == AgentState::Unknown => Some((AgentState::Waiting, None)),
        "UserPromptSubmit" => Some((AgentState::Working, None)),
        "PreToolUse" => Some((AgentState::Working, tool_action(event))),
        "PostToolUse" | "PostToolUseFailure" => Some((AgentState::Working, last_action.clone())),
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
