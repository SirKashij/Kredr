//! Die Rundfrage aus dem Kern: Er stellt allen offenen Fenstern eine Frage
//! und sammelt ihre Antworten, etwa die Anlässe vor einer Aktualisierung.
//! Jedes Fenster antwortet aus seiner Webview (`answerPolls` in `App.tsx`);
//! ein Fenster, das nicht rechtzeitig antwortet, gilt als stumm.
//!
//! Die Frage geht als Ereignis `window-poll` an die Fenster, die Antwort
//! kommt per Befehl `window_poll_answer` zurück. Ein Ereignis an einen
//! Rust-Listener stellt Tauri nicht sicher zu, wenn ein anderer Thread gerade
//! eines sendet: Es landet in einer Warteschlange, die erst das nächste
//! Ereignis mit Rust-Listenern leert (`try_lock` in
//! `tauri/src/event/listener.rs`). Eine Antwort als Ereignis ging so manchmal
//! verloren, und das Fenster galt als stumm. Ereignisse an die Webviews
//! betrifft das nicht.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tokio::sync::mpsc::UnboundedSender;

/// Fragt alle Fenster.
const QUESTION: &str = "window-poll";

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

/// Die Antwort eines Fensters: sein Label und was es antwortet.
type Answer = (String, Value);

/// Die laufenden Rundfragen: zu jeder Kennung, wohin ihre Antworten gehen.
#[derive(Default)]
pub struct WindowPolls(Mutex<HashMap<String, UnboundedSender<Answer>>>);

/// Meldet eine Rundfrage wieder ab, wenn sie endet, auch vorzeitig.
struct Running<'a> {
    polls: &'a WindowPolls,
    id: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.polls.0.lock().unwrap().remove(&self.id);
    }
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
    let polls = app.state::<WindowPolls>();
    polls.0.lock().unwrap().insert(id.clone(), send);
    let _running = Running {
        polls: polls.inner(),
        id: id.clone(),
    };
    app.emit(QUESTION, Question { id, question })
        .map_err(|error| error.to_string())?;
    let mut collected: HashMap<String, Value> = HashMap::new();
    let deadline = tokio::time::Instant::now() + timeout;
    while windows.iter().any(|window| !collected.contains_key(window)) {
        match tokio::time::timeout_at(deadline, answers.recv()).await {
            Ok(Some((window, answer))) => {
                if windows.contains(&window) {
                    collected.entry(window).or_insert(answer);
                }
            }
            _ => break,
        }
    }
    Ok(windows
        .iter()
        .map(|window| collected.remove(window).filter(|answer| !answer.is_null()))
        .collect())
}

/// Die Antwort des aufrufenden Fensters auf die Rundfrage `id`; `null`, wenn
/// es keine Antwort fand. Ist die Rundfrage schon vorbei, verfällt sie.
#[tauri::command]
pub fn window_poll_answer<R: Runtime>(
    window: WebviewWindow<R>,
    polls: State<'_, WindowPolls>,
    id: String,
    answer: Value,
) {
    if let Some(send) = polls.0.lock().unwrap().get(&id) {
        let _ = send.send((window.label().to_owned(), answer));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use serde_json::json;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::{App, Listener, WebviewUrl, WebviewWindowBuilder};

    use super::*;

    /// Kredr mit einem Fenster `main`.
    fn kredr() -> App<MockRuntime> {
        let app = mock_builder()
            .manage(WindowPolls::default())
            .build(mock_context(noop_assets()))
            .expect("die Mock-App sollte starten");
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .expect("das Fenster sollte sich öffnen");
        app
    }

    /// Sendet aus einem eigenen Thread Ereignisse ohne Rust-Listener, wie der
    /// Kern `app-update-changed`, bis `stop` gesetzt ist.
    fn noise(app: &AppHandle<MockRuntime>, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
        let app = app.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let _ = app.emit("rauschen", ());
            }
        })
    }

    #[test]
    fn eine_antwort_kommt_an_auch_wenn_gleichzeitig_andere_ereignisse_laufen() {
        let app = kredr();
        let handle = app.handle().clone();
        let (quiet, quiets) = std::sync::mpsc::channel();
        // Das Fenster antwortet wie eine Webview aus einem eigenen Thread,
        // während der Kern andere Ereignisse sendet. Als Ereignis ginge die
        // Antwort dabei manchmal verloren (siehe Modulkopf).
        app.listen_any(QUESTION, move |event| {
            let poll: Value = serde_json::from_str(event.payload()).unwrap();
            let (handle, quiet) = (handle.clone(), quiet.clone());
            std::thread::spawn(move || {
                let stop = Arc::new(AtomicBool::new(false));
                let noise = noise(&handle, stop.clone());
                std::thread::sleep(Duration::from_micros(50));
                let window = handle.get_webview_window("main").unwrap();
                let id = poll["id"].as_str().unwrap().to_owned();
                window_poll_answer(window, handle.state(), id, json!(1));
                stop.store(true, Ordering::Relaxed);
                noise.join().unwrap();
                quiet.send(()).unwrap();
            });
        });

        for round in 0..300 {
            let answers = tauri::async_runtime::block_on(poll_windows(
                app.handle(),
                PollQuestion::UpdateReasons,
                Duration::from_millis(500),
            ))
            .unwrap();
            assert_eq!(answers, vec![Some(json!(1))], "Runde {round}");
            // Die nächste Frage hört der Fake in Rust; sie darf nicht ins
            // Rauschen dieser Runde fallen.
            quiets
                .recv_timeout(Duration::from_secs(5))
                .expect("das Rauschen sollte enden");
        }
    }
}
