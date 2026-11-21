//! Die Befehle der Textsuche für die Oberfläche. Die Logik liegt in `search`.

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::State;

use crate::search::{self, FileMatches, SearchError, SearchOutcome, Searches, TextQuery};

/// Durchsucht die Dateien des Projekts nach einem Text. Die Treffer kommen
/// bündelweise über `on_matches`, solange die Suche läuft; sie endet auch,
/// wenn das Fenster eine neuere Suche beginnt oder `search_cancel` ruft.
/// `id` zählt die Suchen des Fensters aufsteigend ab 1.
#[tauri::command(async)]
pub(crate) fn search_text(
    window: tauri::Window,
    searches: State<'_, Searches>,
    project: PathBuf,
    id: u32,
    query: TextQuery,
    on_matches: Channel<Vec<FileMatches>>,
) -> Result<SearchOutcome, SearchError> {
    let cancelled = SearchOutcome {
        cancelled: true,
        limit_reached: false,
    };
    let Some(cancellation) = searches.begin(window.label(), id) else {
        return Ok(cancelled);
    };
    let (found, files) = std::sync::mpsc::channel();
    let outcome = std::thread::scope(|scope| {
        let search = scope.spawn(|| {
            search::search_text(&project, &query, &cancellation, move |file| {
                let _ = found.send(file);
            })
        });
        // Was in kurzer Zeit zusammenkommt, geht als ein Bündel an die Oberfläche.
        while let Ok(first) = files.recv() {
            let mut batch = vec![first];
            batch.extend(files.try_iter());
            // Scheitert das Senden, ist das Fenster bereits geschlossen.
            if on_matches.send(batch).is_err() {
                cancellation.cancel();
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        search.join().unwrap_or(Ok(cancelled))
    });
    searches.finish(window.label(), id);
    outcome
}

/// Bricht die Suche `id` des Fensters ab, auch wenn sie noch nicht begonnen hat.
#[tauri::command]
pub(crate) fn search_cancel(window: tauri::Window, searches: State<'_, Searches>, id: u32) {
    searches.cancel(window.label(), id);
}
