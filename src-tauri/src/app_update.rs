//! Die Aktualisierung von Kredr: sucht kurz nach dem Start und danach alle
//! drei Stunden nach einer neuen Version, solange die Einstellung es erlaubt,
//! und auf Wunsch mit „Jetzt suchen“. Hält den Zustand für alle Fenster und
//! meldet jede Änderung mit dem Ereignis `app-update-changed`. Suche,
//! Download und Installation liegen hinter dem Updater-seam (`updater`); die
//! Entwicklungsfassung spielt sie dort höchstens vor.

mod updater;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::settings::{Settings, SettingsStore};

pub use updater::{
    auto_search_with, failure_cause, Edition, Failure, FailureCause, PluginUpdater, SearchOutcome,
    SimulatedUpdater, Step, Updater,
};

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
    /// Ein Fenster fragt vor der Aktualisierung nach den Anlässen aller
    /// Fenster. Solange lässt sich die Aktualisierung nirgends anstoßen.
    Confirm,
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
    /// Das Fenster, das während `Confirm` die Rückfrage zeigt.
    #[serde(skip)]
    asker: Option<String>,
    /// Die Phase vor der Rückfrage; „Später“ in der Rückfrage kehrt zu ihr zurück.
    #[serde(skip)]
    before_confirm: Phase,
    /// Ob der Installer geladen ist und auf die Installation wartet.
    #[serde(skip)]
    installer_ready: bool,
}

/// Der Kern der Vitest-Tests bildet diese Abläufe nach;
/// `src/appUpdateScenarios.json` hält die gemeinsamen Fälle, gegen die beide
/// geprüft werden.
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
            asker: None,
            before_confirm: Phase::None,
            installer_ready: false,
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
            Phase::Confirm | Phase::Downloading | Phase::Installing => false,
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

    /// „Jetzt aktualisieren“ in `window`: Die Rückfrage beginnt, wenn eine
    /// neue Version angeboten ist und noch keine Aktualisierung läuft. Bis sie
    /// endet, lässt sich die Aktualisierung in keinem Fenster erneut anstoßen.
    /// Nach „Später“ angestoßen, springt kein Hinweis auf, und nur das Symbol
    /// zeigt später den Fortschritt; nach einem Fehlschlag steht der Hinweis
    /// ohnehin. Gibt zurück, ob `window` fragen darf.
    pub fn ask(&mut self, window: &str) -> bool {
        let asks = matches!(self.phase, Phase::Offered | Phase::Later | Phase::Failed);
        if asks {
            self.before_confirm = self.phase;
            self.hidden = self.phase == Phase::Later;
            self.phase = Phase::Confirm;
            self.asker = Some(window.to_owned());
        }
        asks
    }

    /// „Später“ in der Rückfrage von `window`, oder `window` schließt sich
    /// oder lädt neu, solange es die Rückfrage hält: Der Zustand kehrt zur
    /// Phase davor zurück. Während des Downloads läuft dieser weiter, aber
    /// `window` bekommt die Rückfrage danach nicht zurück, denn es führt die
    /// Aktualisierung nicht mehr fort. Gibt zurück, ob sich der Zustand
    /// sichtbar geändert hat.
    pub fn cancel_confirm(&mut self, window: &str) -> bool {
        if self.phase == Phase::Downloading && self.asker.as_deref() == Some(window) {
            self.asker = None;
            return false;
        }
        let cancels = self.asks_in(window);
        if cancels {
            self.phase = self.before_confirm;
            self.hidden = false;
            self.asker = None;
            self.installer_ready = false;
        }
        cancels
    }

    /// Ob `window` gerade die Rückfrage zeigt.
    fn asks_in(&self, window: &str) -> bool {
        self.phase == Phase::Confirm && self.asker.as_deref() == Some(window)
    }

    /// „Trotzdem aktualisieren“ in `window`, oder es gab keinen Anlass für
    /// eine Rückfrage: Der Download beginnt, wenn `window` die Rückfrage hält
    /// und noch nichts geladen ist. `window` bekommt die Rückfrage nach dem
    /// Download zurück.
    pub fn start_download(&mut self, window: &str) -> bool {
        let starts = self.asks_in(window) && !self.installer_ready;
        if starts {
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

    /// Der Download ist fertig und geprüft. Das Fenster, das ihn angestoßen
    /// hat, hält wieder die Rückfrage: Es prüft die Anlässe erneut, denn
    /// während des Downloads können neue entstanden sein. Hat es sich
    /// inzwischen geschlossen oder neu geladen, kehrt der Zustand zur Phase
    /// vor der Rückfrage zurück. Gibt zurück, ob ein Download lief.
    pub fn finish_download(&mut self) -> bool {
        let finishes = self.phase == Phase::Downloading;
        if finishes {
            self.progress = None;
            if self.asker.is_some() {
                self.phase = Phase::Confirm;
                self.installer_ready = true;
            } else {
                self.phase = self.before_confirm;
                self.hidden = false;
            }
        }
        finishes
    }

    /// Ob der geladene Installer darauf wartet, dass das fragende Fenster installiert.
    pub fn installer_ready(&self) -> bool {
        self.installer_ready
    }

    /// `window` hält die Rückfrage nach dem Download und installiert: Der
    /// Installer startet. `window` bleibt das fragende Fenster, damit nur es
    /// einen Fehlschlag dabei meldet. Gibt zurück, ob `window` das darf.
    pub fn start_install(&mut self, window: &str) -> bool {
        let starts = self.asks_in(window) && self.installer_ready;
        if starts {
            self.phase = Phase::Installing;
            self.progress = None;
            self.installer_ready = false;
        }
        starts
    }

    /// Der Installer kehrte zurück, ohne Kredr zu beenden; das geschieht nur
    /// im vorgespielten Ablauf. Das Angebot steht wieder in allen Fenstern.
    /// Gibt zurück, ob eine Installation lief.
    pub fn installer_returned(&mut self) -> bool {
        let returns = self.phase == Phase::Installing;
        if returns {
            self.phase = Phase::Offered;
            self.asker = None;
            self.hidden = false;
        }
        returns
    }

    /// Die Aktualisierung ist gescheitert; der Hinweis nennt den Grund, und
    /// sie lässt sich erneut anstoßen.
    pub fn fail(&mut self, cause: FailureCause, error: String) {
        self.installer_ready = false;
        self.asker = None;
        self.phase = Phase::Failed;
        self.progress = None;
        self.hidden = false;
        self.cause = Some(cause);
        self.error = Some(error);
    }

    /// Ein Aufruf in `window` ist während der Aktualisierung gescheitert,
    /// etwa die Rundfrage nach den Anlässen: Der Fehlschlag gilt für alle
    /// Fenster. Das zählt nur, solange `window` die Rückfrage hält oder den
    /// Installer startet. Während des Downloads meldet der Kern einen
    /// Fehlschlag selbst, sonst liefe der Download weiter. Gibt zurück, ob
    /// der Fehlschlag gilt.
    pub fn window_failed(&mut self, window: &str, error: String) -> bool {
        let leads = matches!(self.phase, Phase::Confirm | Phase::Installing)
            && self.asker.as_deref() == Some(window);
        if leads {
            self.fail(FailureCause::Unknown, error);
        }
        leads
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

/// Der Zustand der Aktualisierung und der adapter, der sucht, lädt und installiert.
pub struct AppUpdates {
    inner: Mutex<AppUpdateState>,
    /// Wo die abgelehnte Version liegt; ohne Benutzerdatenverzeichnis nirgends.
    dir: Option<PathBuf>,
    auto: Mutex<AutoCheck>,
    updater: Updater,
}

/// Merkt sich, ob die Suche von selbst an ist, damit Kredr beim Anschalten
/// sofort sucht statt erst nach dem nächsten Abstand von drei Stunden.
pub struct AutoCheck {
    enabled: bool,
}

impl AutoCheck {
    /// `enabled` ist die Einstellung beim Start.
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }

    /// Die Einstellungen haben sich geändert; `enabled` ist die Suche von
    /// selbst. Gibt zurück, ob sie gerade angeschaltet wurde und Kredr
    /// deshalb sofort sucht.
    pub fn setting_changed(&mut self, enabled: bool) -> bool {
        let switched_on = enabled && !self.enabled;
        self.enabled = enabled;
        switched_on
    }
}

impl AppUpdates {
    pub(crate) fn new(
        installed: String,
        dir: Option<PathBuf>,
        auto_check: bool,
        updater: Updater,
    ) -> Self {
        let declined = dir.as_deref().and_then(load_declined);
        Self {
            inner: Mutex::new(AppUpdateState::new(installed, declined)),
            dir,
            auto: Mutex::new(AutoCheck::new(auto_check)),
            updater,
        }
    }

    /// Beendet die Rückfrage von `window`, wie mit „Später“.
    fn cancel<R: Runtime>(&self, app: &AppHandle<R>, window: &str) {
        self.change(app, |state| state.cancel_confirm(window));
    }

    /// Ein Aufruf in `window` ist gescheitert; der Fehlschlag gilt für alle
    /// Fenster, wenn `window` die Aktualisierung führt. Gibt zurück, ob der
    /// Fehlschlag gilt.
    fn fail<R: Runtime>(&self, app: &AppHandle<R>, window: &str, error: String) -> bool {
        let mut failed = false;
        self.change(app, |state| {
            failed = state.window_failed(window, error);
            failed
        });
        failed
    }

    pub(crate) fn state(&self) -> AppUpdateState {
        self.inner.lock().unwrap().clone()
    }

    /// „Später“: schließt das Angebot in allen Fenstern und merkt sich die
    /// Version im Benutzerdatenverzeichnis.
    fn later<R: Runtime>(&self, app: &AppHandle<R>) {
        let mut declined = None;
        self.change(app, |state| {
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
    pub(crate) fn change<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        change: impl FnOnce(&mut AppUpdateState) -> bool,
    ) {
        let mut state = self.inner.lock().unwrap();
        if change(&mut state) {
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
    /// Die Entwicklungsfassung sucht nicht.
    Development,
    /// Die Suche scheiterte, mit eingeordnetem Grund und Originaltext.
    Failed { cause: FailureCause, error: String },
}

/// Richtet die Aktualisierung ein; die Fassung wählt dafür den adapter. Die
/// installierte Fassung sucht kurz nach dem Start und danach alle drei
/// Stunden, solange die Einstellung „Nach Aktualisierungen suchen“ an ist;
/// sie gilt bei jeder Suche neu. Die Entwicklungsfassung bietet eine
/// vorgespielte Version sofort an.
pub fn start(app: &AppHandle) {
    let edition = Edition::current();
    app.manage(AppUpdates::new(
        app.package_info().version.to_string(),
        crate::data_dir(app).ok(),
        app.state::<SettingsStore>().get().check_for_updates,
        edition.updater(),
    ));
    if edition == Edition::Development {
        tauri::async_runtime::block_on(offer_found(app, false));
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        loop {
            tauri::async_runtime::block_on(offer_found(&app, true));
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

/// Meldet der Aktualisierung neue Einstellungen. Schaltet die Person die
/// Suche von selbst an, sucht Kredr sofort einmal; der Abstand von drei
/// Stunden läuft unverändert weiter.
pub fn settings_changed(app: &AppHandle, settings: &Settings) {
    let Some(updates) = app.try_state::<AppUpdates>() else {
        return;
    };
    let switched_on = updates
        .auto
        .lock()
        .unwrap()
        .setting_changed(settings.check_for_updates);
    if switched_on {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { offer_found(&app, true).await });
    }
}

/// Sucht von selbst einmal nach einer neuen Version und bietet sie an. Mit
/// `by_setting` nur, wenn die Einstellung es erlaubt. Ohne Netz oder bei einer
/// kaputten `latest.json` bleibt es still; die nächste Suche versucht es erneut.
async fn offer_found(app: &AppHandle, by_setting: bool) {
    let enabled = !by_setting || app.state::<SettingsStore>().get().check_for_updates;
    let updates = app.state::<AppUpdates>();
    let Some(SearchOutcome::Found(version)) =
        auto_search_with(enabled, || updates.updater.check(app)).await
    else {
        return;
    };
    updates.change(app, |state| state.found(version));
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
pub async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, AppUpdates>,
) -> Result<CheckResult, String> {
    Ok(match updates.updater.check(&app).await {
        SearchOutcome::Found(version) => {
            updates.change(&app, |state| state.found_on_request(version.clone()));
            CheckResult::Found { version }
        }
        SearchOutcome::Current => CheckResult::Current,
        SearchOutcome::Failed { cause, error } => CheckResult::Failed { cause, error },
        SearchOutcome::Locked => CheckResult::Development,
    })
}

/// „Später“ aus einem Fenster gilt für alle. Die Version merkt sich Kredr
/// über einen Neustart hinaus. Während des Downloads blendet es nur den
/// Hinweis aus.
#[tauri::command]
pub fn app_update_later<R: Runtime>(app: AppHandle<R>, updates: State<'_, AppUpdates>) {
    updates.later(&app);
}

/// „Jetzt aktualisieren“ in einem Fenster: Es bekommt die Rückfrage, alle
/// Fenster zeigen sie als laufend. Gibt zurück, ob das Fenster fragen darf;
/// hält schon ein anderes die Rückfrage oder läuft die Aktualisierung, nicht.
#[tauri::command]
pub fn app_update_ask<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    updates: State<'_, AppUpdates>,
) -> bool {
    let mut asks = false;
    updates.change(&app, |state| {
        asks = state.ask(window.label());
        asks
    });
    asks
}

/// „Später“ in der Rückfrage: Der Zustand kehrt in allen Fenstern zur Phase
/// davor zurück.
#[tauri::command]
pub fn app_update_cancel<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    updates: State<'_, AppUpdates>,
) {
    updates.cancel(&app, window.label());
}

/// Ein Aufruf in einem Fenster ist während der Aktualisierung gescheitert,
/// etwa die Rundfrage oder der Dialog der Rückfrage: Alle Fenster zeigen den
/// Fehlschlag mit `error` als Originaltext. Gibt zurück, ob der Fehlschlag
/// gilt; nicht, wenn das Fenster die Aktualisierung gar nicht führt.
#[tauri::command]
pub fn app_update_fail<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    updates: State<'_, AppUpdates>,
    error: String,
) -> bool {
    updates.fail(&app, window.label(), error)
}

/// Ein Fenster hat sich geschlossen. Hielt es die Rückfrage, endet sie wie
/// mit „Später“, damit kein Fenster in ihr hängen bleibt.
pub fn window_closed<R: Runtime>(window: &tauri::Window<R>) {
    if let Some(updates) = window.try_state::<AppUpdates>() {
        updates.cancel(window.app_handle(), window.label());
    }
}

/// Lädt die angebotene Version und prüft ihre Signatur. Den Fortschritt
/// meldet der Zustand in ganzen Prozent. Danach hält `window` wieder die
/// Rückfrage: Es prüft die Anlässe erneut, speichert die Aufteilungen und
/// installiert mit `app_update_install`, oder es bricht ab. Gibt zurück, ob
/// die Version bereitliegt. Scheitert der Download, meldet der Zustand den
/// eingeordneten Grund und den Originaltext. Nur das Fenster, das die
/// Rückfrage hält, kann laden.
#[tauri::command]
pub async fn app_update_download<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    updates: State<'_, AppUpdates>,
) -> Result<bool, String> {
    let mut pending = None;
    updates.change(&app, |state| {
        let starts = state.start_download(window.label());
        if starts {
            pending = state.version.clone();
        }
        starts
    });
    let Some(version) = pending else {
        return Ok(false);
    };
    let downloaded = updates
        .updater
        .download(&version, |done, total| {
            updates.change(&app, |state| state.downloaded(done, total));
        })
        .await;
    let mut ready = false;
    updates.change(&app, |state| match downloaded {
        Ok(()) => {
            let finishes = state.finish_download();
            ready = state.installer_ready();
            finishes
        }
        Err(Failure { cause, error }) => {
            state.fail(cause, error);
            true
        }
    });
    Ok(ready)
}

/// Startet den geladenen Installer. Nur das Fenster, das nach dem Download
/// die Rückfrage hält, kann installieren. Scheitert der Start, meldet der
/// Zustand den eingeordneten Grund und den Originaltext. Kehrt der Installer
/// ohne Fehlschlag zurück, wie im vorgespielten Ablauf, steht wieder das
/// Angebot.
#[tauri::command]
pub async fn app_update_install<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    updates: State<'_, AppUpdates>,
) -> Result<(), String> {
    let mut pending = None;
    updates.change(&app, |state| {
        let starts = state.start_install(window.label());
        if starts {
            pending = state.version.clone();
        }
        starts
    });
    let Some(version) = pending else {
        return Ok(());
    };
    let installed = updates.updater.install(&app, &version).await;
    updates.change(&app, |state| match installed {
        Ok(()) => state.installer_returned(),
        Err(Failure { cause, error }) => {
            state.fail(cause, error);
            true
        }
    });
    Ok(())
}
