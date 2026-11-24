//! Meldet einem Nutzer, dass in einem Fenster Agenten auf Eingabe warten:
//! verbindet die Benachrichtigungen und das Taskleisten-Symbol mit den
//! Fenstern von Kredr. Wann das fällig ist, entscheidet die Oberfläche.

use tauri::{AppHandle, Emitter, Manager, Runtime, State, UserAttentionType, Window};

use crate::notifications::Notifications;

/// Sagt einem Fenster, zu welchem Tab der Klick auf die Benachrichtigung führt.
const WAITING_AGENT_SELECTED: &str = "waiting-agent-selected";

/// Die Entwicklungsfassung ist nicht installiert und hat daher keine eigene
/// Kennung bei Windows. Sie meldet sich unter der von Windows PowerShell,
/// damit ihre Benachrichtigungen überhaupt erscheinen.
const DEVELOPMENT_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

pub fn start(app: &AppHandle) {
    // Der Installer hinterlegt die Kennung von Kredr an der Verknüpfung im Startmenü.
    let app_id = if cfg!(debug_assertions) {
        DEVELOPMENT_APP_ID
    } else {
        app.config().identifier.as_str()
    };
    app.manage(Notifications::new(app_id));
}

/// Lässt das Taskleisten-Symbol des aufrufenden Fensters auf sich aufmerksam
/// machen, bis es den Fokus erhält, und zeigt mit `notification` dazu seine
/// Benachrichtigung. Ein Klick auf die Benachrichtigung holt das Fenster nach
/// vorn und nennt ihm `tab_id`.
#[tauri::command(async)]
pub fn waiting_alert(
    app: AppHandle,
    window: Window,
    notifications: State<'_, Notifications>,
    title: String,
    body: String,
    tab_id: String,
    notification: bool,
) -> Result<(), String> {
    let in_foreground = || window.is_focused().unwrap_or(false);
    if in_foreground() {
        return Ok(());
    }
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));
    // Der Schalter „Benachrichtigungen“ gilt nur der Windows-Benachrichtigung.
    if !notification {
        return Ok(());
    }
    let label = window.label().to_string();
    let shown = notifications.show(window.label(), &title, &body, move || {
        crate::projects::focus(&app, &label);
        // Scheitert das Senden, ist das Fenster inzwischen geschlossen.
        let _ = app.emit_to(label.as_str(), WAITING_AGENT_SELECTED, &tab_id);
    });
    // Kam das Fenster währenddessen nach vorn, hat es seine Benachrichtigung
    // schon zurückgenommen, bevor es sie gab.
    if in_foreground() {
        notifications.clear(window.label());
    }
    shown.map_err(|e| e.to_string())
}

/// Nimmt die Benachrichtigung des aufrufenden Fensters zurück.
#[tauri::command(async)]
pub fn waiting_alert_clear(window: Window, notifications: State<'_, Notifications>) {
    notifications.clear(window.label());
}

/// Die Benachrichtigung eines geschlossenen Fensters führte nirgends mehr hin.
pub fn window_closed<R: Runtime>(window: &Window<R>) {
    window.state::<Notifications>().clear(window.label());
}
