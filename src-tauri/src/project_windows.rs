//! Welches Fenster was zeigt: die Startseite, ein einzelnes Projekt oder
//! einen Workspace. Ein Projekt ist höchstens in einem Fenster offen, auch
//! wenn es in einem Workspace steckt.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::arrangement_store::RestartWindow;
use crate::paths;

/// Was ein Fenster zeigt; die Oberfläche hält denselben Typ.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowContent {
    /// Noch kein Projekt: die Liste zuletzt geöffneter Projekte.
    #[default]
    StartPage,
    /// Ein einzelnes Projekt ohne Workspace.
    Project { path: PathBuf },
    /// Mehrere Projekte in Reihenfolge; die Liste darf auch leer sein.
    Workspace {
        /// Unabhängig von Name und Projekten, damit Umbenennen und
        /// Umsortieren keinen neuen Workspace ergeben.
        id: String,
        name: String,
        projects: Vec<PathBuf>,
    },
}

impl WindowContent {
    /// Die Projektordner, die das Fenster zeigt, in Reihenfolge.
    pub fn projects(&self) -> &[PathBuf] {
        match self {
            WindowContent::StartPage => &[],
            WindowContent::Project { path } => std::slice::from_ref(path),
            WindowContent::Workspace { projects, .. } => projects,
        }
    }

    /// Ob das Projekt zum Inhalt gehört, gleich in welcher Schreibweise.
    pub fn contains(&self, folder: &Path) -> bool {
        self.projects().iter().any(|open| paths::same(open, folder))
    }
}

/// Die offenen Fenster nach Kennung, jeweils mit ihrem Inhalt.
#[derive(Default)]
pub struct ProjectWindows {
    next_label: AtomicU32,
    open: Mutex<HashMap<String, WindowContent>>,
}

impl ProjectWindows {
    /// Eine Kennung für ein weiteres Fenster.
    pub fn next_label(&self) -> String {
        let number = self.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        format!("window-{number}")
    }

    /// Legt fest, was das Fenster zeigt.
    pub fn assign(&self, label: &str, content: WindowContent) {
        self.lock().insert(label.to_string(), content);
    }

    /// Legt fest, was das Fenster zeigt, sofern keines seiner Projekte in
    /// einem anderen Fenster offen ist. Sonst bleibt alles, wie es war, und
    /// das Ergebnis nennt jenes Fenster.
    pub fn claim(&self, label: &str, content: WindowContent) -> Result<(), String> {
        let mut open = self.lock();
        let elsewhere = open.iter().find(|(other, shown)| {
            other.as_str() != label
                && content
                    .projects()
                    .iter()
                    .any(|folder| shown.contains(folder))
        });
        if let Some((other, _)) = elsewhere {
            return Err(other.clone());
        }
        open.insert(label.to_string(), content);
        Ok(())
    }

    /// Vergisst ein geschlossenes Fenster.
    pub fn release(&self, label: &str) {
        self.lock().remove(label);
    }

    /// Was das Fenster zeigt; ein unbekanntes Fenster zeigt die Startseite.
    pub fn content_of(&self, label: &str) -> WindowContent {
        self.lock().get(label).cloned().unwrap_or_default()
    }

    /// Das Fenster, in dem das Projekt bereits offen ist, allein oder in einem Workspace.
    pub fn window_of(&self, folder: &Path) -> Option<String> {
        self.lock()
            .iter()
            .find(|(_, content)| content.contains(folder))
            .map(|(label, _)| label.clone())
    }

    /// Ob noch ein Fenster offen ist.
    pub fn any_open(&self) -> bool {
        !self.lock().is_empty()
    }

    /// Die Kennungen der Workspaces, die gerade in einem Fenster offen sind.
    pub fn workspace_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .lock()
            .values()
            .filter_map(|content| match content {
                WindowContent::Workspace { id, .. } => Some(id.clone()),
                WindowContent::StartPage | WindowContent::Project { .. } => None,
            })
            .collect();
        ids.sort();
        ids
    }

    /// Was die offenen Fenster zeigen, in der Reihenfolge, in der sie
    /// entstanden: das erste Fenster zuerst.
    pub fn contents(&self) -> Vec<WindowContent> {
        let mut open: Vec<(u32, WindowContent)> = self
            .lock()
            .iter()
            .map(|(label, content)| {
                // Das erste Fenster heißt anders und hat keine Nummer.
                let number = label
                    .strip_prefix("window-")
                    .and_then(|number| number.parse().ok())
                    .unwrap_or(0);
                (number, content.clone())
            })
            .collect();
        open.sort_by_key(|(number, _)| *number);
        open.into_iter().map(|(_, content)| content).collect()
    }

    /// Ein Fenster, das noch die Startseite zeigt.
    pub fn start_page_window(&self) -> Option<String> {
        self.lock()
            .iter()
            .find(|(_, content)| **content == WindowContent::StartPage)
            .map(|(label, _)| label.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WindowContent>> {
        // Die Zuordnung bleibt auch nach einem Absturz eines anderen Threads gültig.
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Der Ordner, den ein Aufruf von Kredr als Projekt öffnen soll: das erste
/// Argument nach dem Programmnamen, wenn es ein Ordner ist. Relative Pfade
/// wie in `kredr .` gelten ab `cwd`, dem Ordner, in dem der Befehl lief.
pub fn project_from_args(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let argument = args.get(1)?;
    // Der Rechtsklick-Eintrag übergibt den Ordner in Anführungszeichen. Endet
    // er auf einen Backslash (Laufwerksstamm `D:\`), liest Windows diesen als
    // Maskierung des schließenden Zeichens, und es kommt `D:"` an.
    let folder = match argument.strip_suffix('"') {
        Some(start) => format!("{start}\\"),
        None => argument.clone(),
    };
    project_folder(&cwd.join(folder))
}

/// Womit Kredr beim Start seine Fenster füllt.
#[derive(Debug, PartialEq, Eq)]
pub enum StartWindows {
    /// Nach einer Aktualisierung alle Fenster, die vorher offen waren.
    Restart(Vec<RestartWindow>),
    /// Das Projekt aus den Programmargumenten (`kredr <Ordner>`).
    Project(PathBuf),
    /// Die Startseite und die Workspaces, die beim Beenden offen waren.
    OpenWorkspaces,
}

/// Die Fenster für diesen Start. Die Notiz für den Neustart geht dem
/// Projektargument vor: Der Updater startet Kredr mit den Argumenten des
/// ersten Starts neu, nach `kredr <Ordner>` also wieder mit diesem Ordner.
pub fn start_windows(project: Option<PathBuf>, restart: Vec<RestartWindow>) -> StartWindows {
    if !restart.is_empty() {
        return StartWindows::Restart(restart);
    }
    match project {
        Some(folder) => StartWindows::Project(folder),
        None => StartWindows::OpenWorkspaces,
    }
}

/// Der vollständige Pfad des Ordners, wenn es ihn gibt.
pub fn project_folder(folder: &Path) -> Option<PathBuf> {
    if !folder.is_dir() {
        return None;
    }
    Some(paths::normalized(folder))
}
