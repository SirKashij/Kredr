//! Die Dateiliste des Projekts für „Datei per Namen öffnen“; Teil des
//! Kern-Moduls Suche. Sie folgt denselben Ignorier-Regeln wie die Textsuche
//! (Crate `ignore` der ripgrep-Engine).

use std::path::Path;
use std::sync::mpsc;

use ignore::{WalkBuilder, WalkState};

/// Alle Dateien des Projekts, relativ zum Projektordner, mit `/` getrennt und
/// sortiert. Was `.gitignore` ausschließt, fehlt, ebenso der Ordner `.git`;
/// versteckte Dateien wie `.env` gehören dazu. Unlesbare Ordner werden
/// übersprungen; ein fehlender Projektordner ergibt eine leere Liste.
pub fn list_files(project: &Path) -> Vec<String> {
    let (sender, receiver) = mpsc::channel::<Vec<String>>();
    WalkBuilder::new(project)
        .hidden(false)
        // Ignorier-Regeln gelten auch in einem Projekt ohne Git-Repository.
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build_parallel()
        .run(|| {
            let mut found = Found {
                files: Vec::new(),
                sender: sender.clone(),
            };
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                if let Ok(relative) = entry.path().strip_prefix(project) {
                    found
                        .files
                        .push(relative.to_string_lossy().replace('\\', "/"));
                }
                WalkState::Continue
            })
        });
    drop(sender);
    let mut files: Vec<String> = receiver.into_iter().flatten().collect();
    files.sort_unstable();
    files
}

/// Die Funde eines Threads; sie gehen gesammelt weiter, wenn er fertig ist.
struct Found {
    files: Vec<String>,
    sender: mpsc::Sender<Vec<String>>,
}

impl Drop for Found {
    fn drop(&mut self) {
        // Scheitert das Senden, wartet niemand mehr auf die Liste.
        let _ = self.sender.send(std::mem::take(&mut self.files));
    }
}
