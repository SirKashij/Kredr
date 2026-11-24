//! Die Aktualisierung von Kredr: sucht kurz nach dem Start und danach alle
//! drei Stunden nach einer neuen Version, hält den Zustand für alle Fenster
//! und meldet jede Änderung mit dem Ereignis `app-update-changed`. Die
//! Entwicklungsfassung sucht nie.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Meldet allen Fenstern den neuen Zustand.
const CHANGED: &str = "app-update-changed";
/// So lange nach dem Start sucht Kredr zum ersten Mal; der Start geht vor.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
/// So oft sucht Kredr danach erneut.
const CHECK_EVERY: Duration = Duration::from_secs(3 * 60 * 60);

/// Wie weit die Aktualisierung ist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    None,
    Offered,
    Later,
    Downloading,
    Installing,
    Failed,
}

/// Was alle Fenster über die Aktualisierung wissen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    pub phase: Phase,
    /// Die neue Version, sobald eine gefunden ist.
    pub version: Option<String>,
    /// Die installierte Fassung.
    pub installed: String,
    /// Warum die Aktualisierung zuletzt scheiterte.
    pub error: Option<String>,
}

impl AppUpdateState {
    pub fn new(installed: impl Into<String>) -> Self {
        Self {
            phase: Phase::None,
            version: None,
            installed: installed.into(),
            error: None,
        }
    }

    /// Eine Suche fand `version`. Sie wird angeboten, außer die Person hat
    /// dieselbe schon auf „Später“ gestellt oder eine Aktualisierung läuft.
    /// Gibt zurück, ob sich der Zustand geändert hat.
    pub fn found(&mut self, version: String) -> bool {
        let offer = match self.phase {
            Phase::None => true,
            Phase::Offered | Phase::Later | Phase::Failed => {
                self.version.as_deref() != Some(version.as_str())
            }
            Phase::Downloading | Phase::Installing => false,
        };
        if offer {
            self.phase = Phase::Offered;
            self.version = Some(version);
            self.error = None;
        }
        offer
    }

    /// „Später“: schließt das Angebot. Gibt zurück, ob sich der Zustand geändert hat.
    pub fn later(&mut self) -> bool {
        let closes = matches!(self.phase, Phase::Offered | Phase::Failed);
        if closes {
            self.phase = Phase::Later;
        }
        closes
    }

    /// „Jetzt aktualisieren“: beginnt den Download, wenn eine neue Version
    /// angeboten ist und noch keine Aktualisierung läuft.
    pub fn start_download(&mut self) -> bool {
        let starts = matches!(self.phase, Phase::Offered | Phase::Later | Phase::Failed);
        if starts {
            self.phase = Phase::Downloading;
            self.error = None;
        }
        starts
    }

    /// Der Download ist fertig und geprüft; der Installer startet.
    pub fn start_install(&mut self) {
        self.phase = Phase::Installing;
    }

    /// Die Aktualisierung ist gescheitert; sie lässt sich erneut anstoßen.
    pub fn fail(&mut self, error: String) {
        self.phase = Phase::Failed;
        self.error = Some(error);
    }
}

/// Der Zustand der Aktualisierung und die zuletzt gefundene neue Version.
pub struct AppUpdates {
    inner: Mutex<(AppUpdateState, Option<Update>)>,
}

impl AppUpdates {
    fn new(installed: String) -> Self {
        Self {
            inner: Mutex::new((AppUpdateState::new(installed), None)),
        }
    }

    fn state(&self) -> AppUpdateState {
        self.inner.lock().unwrap().0.clone()
    }

    /// Ändert den Zustand und meldet ihn allen Fenstern, wenn `change` es sagt.
    fn change(
        &self,
        app: &AppHandle,
        change: impl FnOnce(&mut AppUpdateState, &mut Option<Update>) -> bool,
    ) {
        let mut inner = self.inner.lock().unwrap();
        let (state, update) = &mut *inner;
        if change(state, update) {
            // Scheitert das Senden, ist kein Fenster mehr offen.
            let _ = app.emit(CHANGED, &*state);
        }
    }
}

/// Richtet die Aktualisierung ein. Nur die installierte Fassung sucht.
pub fn start(app: &AppHandle) {
    app.manage(AppUpdates::new(app.package_info().version.to_string()));
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        loop {
            tauri::async_runtime::block_on(check(&app));
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// Sucht einmal nach einer neuen Version. Ohne Netz oder bei einer kaputten
/// `latest.json` bleibt es still; die nächste Suche versucht es erneut.
async fn check(app: &AppHandle) {
    let Ok(updater) = app.updater() else {
        return;
    };
    let Ok(Some(found)) = updater.check().await else {
        return;
    };
    app.state::<AppUpdates>().change(app, |state, update| {
        let offered = state.found(found.version.clone());
        if offered {
            *update = Some(found);
        }
        offered
    });
}

#[tauri::command]
pub fn app_update_state(updates: State<'_, AppUpdates>) -> AppUpdateState {
    updates.state()
}

/// „Später“ aus einem Fenster gilt für alle.
#[tauri::command]
pub fn app_update_later(app: AppHandle, updates: State<'_, AppUpdates>) {
    updates.change(&app, |state, _| state.later());
}

/// Lädt die neue Version, prüft ihre Signatur und startet den Installer im
/// Modus `passive`. Er beendet Kredr und startet es nach der Installation neu.
/// Scheitert ein Schritt, meldet der Zustand den Grund.
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
) -> Result<(), String> {
    let mut pending = None;
    updates.change(&app, |state, update| {
        let Some(update) = update.clone() else {
            return false;
        };
        let starts = state.start_download();
        if starts {
            pending = Some(update);
        }
        starts
    });
    let Some(update) = pending else {
        return Ok(());
    };
    let result = async {
        let bytes = update.download(|_, _| {}, || {}).await?;
        updates.change(&app, |state, _| {
            state.start_install();
            true
        });
        update.install(bytes)
    }
    .await;
    if let Err(error) = result {
        updates.change(&app, |state, _| {
            state.fail(error.to_string());
            true
        });
    }
    Ok(())
}
