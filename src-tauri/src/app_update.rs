//! Die Aktualisierung von Kredr: sucht kurz nach dem Start und danach alle
//! drei Stunden nach einer neuen Version, hält den Zustand für alle Fenster
//! und meldet jede Änderung mit dem Ereignis `app-update-changed`. Die
//! Entwicklungsfassung sucht nie.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Meldet allen Fenstern den neuen Zustand.
const CHANGED: &str = "app-update-changed";
/// So lange nach dem Start sucht Kredr zum ersten Mal; der Start geht vor.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
/// So oft sucht Kredr danach erneut.
const CHECK_EVERY: Duration = Duration::from_secs(3 * 60 * 60);
/// Die Datei im Benutzerdatenverzeichnis mit der abgelehnten Version.
const FILE_NAME: &str = "app-update.json";
/// Version des gespeicherten Formats.
const FILE_VERSION: u32 = 1;

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
    /// Die Version, die die Person auf „Später“ gestellt hat. Sie bietet
    /// sich nicht wieder als Hinweis an, auch nach einem Neustart nicht.
    #[serde(skip)]
    declined: Option<String>,
}

impl AppUpdateState {
    /// `declined` ist die Version, die die Person früher auf „Später“ gestellt hat.
    pub fn new(installed: impl Into<String>, declined: Option<String>) -> Self {
        Self {
            phase: Phase::None,
            version: None,
            installed: installed.into(),
            error: None,
            declined,
        }
    }

    /// Die Version, die die Person auf „Später“ gestellt hat.
    pub fn declined(&self) -> Option<&str> {
        self.declined.as_deref()
    }

    /// Eine Suche fand `version`. Sie wird angeboten, außer eine
    /// Aktualisierung läuft. Hat die Person dieselbe schon auf „Später“
    /// gestellt, steht nur das Symbol. Gibt zurück, ob sich der Zustand
    /// geändert hat.
    pub fn found(&mut self, version: String) -> bool {
        let changes = match self.phase {
            Phase::None => true,
            Phase::Offered | Phase::Later | Phase::Failed => {
                self.version.as_deref() != Some(version.as_str())
            }
            Phase::Downloading | Phase::Installing => false,
        };
        if changes {
            self.phase = if self.declined.as_deref() == Some(version.as_str()) {
                Phase::Later
            } else {
                Phase::Offered
            };
            self.version = Some(version);
            self.error = None;
        }
        changes
    }

    /// „Später“: schließt das Angebot und merkt sich die Version. Gibt
    /// zurück, ob sich der Zustand geändert hat.
    pub fn later(&mut self) -> bool {
        let closes = matches!(self.phase, Phase::Offered | Phase::Failed);
        if closes {
            self.phase = Phase::Later;
            self.declined = self.version.clone();
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

/// Die abgelehnte Version, die `dir`, das Benutzerdatenverzeichnis, sich
/// gemerkt hat. Eine fehlende oder kaputte Datei merkt keine.
pub fn load_declined(dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    serde_json::from_str::<DeclinedFile>(&content)
        .ok()
        .map(|file| file.declined)
}

/// Merkt sich in `dir`, dem Benutzerdatenverzeichnis, die abgelehnte Version.
pub fn save_declined(dir: &Path, version: &str) -> io::Result<()> {
    let content = serde_json::to_string_pretty(&DeclinedFile {
        version: FILE_VERSION,
        declined: version.to_owned(),
    })?;
    crate::paths::write_whole(&dir.join(FILE_NAME), content)
}

/// Die Datei mit der abgelehnten Version.
#[derive(Serialize, Deserialize)]
struct DeclinedFile {
    /// Version des gespeicherten Formats, wie bei den Einstellungen.
    version: u32,
    declined: String,
}

/// Der Zustand der Aktualisierung und die zuletzt gefundene neue Version.
pub struct AppUpdates {
    inner: Mutex<(AppUpdateState, Option<Update>)>,
    /// Wo die abgelehnte Version liegt; ohne Benutzerdatenverzeichnis nirgends.
    dir: Option<PathBuf>,
}

impl AppUpdates {
    fn new(installed: String, dir: Option<PathBuf>) -> Self {
        let declined = dir.as_deref().and_then(load_declined);
        Self {
            inner: Mutex::new((AppUpdateState::new(installed, declined), None)),
            dir,
        }
    }

    fn state(&self) -> AppUpdateState {
        self.inner.lock().unwrap().0.clone()
    }

    /// „Später“: schließt das Angebot in allen Fenstern und merkt sich die
    /// Version im Benutzerdatenverzeichnis.
    fn later(&self, app: &AppHandle) {
        let mut declined = None;
        self.change(app, |state, _| {
            let closes = state.later();
            if closes {
                declined = state.declined().map(str::to_owned);
            }
            closes
        });
        if let (Some(dir), Some(version)) = (&self.dir, declined) {
            // Scheitert das Speichern, gilt „Später“ nur bis zum Neustart.
            let _ = save_declined(dir, &version);
        }
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
    app.manage(AppUpdates::new(
        app.package_info().version.to_string(),
        crate::data_dir(app).ok(),
    ));
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

/// „Später“ aus einem Fenster gilt für alle. Die Version merkt sich Kredr
/// über einen Neustart hinaus.
#[tauri::command]
pub fn app_update_later(app: AppHandle, updates: State<'_, AppUpdates>) {
    updates.later(&app);
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
