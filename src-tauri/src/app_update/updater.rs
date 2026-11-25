//! Der Updater-seam: Suche, Download mit Fortschritt und Installation einer
//! neuen Version. Ihn erfüllen zwei adapters, und die Fassung wählt einen
//! beim Start: die installierte Fassung `tauri-plugin-updater`, die
//! Entwicklungsfassung den vorgespielten adapter. Fehler kommen schon
//! eingeordnet heraus. Den geladenen Installer hält der adapter; ob er
//! bereitliegt, weiß nur der Zustand der Aktualisierung.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::AppUpdates;

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

/// Ein Fehlschlag des Updaters: eingeordnet und mit dem Originaltext.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub cause: FailureCause,
    pub error: String,
}

/// Was eine Suche nach einer neuen Version ergab.
#[derive(Debug, PartialEq, Eq)]
pub enum SearchOutcome {
    /// Es gibt diese neue Version.
    Found(String),
    /// Kredr ist aktuell.
    Current,
    /// Die Suche scheiterte, mit eingeordnetem Grund und Originaltext.
    Failed { cause: FailureCause, error: String },
    /// Die Entwicklungsfassung sucht nie; GitHub wurde nicht gefragt.
    Locked,
}

/// Sucht von selbst mit `search` nach einer neuen Version, aber nur, solange
/// `enabled`, die Einstellung „Nach Aktualisierungen suchen“, an ist. Sonst
/// sucht sie nicht und ergibt `None`.
pub async fn auto_search_with<Search, Searching>(
    enabled: bool,
    search: Search,
) -> Option<SearchOutcome>
where
    Search: FnOnce() -> Searching,
    Searching: Future<Output = SearchOutcome>,
{
    if !enabled {
        return None;
    }
    Some(search().await)
}

/// Welche Fassung von Kredr läuft.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    /// `npm run tauri dev`: Sie fragt GitHub nie, damit sie sich nicht selbst
    /// mit der veröffentlichten Version überschreibt, und spielt eine
    /// Aktualisierung höchstens vor.
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

    /// Der adapter dieser Fassung; die Entwicklungsfassung liest dafür die
    /// Umgebungsvariablen des vorgespielten Ablaufs.
    pub fn updater(self) -> Updater {
        match self {
            Self::Development => Updater::Simulated(SimulatedUpdater::from_env()),
            Self::Installed => Updater::Plugin(PluginUpdater::default()),
        }
    }
}

/// Der seam mit seinen zwei adapters.
pub enum Updater {
    Plugin(PluginUpdater),
    Simulated(SimulatedUpdater),
}

impl Updater {
    /// Sucht nach einer neuen Version.
    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> SearchOutcome {
        match self {
            Self::Plugin(plugin) => plugin.check(app).await,
            Self::Simulated(simulated) => simulated.check(),
        }
    }

    /// Lädt `version` und prüft sie. `progress` erfährt, wie viele Bytes da
    /// sind, und von wie vielen, falls bekannt. Danach hält der adapter den
    /// Installer bis zur Installation.
    pub async fn download(
        &self,
        version: &str,
        progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(), Failure> {
        match self {
            Self::Plugin(plugin) => plugin.download(version, progress).await,
            Self::Simulated(simulated) => simulated.download(progress).await,
        }
    }

    /// Startet den geladenen Installer von `version`. Der echte beendet
    /// Kredr dabei und kehrt nur mit einem Fehlschlag zurück; der
    /// vorgespielte kehrt auch ohne zurück, und das Angebot steht wieder.
    pub async fn install<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        version: &str,
    ) -> Result<(), Failure> {
        match self {
            Self::Plugin(plugin) => plugin.install(app),
            Self::Simulated(simulated) => simulated.install(app, version).await,
        }
    }
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

impl Failure {
    /// Ein Fehler des Updaters aus `step`, eingeordnet.
    fn of_plugin(error: tauri_plugin_updater::Error, step: Step) -> Self {
        Self {
            cause: failure_cause(&error, step),
            error: error.to_string(),
        }
    }
}

/// Der adapter für `tauri-plugin-updater`: fragt GitHub, lädt den signierten
/// Installer und startet ihn.
#[derive(Default)]
pub struct PluginUpdater {
    held: Mutex<Held>,
}

/// Was der Plugin-adapter zwischen den Schritten hält.
#[derive(Default)]
struct Held {
    /// Je gefundener Version das `Update` der letzten Suche, die sie fand.
    /// Nach Version, damit eine spätere Suche nicht austauscht, was der
    /// Zustand gerade anbietet oder lädt.
    found: HashMap<String, Update>,
    /// Der zuletzt geladene und geprüfte Installer mit seinem `Update`.
    /// Geschachtelt, damit der adapter klein bleibt.
    installer: Option<Box<(Update, Vec<u8>)>>,
}

impl PluginUpdater {
    async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> SearchOutcome {
        match ask_github(app).await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                self.held
                    .lock()
                    .unwrap()
                    .found
                    .insert(version.clone(), update);
                SearchOutcome::Found(version)
            }
            Ok(None) => SearchOutcome::Current,
            Err(error) => {
                let Failure { cause, error } = Failure::of_plugin(error, Step::Check);
                SearchOutcome::Failed { cause, error }
            }
        }
    }

    async fn download(
        &self,
        version: &str,
        mut progress: impl FnMut(u64, Option<u64>),
    ) -> Result<(), Failure> {
        let update = self.held.lock().unwrap().found.get(version).cloned();
        let Some(update) = update else {
            return Err(Failure {
                cause: FailureCause::Unknown,
                error: format!("Version {version} wurde nicht gefunden"),
            });
        };
        let mut done = 0u64;
        let bytes = update
            .download(
                |chunk, total| {
                    done += chunk as u64;
                    progress(done, total);
                },
                || {},
            )
            .await
            .map_err(|error| Failure::of_plugin(error, Step::Download))?;
        self.held.lock().unwrap().installer = Some(Box::new((update, bytes)));
        Ok(())
    }

    /// Startet den Installer im Modus `passive`. Er beendet Kredr und startet
    /// es nach der Installation neu; unmittelbar davor merkt sich Kredr die
    /// offenen Fenster (`on_before_exit`). Scheitert der Start, gilt diese
    /// Notiz nicht mehr.
    fn install<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), Failure> {
        let installer = self.held.lock().unwrap().installer.take();
        let Some((update, bytes)) = installer.map(|installer| *installer) else {
            return Err(Failure {
                cause: FailureCause::Installer,
                error: "Kein Installer geladen".into(),
            });
        };
        update.install(bytes).map_err(|error| {
            crate::projects::forget_windows_for_restart(app);
            Failure::of_plugin(error, Step::Install)
        })
    }
}

/// Fragt GitHub nach einer neuen Version.
async fn ask_github<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    let handle = app.clone();
    // Unter Windows beendet der Updater Kredr nach dem Start des Installers
    // mit `std::process::exit`; dabei schließt kein Fenster mehr regulär.
    // Vorher merkt sich Kredr die offenen Fenster für den Neustart mit der
    // Version, die gerade installiert wird, und räumt auf wie das Plugin ohne
    // eigenen Hook.
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            if let Some(target) = handle.state::<AppUpdates>().state().version {
                crate::projects::remember_windows_for_restart(&handle, &target);
            }
            handle.cleanup_before_exit();
        })
        .build()?;
    updater.check().await
}

/// Nennt diese Variable der Entwicklungsfassung eine Version, etwa `0.6.0`,
/// bietet der vorgespielte adapter sie an.
const SIMULATED_UPDATE: &str = "KREDR_SIMULATED_UPDATE";
/// Nennt diese Variable einen Grund (`network`, `signature`, `installer`),
/// scheitert der vorgespielte Ablauf daran: die ersten beiden beim Download,
/// der letzte bei der Installation.
const SIMULATED_FAILURE: &str = "KREDR_SIMULATED_FAILURE";
/// So lange braucht der vorgespielte Download für zehn Prozent.
const SIMULATED_PACE: Duration = Duration::from_millis(400);
/// So viele Schritte des Downloads braucht die vorgespielte Installation.
const SIMULATED_INSTALL_STEPS: u32 = 4;

/// Der vorgespielte adapter der Entwicklungsfassung: Er bietet eine Version
/// an, die nur zum Abnehmen der Oberfläche existiert, lädt sie vorgespielt
/// und läuft bei der Installation bis kurz vor den Installer. Dann verwirft
/// er die Notiz für den Neustart und kehrt zurück, ohne Neustart. Ohne
/// Version findet er nie etwas.
pub struct SimulatedUpdater {
    version: Option<String>,
    failure: Option<FailureCause>,
    /// So lange braucht ein Zehntel des Downloads.
    pace: Duration,
    /// Läuft, wo der echte Installer starten würde: nach der Notiz für den
    /// Neustart, bevor der adapter sie verwirft.
    installer: Option<Box<dyn Fn() + Send + Sync>>,
}

impl SimulatedUpdater {
    /// Bietet `version` an und scheitert an `failure`; ein Zehntel des
    /// Downloads dauert `pace`.
    pub fn new(version: Option<String>, failure: Option<FailureCause>, pace: Duration) -> Self {
        Self {
            version,
            failure,
            pace,
            installer: None,
        }
    }

    /// Lässt `installer` laufen, wo der echte Installer starten würde; so
    /// sieht ein Test, was dann bereitliegt.
    pub fn on_installer(mut self, installer: impl Fn() + Send + Sync + 'static) -> Self {
        self.installer = Some(Box::new(installer));
        self
    }

    /// Liest Version und Grund aus den Umgebungsvariablen.
    pub fn from_env() -> Self {
        let read = |name| std::env::var(name).ok().filter(|v: &String| !v.is_empty());
        let failure = read(SIMULATED_FAILURE).and_then(|name| simulated_cause(&name));
        Self::new(read(SIMULATED_UPDATE), failure, SIMULATED_PACE)
    }

    fn check(&self) -> SearchOutcome {
        match &self.version {
            Some(version) => SearchOutcome::Found(version.clone()),
            None => SearchOutcome::Locked,
        }
    }

    /// Lädt in zehn Schritten zu je zehn Prozent. Ein Fehlschlag im Netz
    /// oder an der Signatur kommt nach der Hälfte.
    async fn download(&self, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), Failure> {
        for tenth in 1..=10u64 {
            tokio::time::sleep(self.pace).await;
            if tenth > 5 {
                if let Some(cause @ (FailureCause::Network | FailureCause::Signature)) =
                    self.failure
                {
                    return Err(simulated_failure(cause));
                }
            }
            progress(tenth * 10, Some(100));
        }
        Ok(())
    }

    /// Schreibt die Notiz für den Neustart wie vor dem echten Installer und
    /// verwirft sie wieder; die Aufteilungen haben die Fenster vorher
    /// gespeichert.
    async fn install<R: Runtime>(&self, app: &AppHandle<R>, version: &str) -> Result<(), Failure> {
        tokio::time::sleep(self.pace * SIMULATED_INSTALL_STEPS).await;
        crate::projects::remember_windows_for_restart(app, version);
        if let Some(installer) = &self.installer {
            installer();
        }
        crate::projects::forget_windows_for_restart(app);
        match self.failure {
            Some(FailureCause::Installer) => Err(simulated_failure(FailureCause::Installer)),
            _ => Ok(()),
        }
    }
}

/// Der Grund zum Namen aus `SIMULATED_FAILURE`.
fn simulated_cause(name: &str) -> Option<FailureCause> {
    match name {
        "network" => Some(FailureCause::Network),
        "signature" => Some(FailureCause::Signature),
        "installer" => Some(FailureCause::Installer),
        _ => None,
    }
}

/// Ein vorgespielter Fehlschlag mit dem Originaltext, den der Updater dabei meldet.
fn simulated_failure(cause: FailureCause) -> Failure {
    let error = match cause {
        FailureCause::Network => "error sending request for url (https://github.com/SirKashij/Kredr/releases/download/v0.6.0/Kredr_0.6.0_x64-setup.exe)",
        FailureCause::Signature => "The signature verification failed: Signature verification failed",
        FailureCause::Installer => "Das System kann die angegebene Datei nicht finden. (os error 2)",
        FailureCause::Unknown => "Failed to format date",
    };
    Failure {
        cause,
        error: error.into(),
    }
}
