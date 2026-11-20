//! Agent-Start: der Befehl, der in einem Terminal einen Agenten startet, und
//! die Prüfung, ob sein Programm installiert ist. Kredr gibt dem Agenten
//! nur die Konfiguration für den Agentenstatus mit und fasst keine
//! Einstellungen von Claude Code an.

use std::ffi::OsStr;
use std::path::Path;

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

/// Der Startbefehl `command`, ergänzt um die Konfigurationsdatei `settings`
/// für den Agentenstatus. Sie gilt nur für diese eine Sitzung von Claude
/// Code und kommt zu dessen eigenen Einstellungen hinzu.
///
/// Ergänzt wird nur, wenn der Befehl mit dem Programm `claude` beginnt, als
/// Name oder als Pfad ohne Leerzeichen. Jeder andere Befehl bleibt, wie er
/// ist; sein Agent hat dann keinen Agentenstatus.
pub fn with_status_settings(command: &str, settings: &Path) -> String {
    let trimmed = command.trim_start();
    let program = trimmed.split_whitespace().next().unwrap_or_default();
    let is_claude = Path::new(program)
        .file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|stem| stem.eq_ignore_ascii_case("claude"));
    let plain = !program.contains(['"', '\'', '$', '&', ';', '|']);
    if !is_claude || !plain {
        return command.to_owned();
    }
    // In einfachen Anführungszeichen wertet PowerShell nichts aus; ein
    // Apostroph im Pfad wird verdoppelt.
    let quoted = settings.to_string_lossy().replace('\'', "''");
    let rest = &trimmed[program.len()..];
    format!("{program} --settings '{quoted}'{rest}")
}
