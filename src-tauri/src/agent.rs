//! Agent-Start: der Befehl, der in einem Terminal einen Agenten startet, und
//! die Prüfung, ob sein Programm installiert ist. Kredr gibt dem Agenten
//! nichts mit und fasst keine Einstellungen von Claude Code an.

use std::ffi::OsStr;

/// Startet Claude Code, solange die Einstellungen nichts anderes sagen.
pub const DEFAULT_START_COMMAND: &str = "claude";

/// Endungen, unter denen PowerShell ein Programm ohne Angabe der Endung findet.
const EXTENSIONS: [&str; 5] = ["exe", "cmd", "bat", "com", "ps1"];

/// Der Name des Programms, das `command` aufruft, wenn es in keinem Ordner
/// von `search_path` (im Format der Umgebungsvariable `PATH`) liegt.
///
/// Geprüft wird nur ein schlichter Programmname am Anfang des Befehls. Ein
/// Pfad, ein Aufruf mit `&` oder eine Variable gilt nie als fehlend; das
/// entscheidet die Shell. Ebenso wenig erkennt die Prüfung Aliase und
/// Funktionen aus dem PowerShell-Profil: Wer `claude` nur so bereitstellt,
/// bekommt den Hinweis zu Unrecht.
pub fn missing_program(command: &str, search_path: &OsStr) -> Option<String> {
    let program = command.split_whitespace().next()?;
    let plain = program
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !plain {
        return None;
    }
    let found = std::env::split_paths(search_path).any(|dir| {
        dir.join(program).is_file()
            || EXTENSIONS
                .iter()
                .any(|extension| dir.join(format!("{program}.{extension}")).is_file())
    });
    (!found).then(|| program.to_owned())
}
