//! Aufteilungsspeicher: merkt sich im Benutzerdatenverzeichnis von Kredr,
//! was über das Schließen eines Fensters hinaus erhalten bleibt: die Liste
//! zuletzt geöffneter Projekte und Workspaces (`projects.json`) und pro
//! Projekt seine Aufteilung samt Fenstergeometrie (je eine Datei unter
//! `arrangements/`),
//! pro Workspace Name, Projekte, Aufteilung und Fenstergeometrie (je eine
//! Datei unter `workspaces/`) und die beim Beenden offenen Workspaces.
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
/// So viele Projekte und Workspaces behält die Liste; ältere fallen heraus.
const MAX_ENTRIES: usize = 20;
/// Der Ordner mit je einer Datei pro Projekt.
const ARRANGEMENTS_DIR: &str = "arrangements";
/// Der Ordner mit je einer Datei pro Workspace.
const WORKSPACES_DIR: &str = "workspaces";
/// Die Workspaces, die offen waren, als das letzte Fenster schloss.
const OPEN_WORKSPACES_FILE: &str = "open-workspaces.json";

/// Was Kredr sich zu einem Workspace merkt: Name, Projekte in Reihenfolge,
/// Aufteilung und Fenstergeometrie. Die Kennung steht nicht darin; unter ihr
/// ist der Zustand gespeichert.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceState {
    pub name: String,
    pub projects: Vec<PathBuf>,
    /// Die Aufteilung im Format der Oberfläche, wie bei einem Projekt.
    pub arrangement: Option<serde_json::Value>,
    pub window: Option<WindowGeometry>,
}

#[derive(Serialize, Deserialize)]
struct StoredWorkspace {
    version: u32,
    /// Die Kennung des Workspace, zu dem die Datei gehört.
    id: String,
    name: String,
    projects: Vec<PathBuf>,
    arrangement: Option<serde_json::Value>,
    window: Option<WindowGeometry>,
}

#[derive(Serialize, Deserialize)]
struct StoredOpenWorkspaces {
    version: u32,
    workspaces: Vec<String>,
}

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

/// Ein Eintrag der Zuletzt-Liste: ein Projekt oder ein Workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecentEntry {
    Project(RecentProject),
    Workspace {
        id: String,
        name: String,
        /// Die Projekte des Workspace in Reihenfolge, jeweils mit „vorhanden“.
        projects: Vec<RecentProject>,
    },
}

#[derive(Serialize, Deserialize)]
struct StoredFile {
    version: u32,
    /// Zuletzt genutzter Eintrag zuerst. Der Name bleibt aus der Zeit, als
    /// die Liste nur Projekte kannte, damit bestehende Daten lesbar bleiben.
    projects: Vec<StoredEntry>,
}

/// Ein Projekt steht mit seinem Pfad in der Liste, ein Workspace mit seiner
/// Kennung; Name und Projekte stehen in der Datei des Workspace.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum StoredEntry {
    Workspace { workspace: String },
    Project { path: PathBuf },
}

impl StoredEntry {
    fn is_project(&self, folder: &Path) -> bool {
        matches!(self, StoredEntry::Project { path } if paths::same(path, folder))
    }

    fn is_workspace(&self, id: &str) -> bool {
        matches!(self, StoredEntry::Workspace { workspace } if workspace == id)
    }
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
        self.recent()
            .into_iter()
            .filter_map(|entry| match entry {
                RecentEntry::Project(project) => Some(project),
                RecentEntry::Workspace { .. } => None,
            })
            .collect()
    }

    /// Die zuletzt genutzten Projekte und Workspaces gemischt, das jüngste
    /// zuerst. Ein Workspace ohne lesbare Datei fehlt.
    pub fn recent(&self) -> Vec<RecentEntry> {
        let _guard = self.lock.lock();
        self.load()
            .into_iter()
            .filter_map(|entry| match entry {
                StoredEntry::Project { path } => Some(RecentEntry::Project(recent_project(path))),
                StoredEntry::Workspace { workspace } => {
                    let state = self.read_workspace(&workspace)?;
                    Some(RecentEntry::Workspace {
                        id: workspace,
                        name: state.name,
                        projects: state.projects.into_iter().map(recent_project).collect(),
                    })
                }
            })
            .collect()
    }

    /// Setzt das Projekt an den Anfang der Liste.
    pub fn remember_project(&self, folder: &Path) -> io::Result<()> {
        let path = paths::normalized(folder);
        self.remember(
            |entry| entry.is_project(&path),
            StoredEntry::Project { path: path.clone() },
        )
    }

    /// Setzt den Workspace an den Anfang der Liste.
    pub fn remember_workspace(&self, id: &str) -> io::Result<()> {
        self.remember(
            |entry| entry.is_workspace(id),
            StoredEntry::Workspace {
                workspace: id.to_string(),
            },
        )
    }

    /// Entfernt das Projekt aus der Liste. Der Ordner selbst bleibt unberührt.
    pub fn forget_project(&self, folder: &Path) -> io::Result<()> {
        // Mit dem Eintrag geht auch die Aufteilung des Projekts.
        self.forget(|entry| entry.is_project(folder), &self.state_file(folder))
    }

    /// Entfernt den Workspace aus der Liste und mit ihm Name, Projekte und
    /// Aufteilung. Die Projekte selbst bleiben unberührt.
    pub fn forget_workspace(&self, id: &str) -> io::Result<()> {
        self.forget(|entry| entry.is_workspace(id), &self.workspace_file(id))
    }

    /// Setzt den Eintrag an den Anfang der Liste; `same` erkennt seinen
    /// bisherigen Platz.
    fn remember(&self, same: impl Fn(&StoredEntry) -> bool, entry: StoredEntry) -> io::Result<()> {
        let _guard = self.lock.lock();
        let mut entries = self.load();
        // Ein Workspace ohne lesbare Datei erscheint nirgends und ließe sich
        // nicht mehr entfernen; er geht mit dieser Gelegenheit.
        entries.retain(|other| {
            let unreadable = matches!(other, StoredEntry::Workspace { workspace }
                if self.read_workspace(workspace).is_none());
            !same(other) && !unreadable
        });
        entries.insert(0, entry);
        // Wer aus der Liste fällt, nimmt seinen Workspace mit; ein Projekt
        // behält seine Aufteilung wie bisher.
        for dropped in entries.split_off(MAX_ENTRIES.min(entries.len())) {
            if let StoredEntry::Workspace { workspace } = dropped {
                let _ = std::fs::remove_file(self.workspace_file(&workspace));
            }
        }
        self.save(entries)
    }

    /// Entfernt den Eintrag, den `same` erkennt, und löscht `file`.
    fn forget(&self, same: impl Fn(&StoredEntry) -> bool, file: &Path) -> io::Result<()> {
        let _guard = self.lock.lock();
        let mut entries = self.load();
        let before = entries.len();
        entries.retain(|entry| !same(entry));
        let _ = std::fs::remove_file(file);
        if entries.len() == before {
            return Ok(());
        }
        self.save(entries)
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

    /// Name, Projekte, Aufteilung und Fenstergeometrie des Workspace; nichts,
    /// wenn keine lesbare Datei unter dieser Kennung gespeichert ist.
    pub fn workspace_state(&self, id: &str) -> Option<WorkspaceState> {
        let _guard = self.lock.lock();
        self.read_workspace(id)
    }

    fn read_workspace(&self, id: &str) -> Option<WorkspaceState> {
        let bytes = std::fs::read(self.workspace_file(id)).ok()?;
        match serde_json::from_slice::<StoredWorkspace>(&bytes) {
            Ok(stored) if stored.version == VERSION && stored.id == id => Some(WorkspaceState {
                name: stored.name,
                projects: stored.projects,
                arrangement: stored.arrangement,
                window: stored.window,
            }),
            _ => None,
        }
    }

    /// Merkt sich den Workspace unter seiner Kennung.
    pub fn save_workspace_state(&self, id: &str, state: &WorkspaceState) -> io::Result<()> {
        let _guard = self.lock.lock();
        let stored = StoredWorkspace {
            version: VERSION,
            id: id.to_string(),
            name: state.name.clone(),
            projects: state
                .projects
                .iter()
                .map(|p| paths::normalized(p))
                .collect(),
            arrangement: state.arrangement.clone(),
            window: state.window,
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
        paths::write_whole(&self.workspace_file(id), json)
    }

    /// Die Kennungen der Workspaces, die beim Schließen des letzten Fensters
    /// offen waren; eine fehlende oder nicht lesbare Datei ergibt keine.
    pub fn open_workspaces(&self) -> Vec<String> {
        let _guard = self.lock.lock();
        let Ok(bytes) = std::fs::read(self.dir.join(OPEN_WORKSPACES_FILE)) else {
            return Vec::new();
        };
        match serde_json::from_slice::<StoredOpenWorkspaces>(&bytes) {
            Ok(stored) if stored.version == VERSION => stored.workspaces,
            _ => Vec::new(),
        }
    }

    /// Merkt sich, welche Workspaces gerade offen sind.
    pub fn remember_open_workspaces(&self, ids: &[String]) -> io::Result<()> {
        let _guard = self.lock.lock();
        let stored = StoredOpenWorkspaces {
            version: VERSION,
            workspaces: ids.to_vec(),
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
        paths::write_whole(&self.dir.join(OPEN_WORKSPACES_FILE), json)
    }

    /// Die Datei des Projekts. Ihr Name folgt aus dem Projektpfad, gleich in
    /// welcher Schreibweise.
    fn state_file(&self, folder: &Path) -> PathBuf {
        self.dir
            .join(ARRANGEMENTS_DIR)
            .join(format!("{:016x}.json", file_hash(&paths::key(folder))))
    }

    /// Die Datei des Workspace. Ihr Name folgt aus der Kennung, damit die
    /// Kennung selbst keine Zeichen für Dateinamen enthalten muss.
    fn workspace_file(&self, id: &str) -> PathBuf {
        self.dir
            .join(WORKSPACES_DIR)
            .join(format!("{:016x}.json", file_hash(id)))
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn load(&self) -> Vec<StoredEntry> {
        let Ok(bytes) = std::fs::read(self.file()) else {
            return Vec::new();
        };
        match serde_json::from_slice::<StoredFile>(&bytes) {
            Ok(stored) if stored.version == VERSION => stored.projects,
            _ => Vec::new(),
        }
    }

    fn save(&self, entries: Vec<StoredEntry>) -> io::Result<()> {
        let stored = StoredFile {
            version: VERSION,
            projects: entries,
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
        paths::write_whole(&self.file(), json)
    }
}

/// Ein Projekt der Zuletzt-Liste, mit dem Blick darauf, ob sein Ordner noch da ist.
fn recent_project(path: PathBuf) -> RecentProject {
    RecentProject {
        exists: path.is_dir(),
        path,
    }
}

/// FNV-1a: über Versionen von Rust und Kredr hinweg derselbe Dateiname.
fn file_hash(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}
