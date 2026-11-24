//! Die Aktualisierung von Kredr: sucht kurz nach dem Start und danach alle
//! drei Stunden nach einer neuen Version, solange die Einstellung es erlaubt,
//! und auf Wunsch mit „Jetzt suchen“. Hält den Zustand für alle Fenster und
//! meldet jede Änderung mit dem Ereignis `app-update-changed`. Die
//! Entwicklungsfassung sucht und installiert nie.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::{Settings, SettingsStore};

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
    /// Installer startet. Gibt zurück, ob `window` das darf.
    pub fn start_install(&mut self, window: &str) -> bool {
        let starts = self.asks_in(window) && self.installer_ready;
        if starts {
            self.phase = Phase::Installing;
            self.progress = None;
            self.asker = None;
            self.installer_ready = false;
        }
        starts
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

/// Welche Fassung von Kredr läuft.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    /// `npm run tauri dev`: Sie fragt GitHub nie, damit sie sich nicht selbst
    /// mit der veröffentlichten Version überschreibt.
    Development,
    /// Die installierte Fassung.
    Installed,
}

impl Edition {
    /// Die laufende Fassung.
    pub fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Development
        } else {
            Self::Installed
        }
    }

    /// Ob diese Fassung nach Aktualisierungen suchen und sie installieren darf.
    pub fn may_update(self) -> bool {
        self == Self::Installed
    }
}

/// Der Zustand der Aktualisierung und die zuletzt gefundene neue Version.
pub struct AppUpdates {
    inner: Mutex<(AppUpdateState, Option<Update>)>,
    /// Wo die abgelehnte Version liegt; ohne Benutzerdatenverzeichnis nirgends.
    dir: Option<PathBuf>,
    auto: Mutex<AutoCheck>,
    /// Der geladene und geprüfte Installer, bis er installiert wird oder die
    /// Rückfrage nach dem Download endet.
    installer: Mutex<Option<Vec<u8>>>,
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
    fn new(installed: String, dir: Option<PathBuf>, auto_check: bool) -> Self {
        let declined = dir.as_deref().and_then(load_declined);
        Self {
            inner: Mutex::new((AppUpdateState::new(installed, declined), None)),
            dir,
            auto: Mutex::new(AutoCheck::new(auto_check)),
            installer: Mutex::new(None),
        }
    }

    /// Beendet die Rückfrage von `window`, wie mit „Später“; ein geladener
    /// Installer wird verworfen.
    fn cancel(&self, app: &AppHandle, window: &str) {
        let mut cancelled = false;
        self.change(app, |state, _| {
            cancelled = state.cancel_confirm(window);
            cancelled
        });
        if cancelled {
            self.installer.lock().unwrap().take();
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
    /// Die Entwicklungsfassung sucht nicht.
    Development,
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
        app.state::<SettingsStore>().get().check_for_updates,
    ));
    // Die Suche sperrt die Entwicklungsfassung ohnehin; sie braucht deshalb
    // auch den Thread nicht, der alle drei Stunden aufwacht.
    if !Edition::current().may_update() {
        offer_simulated(app);
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

/// Nennt diese Variable der Entwicklungsfassung eine Version, etwa `0.6.0`,
/// bietet der Kern sie allen Fenstern an. Ohne `Update` des Updaters lädt und
/// installiert er nichts: „Trotzdem aktualisieren“ führt zum Angebot zurück.
/// So lässt sich die Rückfrage über mehrere Fenster abnehmen.
const SIMULATED_UPDATE: &str = "KREDR_SIMULATED_UPDATE";

/// Bietet in der Entwicklungsfassung die Version aus `SIMULATED_UPDATE` an.
fn offer_simulated(app: &AppHandle) {
    if let Some(version) = std::env::var(SIMULATED_UPDATE)
        .ok()
        .filter(|v| !v.is_empty())
    {
        app.state::<AppUpdates>()
            .change(app, |state, _| state.found(version));
    }
}

/// Meldet der Aktualisierung neue Einstellungen. Schaltet die Person die
/// Suche von selbst an, sucht die installierte Fassung sofort einmal; der
/// Abstand von drei Stunden läuft unverändert weiter.
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
        tauri::async_runtime::spawn(async move { check(&app).await });
    }
}

/// Sucht von selbst einmal nach einer neuen Version. Ohne Netz oder bei einer
/// kaputten `latest.json` bleibt es still; die nächste Suche versucht es erneut.
async fn check(app: &AppHandle) {
    let SearchOutcome::Found(found) = search(app).await else {
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

/// Was eine Suche nach einer neuen Version ergab. `T` ist die gefundene
/// Version, im Kern das `Update` des Updaters.
#[derive(Debug, PartialEq, Eq)]
pub enum SearchOutcome<T> {
    Found(T),
    /// Kredr ist aktuell.
    Current,
    /// Die Suche scheiterte, mit eingeordnetem Grund und Originaltext.
    Failed {
        cause: FailureCause,
        error: String,
    },
    /// Diese Fassung darf nicht suchen; der Updater wurde nicht gefragt.
    Locked,
}

/// Fragt mit `ask` nach einer neuen Version, wenn `edition` es darf. Jede
/// Suche geht hier durch, und ein `Update` zum Installieren gibt es nur aus
/// einer Suche. So erreicht die Entwicklungsfassung den Updater auf keinem
/// Weg.
pub async fn search_with<T, Ask, Asking>(edition: Edition, ask: Ask) -> SearchOutcome<T>
where
    Ask: FnOnce() -> Asking,
    Asking: Future<Output = Result<Option<T>, tauri_plugin_updater::Error>>,
{
    if !edition.may_update() {
        return SearchOutcome::Locked;
    }
    match ask().await {
        Ok(Some(found)) => SearchOutcome::Found(found),
        Ok(None) => SearchOutcome::Current,
        Err(error) => SearchOutcome::Failed {
            cause: failure_cause(&error, Step::Check),
            error: error.to_string(),
        },
    }
}

/// Sucht in der laufenden Fassung nach einer neuen Version.
async fn search(app: &AppHandle) -> SearchOutcome<Update> {
    search_with(Edition::current(), || ask_github(app)).await
}

/// Fragt GitHub nach einer neuen Version. Nur `search_with` ruft das auf.
async fn ask_github(app: &AppHandle) -> Result<Option<Update>, tauri_plugin_updater::Error> {
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
        SearchOutcome::Found(found) => {
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
        SearchOutcome::Current => CheckResult::Current,
        SearchOutcome::Failed { cause, error } => CheckResult::Failed { cause, error },
        SearchOutcome::Locked => CheckResult::Development,
    })
}

/// „Später“ aus einem Fenster gilt für alle. Die Version merkt sich Kredr
/// über einen Neustart hinaus. Während des Downloads blendet es nur den
/// Hinweis aus.
#[tauri::command]
pub fn app_update_later(app: AppHandle, updates: State<'_, AppUpdates>) {
    updates.later(&app);
}

/// „Jetzt aktualisieren“ in einem Fenster: Es bekommt die Rückfrage, alle
/// Fenster zeigen sie als laufend. Gibt zurück, ob das Fenster fragen darf;
/// hält schon ein anderes die Rückfrage oder läuft die Aktualisierung, nicht.
#[tauri::command]
pub fn app_update_ask(
    app: AppHandle,
    window: tauri::Window,
    updates: State<'_, AppUpdates>,
) -> bool {
    let mut asks = false;
    updates.change(&app, |state, _| {
        asks = state.ask(window.label());
        asks
    });
    asks
}

/// „Später“ in der Rückfrage: Der Zustand kehrt in allen Fenstern zur Phase
/// davor zurück.
#[tauri::command]
pub fn app_update_cancel(app: AppHandle, window: tauri::Window, updates: State<'_, AppUpdates>) {
    updates.cancel(&app, window.label());
}

/// Ein Fenster hat sich geschlossen. Hielt es die Rückfrage, endet sie wie
/// mit „Später“, damit kein Fenster in ihr hängen bleibt.
pub fn window_closed(window: &tauri::Window) {
    if let Some(updates) = window.try_state::<AppUpdates>() {
        updates.cancel(window.app_handle(), window.label());
    }
}

/// Lädt die neue Version und prüft ihre Signatur. Den Fortschritt meldet der
/// Zustand in ganzen Prozent. Danach hält `window` wieder die Rückfrage: Es
/// prüft die Anlässe erneut, speichert die Aufteilungen und installiert mit
/// `app_update_install`, oder es bricht ab. Gibt zurück, ob die Version
/// bereitliegt. Scheitert der Download, meldet der Zustand den eingeordneten
/// Grund und den Originaltext. Nur das Fenster, das die Rückfrage hält, kann
/// laden. Ohne `Update` endet nur die Rückfrage; ein `Update` kommt nur aus
/// einer Suche, die Entwicklungsfassung hat deshalb nie eins.
#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    window: tauri::Window,
    updates: State<'_, AppUpdates>,
) -> Result<bool, String> {
    let label = window.label().to_owned();
    let mut pending = None;
    updates.change(&app, |state, update| {
        let Some(update) = update.clone() else {
            // Ohne `Update` gibt es nichts zu laden; die Rückfrage darf nicht hängen bleiben.
            return state.cancel_confirm(&label);
        };
        let starts = state.start_download(&label);
        if starts {
            pending = Some(update);
        }
        starts
    });
    let Some(update) = pending else {
        return Ok(false);
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
    match downloaded {
        Ok(bytes) => {
            let mut ready = false;
            updates.change(&app, |state, _| {
                let finishes = state.finish_download();
                ready = state.installer_ready();
                // Im selben Schritt wie die Rückfrage, damit das Fenster nie
                // ohne Installer installieren will.
                if ready {
                    *updates.installer.lock().unwrap() = Some(bytes);
                }
                finishes
            });
            Ok(ready)
        }
        Err(error) => {
            updates.change(&app, |state, _| {
                state.fail(failure_cause(&error, Step::Download), error.to_string());
                true
            });
            Ok(false)
        }
    }
}

/// Startet den geladenen Installer im Modus `passive`. Er beendet Kredr und
/// startet es nach der Installation neu; unmittelbar davor merkt sich Kredr
/// die offenen Fenster (`on_before_exit`). Nur das Fenster, das nach dem
/// Download die Rückfrage hält, kann installieren. Scheitert der Start,
/// meldet der Zustand den eingeordneten Grund und den Originaltext.
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    window: tauri::Window,
    updates: State<'_, AppUpdates>,
) -> Result<(), String> {
    let mut pending = None;
    updates.change(&app, |state, update| {
        let mut installer = updates.installer.lock().unwrap();
        let starts = update.is_some() && installer.is_some() && state.start_install(window.label());
        if starts {
            pending = update.clone().zip(installer.take());
        }
        starts
    });
    let Some((update, bytes)) = pending else {
        return Ok(());
    };
    if let Err(error) = update.install(bytes) {
        crate::projects::forget_windows_for_restart(&app);
        updates.change(&app, |state, _| {
            state.fail(failure_cause(&error, Step::Install), error.to_string());
            true
        });
    }
    Ok(())
}
