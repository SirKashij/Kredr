//! Die Rundfrage aus dem Kern: Er stellt allen offenen Fenstern eine Frage
//! und sammelt ihre Antworten, etwa die Anlässe vor einer Aktualisierung.
//! Jedes Fenster antwortet aus seiner Webview (`answerPolls` in `App.tsx`);
//! ein Fenster, das nicht rechtzeitig antwortet, gilt als stumm.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

/// Fragt alle Fenster.
const QUESTION: &str = "window-poll";
/// Die Antwort eines Fensters.
const ANSWER: &str = "window-poll-answer";

/// So lange wartet die Rundfrage höchstens auf ein Fenster, das nicht antwortet.
pub const POLL_TIMEOUT: Duration = Duration::from_secs(3);

/// Die Fragen an alle Fenster.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PollQuestion {
    /// Was beim Beenden des Fensters verloren ginge oder abbräche (`UpdateReasons`).
    UpdateReasons,
    /// Das Fenster speichert seine Aufteilung und antwortet danach.
    SaveArrangement,
}

#[derive(Clone, Serialize)]
struct Question {
    id: String,
    question: PollQuestion,
}

#[derive(Deserialize)]
struct Answer {
    id: String,
    window: String,
    /// `null`, wenn das Fenster keine Antwort fand.
    answer: Value,
}

/// Unterscheidet gleichzeitige Rundfragen; die Fenster nennen sie in der Antwort.
static NEXT_POLL: AtomicU64 = AtomicU64::new(0);

/// Stellt allen offenen Fenstern die Frage `question` und gibt ihre Antworten
/// zurück. Ein Fenster, das nach `timeout` nicht geantwortet hat oder keine
/// Antwort fand, antwortet `None`: Ein stummes Fenster hält nichts dauerhaft
/// auf. Scheitert nur, wenn sich die Frage nicht senden lässt.
pub async fn poll_windows<R: Runtime>(
    app: &AppHandle<R>,
    question: PollQuestion,
    timeout: Duration,
) -> Result<Vec<Option<Value>>, String> {
    let windows: Vec<String> = app.webview_windows().into_keys().collect();
    let id = format!("kern-{}", NEXT_POLL.fetch_add(1, Ordering::Relaxed));
    let (send, mut answers) = tokio::sync::mpsc::unbounded_channel::<Answer>();
    let ours = id.clone();
    let listener = app.listen_any(ANSWER, move |event| {
        if let Ok(answer) = serde_json::from_str::<Answer>(event.payload()) {
            if answer.id == ours {
                let _ = send.send(answer);
            }
        }
    });
    let mut collected: HashMap<String, Value> = HashMap::new();
    let asked = app.emit(
        QUESTION,
        Question {
            id: id.clone(),
            question,
        },
    );
    if let Err(error) = asked {
        app.unlisten(listener);
        return Err(error.to_string());
    }
    let deadline = tokio::time::Instant::now() + timeout;
    while windows.iter().any(|window| !collected.contains_key(window)) {
        match tokio::time::timeout_at(deadline, answers.recv()).await {
            Ok(Some(answer)) => {
                if windows.contains(&answer.window) {
                    collected.entry(answer.window).or_insert(answer.answer);
                }
            }
            _ => break,
        }
    }
    app.unlisten(listener);
    Ok(windows
        .iter()
        .map(|window| collected.remove(window).filter(|answer| !answer.is_null()))
        .collect())
}
