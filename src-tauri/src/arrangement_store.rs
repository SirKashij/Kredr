//! Aufteilungsspeicher: merkt sich im Benutzerdatenverzeichnis von Kredr,
//! was über das Schließen eines Fensters hinaus erhalten bleibt. Bisher ist
//! das die Liste zuletzt geöffneter Projekte; Aufteilung und
//! Fenstergeometrie pro Projekt kommen als weitere Felder desselben
//! Projekteintrags dazu.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Die Version des Dateiformats. Eine Datei anderer Version gilt als nicht lesbar.
const VERSION: u32 = 1;
const FILE_NAME: &str = "projects.json";
/// So viele Projekte behält die Liste; ältere fallen heraus.
const MAX_PROJECTS: usize = 20;

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
        let path = normalize(folder);
        let mut projects = self.load();
        projects.retain(|project| !same_project(&project.path, &path));
        projects.insert(0, StoredProject { path });
        projects.truncate(MAX_PROJECTS);
        self.save(projects)
    }

    /// Entfernt das Projekt aus der Liste. Der Ordner selbst bleibt unberührt.
    pub fn forget_project(&self, folder: &Path) -> io::Result<()> {
        let _guard = self.lock.lock();
        let mut projects = self.load();
        let before = projects.len();
        projects.retain(|project| !same_project(&project.path, folder));
        if projects.len() == before {
            return Ok(());
        }
        self.save(projects)
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

    /// Schreibt erst daneben und benennt dann um: ein Absturz mitten im
    /// Schreiben hinterlässt die alte Datei, keine halbe.
    fn save(&self, projects: Vec<StoredProject>) -> io::Result<()> {
        let stored = StoredFile {
            version: VERSION,
            projects,
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
        std::fs::create_dir_all(&self.dir)?;
        let temporary = self.dir.join(format!("{FILE_NAME}.tmp"));
        std::fs::write(&temporary, json)?;
        std::fs::rename(temporary, self.file())
    }
}

/// Ob beide Pfade denselben Ordner als Projekt meinen. Windows unterscheidet
/// weder Groß- und Kleinschreibung noch einen abschließenden Trenner.
pub fn same_project(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

fn key(folder: &Path) -> String {
    normalize(folder).to_string_lossy().to_lowercase()
}

/// Der vollständige Pfad des Ordners ohne `.`, `..` und abschließenden Trenner.
fn normalize(folder: &Path) -> PathBuf {
    let absolute = std::path::absolute(folder).unwrap_or_else(|_| folder.to_path_buf());
    absolute.components().collect()
}
