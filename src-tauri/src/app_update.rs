//! Die Aktualisierung von Kredr: sucht kurz nach dem Start und danach alle
//! drei Stunden nach einer neuen Version, solange die Einstellung es erlaubt,
//! und auf Wunsch mit „Jetzt suchen“. Hält den Zustand für alle Fenster und
//! meldet jede Änderung mit dem Ereignis `app-update-changed`. Die
//! Entwicklungsfassung sucht nur auf Wunsch.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::SettingsStore;

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
    /// Wie weit der Download ist, in ganzen Prozent; ohne bekannte Größe keiner.
    pub progress: Option<u8>,
    /// Ob die Person den Hinweis zum laufenden Download weggeklickt hat. Dann
    /// zeigt nur das Symbol den Fortschritt.
    pub hidden: bool,
    /// Warum die Aktualisierung zuletzt scheiterte, eingeordnet.
    pub cause: Option<FailureCause>,
    /// Der Originaltext des letzten Fehlschlags.
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
            progress: None,
            hidden: false,
            cause: None,
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
            self.cause = None;
            self.error = None;
        }
        changes
    }

    /// „Jetzt suchen“ fand `version`. Die Person hat selbst gefragt, deshalb
    /// erscheint das Angebot auch für eine Version, die sie auf „Später“
    /// gestellt hat, und nach einem Fehlschlag. Eine laufende Aktualisierung
    /// bleibt unberührt. Gibt
    /// zurück, ob sich der Zustand geändert hat.
    pub fn found_on_request(&mut self, version: String) -> bool {
        let same = self.version.as_deref() == Some(version.as_str());
        let changes = if same && matches!(self.phase, Phase::Later | Phase::Failed) {
            self.cause = None;
            self.error = None;
            true
        } else {
            self.found(version)
        };
        if changes {
            self.phase = Phase::Offered;
        }
        changes
    }

    /// „Später“: schließt das Angebot und merkt sich die Version. Während
    /// des Downloads blendet es nur den Hinweis aus; das Symbol zeigt dann
    /// den Fortschritt. Gibt zurück, ob sich der Zustand geändert hat.
    pub fn later(&mut self) -> bool {
        match self.phase {
            Phase::Offered | Phase::Failed => {
                self.phase = Phase::Later;
                self.declined = self.version.clone();
                true
            }
            Phase::Downloading if !self.hidden => {
                self.hidden = true;
                true
            }
            _ => false,
        }
    }

    /// „Jetzt aktualisieren“: beginnt den Download, wenn eine neue Version
    /// angeboten ist und noch keine Aktualisierung läuft. Aus dem Symbol
    /// angestoßen, zeigt nur das Symbol den Fortschritt.
    pub fn start_download(&mut self) -> bool {
        let starts = matches!(self.phase, Phase::Offered | Phase::Later | Phase::Failed);
        if starts {
            self.hidden = self.phase == Phase::Later;
            self.phase = Phase::Downloading;
            self.progress = Some(0);
            self.cause = None;
            self.error = None;
        }
        starts
    }

    /// Vom Download sind `done` Bytes da, von `total`, falls bekannt. Gibt
    /// zurück, ob sich der Fortschritt in ganzen Prozent geändert hat.
    pub fn downloaded(&mut self, done: u64, total: Option<u64>) -> bool {
        if self.phase != Phase::Downloading {
            return false;
        }
        let progress = total
            .filter(|&total| total > 0)
            .map(|total| (done.min(total) * 100 / total) as u8);
        let changes = self.progress != progress;
        self.progress = progress;
        changes
    }

    /// Der Download ist fertig und geprüft; der Installer startet.
    pub fn start_install(&mut self) {
        self.phase = Phase::Installing;
        self.progress = None;
    }

    /// Die Aktualisierung ist gescheitert; der Hinweis nennt den Grund, und
    /// sie lässt sich erneut anstoßen.
    pub fn fail(&mut self, cause: FailureCause, error: String) {
        self.phase = Phase::Failed;
        self.progress = None;
        self.hidden = false;
        self.cause = Some(cause);
        self.error = Some(error);
    }
}

/// Warum eine Aktualisierung scheiterte, kurz genug für einen Satz.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureCause {
    /// GitHub war nicht erreichbar oder der Download brach ab.
    Network,
    /// Die Signatur des Installers passt nicht zum Kredr-Schlüssel.
    Signature,
    /// Der Installer ließ sich nicht starten.
    Installer,
    /// Alles andere, etwa ein Schreibfehler auf der Platte.
    Unknown,
}

/// Der Schritt der Aktualisierung, in dem ein Fehler auftrat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// „Jetzt suchen“; eingeordnet wie der Download, denn beide fragen GitHub.
    Check,
    Download,
    Install,
}

/// Ordnet einen Fehler des Updaters aus `step` einem Grund zu.
pub fn failure_cause(error: &tauri_plugin_updater::Error, step: Step) -> FailureCause {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => FailureCause::Signature,
        _ if step == Step::Install => FailureCause::Installer,
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => FailureCause::Network,
        _ => FailureCause::Unknown,
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

/// Was „Jetzt suchen“ ergab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum CheckResult {
    /// Es gibt eine neue Version; das Angebot steht in allen Fenstern.
    Found { version: String },
    /// Kredr ist aktuell.
    Current,
    /// Die Suche scheiterte, mit eingeordnetem Grund und Originaltext.
    Failed { cause: FailureCause, error: String },
}

/// Richtet die Aktualisierung ein. Nur die installierte Fassung sucht von
/// selbst, und nur, solange die Einstellung „Nach Aktualisierungen suchen“
/// an ist. Sie gilt bei jeder Suche neu.
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
            if app.state::<SettingsStore>().get().check_for_updates {
                tauri::async_runtime::block_on(check(&app));
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// Sucht von selbst einmal nach einer neuen Version. Ohne Netz oder bei einer
/// kaputten `latest.json` bleibt es still; die nächste Suche versucht es erneut.
async fn check(app: &AppHandle) {
    let Ok(Some(found)) = search(app).await else {
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

/// Fragt GitHub nach einer neuen Version.
async fn search(app: &AppHandle) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    let handle = app.clone();
    // Unter Windows beendet der Updater Kredr nach dem Start des Installers
    // mit `std::process::exit`; dabei schließt kein Fenster mehr regulär.
    // Vorher merkt sich Kredr die offenen Fenster für den Neustart und räumt
    // auf wie das Plugin ohne eigenen Hook.
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            crate::projects::remember_windows_for_restart(&handle);
            handle.cleanup_before_exit();
        })
        .build()?;
    updater.check().await
}

#[tauri::command]
pub fn app_update_state(updates: State<'_, AppUpdates>) -> AppUpdateState {
    updates.state()
}

/// „Jetzt suchen“ aus den Einstellungen: sucht sofort, auch wenn die Suche
/// von selbst abgeschaltet ist. Eine neue Version bietet sich in allen
/// Fenstern an, auch eine, die die Person auf „Später“ gestellt hat. Ein
/// Fehlschlag kommt als Ergebnis zurück, nie als Fehler; das `Result`
/// verlangt Tauri von asynchronen Befehlen mit `State`.
#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    updates: State<'_, AppUpdates>,
) -> Result<CheckResult, String> {
    Ok(match search(&app).await {
        Ok(Some(found)) => {
            let version = found.version.clone();
            updates.change(&app, |state, update| {
                let offered = state.found_on_request(found.version.clone());
                if offered {
                    *update = Some(found);
                }
                offered
            });
            CheckResult::Found { version }
        }
        Ok(None) => CheckResult::Current,
        Err(error) => CheckResult::Failed {
            cause: failure_cause(&error, Step::Check),
            error: error.to_string(),
        },
    })
}

/// „Später“ aus einem Fenster gilt für alle. Die Version merkt sich Kredr
/// über einen Neustart hinaus. Während des Downloads blendet es nur den
/// Hinweis aus.
#[tauri::command]
pub fn app_update_later(app: AppHandle, updates: State<'_, AppUpdates>) {
    updates.later(&app);
}

/// Lädt die neue Version, prüft ihre Signatur und startet den Installer im
/// Modus `passive`. Er beendet Kredr und startet es nach der Installation neu.
/// Den Fortschritt des Downloads meldet der Zustand in ganzen Prozent.
/// Scheitert ein Schritt, meldet der Zustand den eingeordneten Grund und den
/// Originaltext.
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
    let mut done = 0u64;
    let downloaded = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                updates.change(&app, |state, _| state.downloaded(done, total));
            },
            || {},
        )
        .await;
    let result = match downloaded {
        Ok(bytes) => {
            updates.change(&app, |state, _| {
                state.start_install();
                true
            });
            update
                .install(bytes)
                .map_err(|error| (failure_cause(&error, Step::Install), error))
        }
        Err(error) => Err((failure_cause(&error, Step::Download), error)),
    };
    if let Err((cause, error)) = result {
        crate::projects::forget_windows_for_restart(&app);
        updates.change(&app, |state, _| {
            state.fail(cause, error.to_string());
            true
        });
    }
    Ok(())
}
