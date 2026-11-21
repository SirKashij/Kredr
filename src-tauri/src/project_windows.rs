//! Welches Fenster welches Projekt zeigt. Ein Fenster gehört zu genau einem
//! Projekt oder zeigt die Startseite; ein Projekt ist höchstens in einem
//! Fenster offen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use crate::paths;

/// Die offenen Fenster nach Kennung, jeweils mit ihrem Projekt.
#[derive(Default)]
pub struct ProjectWindows {
    next_label: AtomicU32,
    open: Mutex<HashMap<String, Option<PathBuf>>>,
}

impl ProjectWindows {
    /// Eine Kennung für ein weiteres Fenster.
    pub fn next_label(&self) -> String {
        let number = self.next_label.fetch_add(1, Ordering::Relaxed) + 1;
        format!("window-{number}")
    }

    /// Legt fest, was das Fenster zeigt: ein Projekt oder, ohne Projekt, die Startseite.
    pub fn assign(&self, label: &str, project: Option<PathBuf>) {
        self.lock().insert(label.to_string(), project);
    }

    /// Vergisst ein geschlossenes Fenster.
    pub fn release(&self, label: &str) {
        self.lock().remove(label);
    }

    /// Das Projekt des Fensters.
    pub fn project_of(&self, label: &str) -> Option<PathBuf> {
        self.lock().get(label).cloned().flatten()
    }

    /// Das Fenster, in dem das Projekt bereits offen ist.
    pub fn window_of(&self, folder: &Path) -> Option<String> {
        self.lock()
            .iter()
            .find(|(_, project)| matches!(project, Some(open) if paths::same(open, folder)))
            .map(|(label, _)| label.clone())
    }

    /// Ein Fenster, das noch die Startseite zeigt.
    pub fn start_page_window(&self) -> Option<String> {
        self.lock()
            .iter()
            .find(|(_, project)| project.is_none())
            .map(|(label, _)| label.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Option<PathBuf>>> {
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

/// Der vollständige Pfad des Ordners, wenn es ihn gibt.
pub fn project_folder(folder: &Path) -> Option<PathBuf> {
    if !folder.is_dir() {
        return None;
    }
    Some(paths::normalized(folder))
}
