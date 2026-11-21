//! Aufteilungsspeicher: merkt sich im Benutzerdatenverzeichnis von Kredr,
//! was über das Schließen eines Fensters hinaus erhalten bleibt: die Liste
//! zuletzt geöffneter Projekte (`projects.json`) und pro Projekt seine
//! Aufteilung samt Fenstergeometrie (je eine Datei unter `arrangements/`).
//! Jedes Projekt hat seine eigene Datei, damit das laufende Speichern eines
//! Fensters weder die Projektliste noch die Aufteilung eines anderen
//! Projekts neu schreibt und eine beschädigte Datei nur ein Projekt trifft.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::paths;
use crate::window_geometry::WindowGeometry;

/// Die Version des Dateiformats. Eine Datei anderer Version gilt als nicht lesbar.
const VERSION: u32 = 1;
const FILE_NAME: &str = "projects.json";
/// So viele Projekte behält die Liste; ältere fallen heraus.
const MAX_PROJECTS: usize = 20;
/// Der Ordner mit je einer Datei pro Projekt.
const ARRANGEMENTS_DIR: &str = "arrangements";

/// Was Kredr sich zu einem Projekt über das Schließen seines Fensters hinaus merkt.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProjectState {
    /// Die Aufteilung im Format der Oberfläche (`src/arrangement.ts`), das
    /// seine eigene Versionsnummer trägt; der Kern deutet sie nicht.
    pub arrangement: Option<serde_json::Value>,
    /// Größe und Position des Fensters.
    pub window: Option<WindowGeometry>,
}

#[derive(Serialize, Deserialize)]
struct StoredState {
    version: u32,
    /// Der Projektordner, zu dem die Datei gehört.
    project: PathBuf,
    arrangement: Option<serde_json::Value>,
    window: Option<WindowGeometry>,
}

/// Ein Eintrag der Liste zuletzt geöffneter Projekte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentProject {
    /// Der Ordner des Projekts.
    pub path: PathBuf,
    /// Ob der Ordner noch vorhanden ist.
    pub exists: bool,
}

#[derive(Serialize, Deserialize)]
struct StoredFile {
    version: u32,
    /// Zuletzt geöffnetes Projekt zuerst.
    projects: Vec<StoredProject>,
}

#[derive(Serialize, Deserialize)]
struct StoredProject {
    path: PathBuf,
}

pub struct ArrangementStore {
    dir: PathBuf,
    /// Lesen, Ändern und Schreiben der Datei gehören zusammen.
    lock: Mutex<()>,
}

impl ArrangementStore {
    /// Ein Speicher, der seine Dateien in `dir` ablegt. Der Ordner entsteht
    /// beim ersten Schreiben.
    pub fn new(dir: impl Into<PathBuf>) -> ArrangementStore {
        ArrangementStore {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    /// Die zuletzt geöffneten Projekte, das jüngste zuerst. Eine fehlende
    /// oder nicht lesbare Datei ergibt eine leere Liste.
    pub fn recent_projects(&self) -> Vec<RecentProject> {
        let _guard = self.lock.lock();
        self.load()
            .into_iter()
            .map(|project| RecentProject {
                exists: project.path.is_dir(),
                path: project.path,
            })
            .collect()
    }

    /// Setzt das Projekt an den Anfang der Liste.
    pub fn remember_project(&self, folder: &Path) -> io::Result<()> {
        let _guard = self.lock.lock();
        let path = paths::normalized(folder);
        let mut projects = self.load();
        projects.retain(|project| !paths::same(&project.path, &path));
        projects.insert(0, StoredProject { path });
        projects.truncate(MAX_PROJECTS);
        self.save(projects)
    }

    /// Entfernt das Projekt aus der Liste. Der Ordner selbst bleibt unberührt.
    pub fn forget_project(&self, folder: &Path) -> io::Result<()> {
        let _guard = self.lock.lock();
        let mut projects = self.load();
        let before = projects.len();
        projects.retain(|project| !paths::same(&project.path, folder));
        // Mit dem Eintrag geht auch die Aufteilung des Projekts.
        let _ = std::fs::remove_file(self.state_file(folder));
        if projects.len() == before {
            return Ok(());
        }
        self.save(projects)
    }

    /// Aufteilung und Fenstergeometrie des Projekts. Eine fehlende, nicht
    /// lesbare oder in einer anderen Version geschriebene Datei ergibt
    /// nichts von beidem.
    pub fn project_state(&self, folder: &Path) -> ProjectState {
        let _guard = self.lock.lock();
        let Ok(bytes) = std::fs::read(self.state_file(folder)) else {
            return ProjectState::default();
        };
        match serde_json::from_slice::<StoredState>(&bytes) {
            Ok(stored) if stored.version == VERSION && paths::same(&stored.project, folder) => {
                ProjectState {
                    arrangement: stored.arrangement,
                    window: stored.window,
                }
            }
            _ => ProjectState::default(),
        }
    }

    /// Merkt sich Aufteilung und Fenstergeometrie des Projekts.
    pub fn save_project_state(&self, folder: &Path, state: &ProjectState) -> io::Result<()> {
        let _guard = self.lock.lock();
        let stored = StoredState {
            version: VERSION,
            project: paths::normalized(folder),
            arrangement: state.arrangement.clone(),
            window: state.window,
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
        paths::write_whole(&self.state_file(folder), json)
    }

    /// Die Datei des Projekts. Ihr Name folgt aus dem Projektpfad, gleich in
    /// welcher Schreibweise.
    fn state_file(&self, folder: &Path) -> PathBuf {
        // FNV-1a: über Versionen von Rust und Kredr hinweg derselbe Name.
        let hash = paths::key(folder)
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
            });
        self.dir
            .join(ARRANGEMENTS_DIR)
            .join(format!("{hash:016x}.json"))
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn load(&self) -> Vec<StoredProject> {
        let Ok(bytes) = std::fs::read(self.file()) else {
            return Vec::new();
        };
        match serde_json::from_slice::<StoredFile>(&bytes) {
            Ok(stored) if stored.version == VERSION => stored.projects,
            _ => Vec::new(),
        }
    }

    fn save(&self, projects: Vec<StoredProject>) -> io::Result<()> {
        let stored = StoredFile {
            version: VERSION,
            projects,
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
        paths::write_whole(&self.file(), json)
    }
}
