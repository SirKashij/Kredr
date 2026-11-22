//! Vorbereitete Antworten auf Ordnerdialoge für die Entwicklungsfassung.
//! Ein Skript, das Kredr über CDP bedient, erreicht den Windows-Dialog
//! nicht; mit `KREDR_TEST_FOLDERS` (Ordner durch `;` getrennt) antwortet
//! Kredr an seiner Stelle.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::Mutex;

/// Die Umgebungsvariable mit den vorbereiteten Ordnern.
const VARIABLE: &str = "KREDR_TEST_FOLDERS";

/// Die noch offenen Antworten; ohne sie erscheint der Dialog.
#[derive(Default)]
pub struct DialogAnswers {
    folders: Mutex<VecDeque<PathBuf>>,
}

impl DialogAnswers {
    /// Die Antworten aus der Umgebung, nur in der Entwicklungsfassung.
    pub fn from_env() -> DialogAnswers {
        match std::env::var_os(VARIABLE) {
            Some(list) if cfg!(debug_assertions) => DialogAnswers::from_list(&list),
            _ => DialogAnswers::default(),
        }
    }

    /// Die Ordner einer Liste im Format von `PATH`.
    pub fn from_list(list: &OsStr) -> DialogAnswers {
        let folders = std::env::split_paths(list)
            .filter(|folder| !folder.as_os_str().is_empty())
            .collect();
        DialogAnswers {
            folders: Mutex::new(folders),
        }
    }

    /// Der nächste vorbereitete Ordner. Der letzte bleibt die Antwort auf
    /// jeden weiteren Dialog.
    pub fn next(&self) -> Option<PathBuf> {
        let mut folders = self.folders.lock().unwrap_or_else(|e| e.into_inner());
        if folders.len() > 1 {
            folders.pop_front()
        } else {
            folders.front().cloned()
        }
    }
}

/// Der vorbereitete Ordner für den nächsten Ordnerdialog; nichts heißt:
/// Die Oberfläche zeigt den Dialog.
#[tauri::command]
pub fn dialog_answer(answers: tauri::State<'_, DialogAnswers>) -> Option<PathBuf> {
    answers.next()
}
