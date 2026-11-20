//! Benachrichtigungen: zeigt Windows-Benachrichtigungen und meldet den Klick
//! darauf an den laufenden Prozess zurück. Je Schlüssel (für Kredr: je
//! Fenster) gibt es höchstens eine; eine neue ersetzt die alte, auch im
//! Benachrichtigungscenter. Wann eine Benachrichtigung fällig ist,
//! entscheidet die Oberfläche.

use std::collections::HashMap;
use std::io;
use std::sync::Mutex;

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

/// Fasst die Benachrichtigungen von Kredr im Benachrichtigungscenter zusammen.
const GROUP: &str = "kredr";

pub struct Notifications {
    /// Die Kennung (AppUserModelID), unter der Windows Name und Symbol der
    /// Anwendung findet. Der Installer hinterlegt sie an der Verknüpfung im
    /// Startmenü; ohne diese zeigt Windows nichts an.
    app_id: HSTRING,
    /// Die gezeigten Benachrichtigungen. Der Klick wird nur gemeldet, solange
    /// die Benachrichtigung hier gehalten wird.
    shown: Mutex<HashMap<String, ToastNotification>>,
}

impl Notifications {
    pub fn new(app_id: &str) -> Notifications {
        Notifications {
            app_id: app_id.into(),
            shown: Mutex::new(HashMap::new()),
        }
    }

    /// Zeigt eine Benachrichtigung und ersetzt die bisherige mit demselben
    /// Schlüssel. `on_click` läuft bei einem Klick darauf, in einem
    /// Hintergrund-Thread.
    pub fn show(
        &self,
        key: &str,
        title: &str,
        body: &str,
        on_click: impl Fn() + Send + 'static,
    ) -> io::Result<()> {
        let document = XmlDocument::new()?;
        document.LoadXml(&toast_content(title, body).into())?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        toast.SetTag(&key.into())?;
        toast.SetGroup(&GROUP.into())?;
        // Nach einem Neustart läuft der Agent nicht mehr, auf den sie zeigt.
        toast.SetExpiresOnReboot(true)?;
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            on_click();
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&self.app_id)?.Show(&toast)?;
        self.lock().insert(key.to_owned(), toast);
        Ok(())
    }

    /// Nimmt die Benachrichtigung mit diesem Schlüssel zurück, auch aus dem
    /// Benachrichtigungscenter.
    pub fn clear(&self, key: &str) {
        if self.lock().remove(key).is_none() {
            return;
        }
        // Scheitert das, bleibt nur ein veralteter Eintrag im Benachrichtigungscenter.
        let _ = ToastNotificationManager::History().and_then(|history| {
            history.RemoveGroupedTagWithId(&key.into(), &GROUP.into(), &self.app_id)
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ToastNotification>> {
        self.shown.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Der Inhalt einer Benachrichtigung im Format von Windows: eine Titelzeile
/// und eine Textzeile.
pub fn toast_content(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escaped(title),
        escaped(body)
    )
}

fn escaped(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
