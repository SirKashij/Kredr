//! Pfade: die eine Stelle im Kern, die weiß, wann zwei Pfade dasselbe meinen,
//! wie ein Programm im Suchpfad gefunden wird und wie eine Datei so
//! geschrieben wird, dass nie eine halbe zurückbleibt.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

/// Der vollständige Pfad ohne `.`, `..` und abschließenden Trenner.
pub(crate) fn normalized(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    absolute.components().collect()
}

/// Woran ein Pfad wiedererkannt wird, gleich in welcher Schreibweise:
/// Windows unterscheidet weder Groß- und Kleinschreibung noch einen
/// abschließenden Trenner.
pub(crate) fn key(path: &Path) -> String {
    normalized(path).to_string_lossy().to_lowercase()
}

/// Ob beide Pfade dieselbe Datei oder denselben Ordner meinen.
pub(crate) fn same(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

/// Der Suchpfad dieses Prozesses (die Umgebungsvariable `PATH`).
pub(crate) fn search_path() -> OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

/// Die Dateien mit einem der Namen `names` in den Ordnern von `search_path`
/// (im Format der Umgebungsvariable `PATH`), in der Reihenfolge der Ordner.
pub(crate) fn find_programs<'a>(
    search_path: &'a OsStr,
    names: &'a [String],
) -> impl Iterator<Item = PathBuf> + 'a {
    std::env::split_paths(search_path).flat_map(move |dir| {
        names
            .iter()
            .map(|name| dir.join(name))
            .filter(|file| file.is_file())
            .collect::<Vec<_>>()
    })
}

/// Schreibt die Datei als Ganzes und legt ihren Ordner an, wenn er fehlt:
/// erst daneben schreiben, dann umbenennen. Ein Absturz mitten im Schreiben
/// hinterlässt die alte Datei, keine halbe.
pub(crate) fn write_whole(file: &Path, content: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut draft = file.as_os_str().to_owned();
    draft.push(".tmp");
    std::fs::write(&draft, content)?;
    std::fs::rename(draft, file)
}
