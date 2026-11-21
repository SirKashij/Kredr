//! Der Automat des Agentenstatus: Er macht aus den Ereignissen, die Claude
//! Code für ein Terminal meldet, den Agentenstatus, wie die Person ihn sieht.
//! Wie die Ereignisse ankommen, weiß er nicht.

use std::path::Path;

use serde_json::Value;

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
    /// Die Subagenten des Agenten in der Reihenfolge ihres Starts: die
    /// laufenden und die seit dem letzten Prompt der Person fertigen.
    pub subagents: Vec<Subagent>,
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
    /// Der Auftrag des laufenden Gesprächs.
    assignment: Option<String>,
    /// Die Kennung des laufenden Gesprächs.
    conversation: Option<String>,
    /// Ob der Agent gestartet ist. Ein fortgesetzter Agent ist es erst mit
    /// seiner ersten Meldung; findet Claude Code das Gespräch nicht, meldet
    /// es nur `SessionEnd`.
    started: bool,
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
            started: resumed.is_none(),
            assignment: resumed.as_ref().and_then(|r| r.assignment.clone()),
            conversation: resumed.map(|r| r.conversation),
            ..TrackedAgent::default()
        }
    }

    /// Nimmt ein Ereignis an, wie Claude Code es einem Hook übergibt. Liefert
    /// den neuen Agentenstatus, wenn sich für die Person etwas sichtbar
    /// ändert, sonst `None`.
    pub fn on_event(&mut self, event: &Value) -> Option<StatusUpdate> {
        if event["hook_event_name"] != "SessionEnd" {
            self.started = true;
        } else if !self.started {
            // Das Gespräch ließ sich nicht fortsetzen: Kredr vergisst es und
            // meldet das.
            let next = self.forgotten();
            return Some(self.report(next, true));
        }
        let next = self.next(event);
        self.apply(next)
    }

    /// Das Terminal endet: Der Status fällt auf „unbekannt“. Liefert die
    /// Meldung dazu, wenn sich für die Person etwas ändert.
    pub fn forget(&mut self) -> Option<StatusUpdate> {
        let next = self.forgotten();
        self.apply(next)
    }

    /// Ein Stand, in dem alles über das Gespräch vergessen ist. Ob der Agent
    /// gestartet ist, bleibt.
    fn forgotten(&self) -> TrackedAgent {
        TrackedAgent {
            started: self.started,
            ..TrackedAgent::default()
        }
    }

    /// Zustand und letzte Aktion, wie die Person sie sieht: Solange ein
    /// Subagent fragt, wartet der Agent. Wonach der Subagent fragt, steht in
    /// dessen Zeile; die letzte Aktion des Agenten bleibt.
    fn displayed_status(&self) -> (AgentState, Option<String>) {
        let state = if self.asking.is_empty() {
            self.state
        } else {
            AgentState::Waiting
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
            )
        };
        if visible(&next) == visible(self) {
            *self = next;
            return None;
        }
        Some(self.report(next, false))
    }

    fn report(&mut self, next: TrackedAgent, resume_failed: bool) -> StatusUpdate {
        let (before, _) = self.displayed_status();
        *self = next;
        let (state, last_action) = self.displayed_status();
        StatusUpdate {
            state,
            last_action,
            state_changed: state != before,
            assignment: self.assignment.clone(),
            conversation: self.conversation.clone(),
            resume_failed,
            subagents: self.subagents.clone(),
        }
    }

    /// Was Kredr nach dem Ereignis `event` über den Agenten weiß.
    fn next(&self, event: &Value) -> TrackedAgent {
        let name = event["hook_event_name"].as_str().unwrap_or_default();
        // Mit dem Ende der Sitzung, auch durch `/clear`, ist alles vergessen:
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
