//! Liest die maschinenlesbare Ausgabe von `git status` in den Zustand des
//! Repositorys.

use super::{ChangedFile, FileStatus, RepositoryState};

/// Liest die Ausgabe von `git status --porcelain=v2 --branch -z`. `prefix`
/// ist der Pfad des Projektordners im Repository.
pub(super) fn parse_status(output: &[u8], prefix: &str) -> RepositoryState {
    let text = String::from_utf8_lossy(output);
    let mut state = RepositoryState {
        branch: None,
        commit: None,
        files: Vec::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        ignored: Vec::new(),
    };
    let mut untracked = Vec::new();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        let Some((kind, rest)) = record.split_once(' ') else {
            continue;
        };
        // Je Art steht der Pfad nach einer festen Zahl von Feldern.
        let fields = |count| -> Vec<&str> { rest.splitn(count, ' ').collect() };
        match kind {
            "#" => {
                if let Some(commit) = rest.strip_prefix("branch.oid ") {
                    state.commit = (commit != "(initial)").then(|| commit.to_owned());
                } else if let Some(branch) = rest.strip_prefix("branch.head ") {
                    state.branch = (branch != "(detached)").then(|| branch.to_owned());
                } else if let Some(upstream) = rest.strip_prefix("branch.upstream ") {
                    state.upstream = Some(upstream.to_owned());
                } else if let Some(counts) = rest.strip_prefix("branch.ab ") {
                    // „+2 -1“: zwei voraus, einer zurück.
                    let count = |sign| {
                        let number = counts.split(' ').find_map(|part| part.strip_prefix(sign));
                        number.and_then(|number| number.parse().ok()).unwrap_or(0)
                    };
                    state.ahead = count('+');
                    state.behind = count('-');
                }
            }
            "1" => {
                if let [xy, .., path] = fields(8)[..] {
                    push_changes(&mut state.files, xy, project_path(prefix, path), None);
                }
            }
            "2" => {
                // Der frühere Pfad folgt als eigener Abschnitt.
                let original = records.next().map(|path| project_path(prefix, path));
                if let [xy, .., path] = fields(9)[..] {
                    push_changes(&mut state.files, xy, project_path(prefix, path), original);
                }
            }
            "u" => {
                if let [_, .., path] = fields(10)[..] {
                    state.files.push(ChangedFile {
                        path: project_path(prefix, path),
                        original_path: None,
                        status: FileStatus::Conflicted,
                        staged: false,
                    });
                }
            }
            "?" => untracked.push(ChangedFile {
                path: project_path(prefix, rest),
                original_path: None,
                status: FileStatus::Untracked,
                staged: false,
            }),
            "!" => state.ignored.push(ignored_path(prefix, rest)),
            _ => {}
        }
    }
    state.files.append(&mut untracked);
    state.ignored.sort();
    state
}

/// Trägt die Änderungen einer Datei ein: `xy` nennt erst den ausgewählten
/// Teil (Stand der Auswahl gegenüber dem letzten Commit), dann den nicht
/// ausgewählten (Arbeitsordner gegenüber der Auswahl).
fn push_changes(files: &mut Vec<ChangedFile>, xy: &str, path: String, original: Option<String>) {
    let status = |code: char| match code {
        'M' | 'T' => Some(FileStatus::Modified),
        'A' | 'C' => Some(FileStatus::Added),
        'D' => Some(FileStatus::Deleted),
        'R' => Some(FileStatus::Renamed),
        _ => None,
    };
    let mut codes = xy.chars();
    let staged = codes.next().and_then(status);
    let unstaged = codes.next().and_then(status);
    for (status, staged) in [(staged, true), (unstaged, false)] {
        let Some(status) = status else { continue };
        files.push(ChangedFile {
            path: path.clone(),
            // Den früheren Pfad trägt nur der Teil, der die Umbenennung enthält.
            original_path: original.clone().filter(|_| status == FileStatus::Renamed),
            status,
            staged,
        });
    }
}

/// Macht aus einem Pfad ab dem Repository einen Pfad ab dem Projektordner.
fn project_path(prefix: &str, path: &str) -> String {
    match path.strip_prefix(prefix) {
        Some(inside) => inside.to_owned(),
        // Außerhalb des Projektordners (der frühere Pfad einer Umbenennung).
        None => format!("{}{path}", "../".repeat(prefix.matches('/').count())),
    }
}

/// Macht aus einem ignorierten Pfad ab dem Repository einen Pfad ab dem
/// Projektordner. Ordner nennt Git mit `/` am Ende; hier stehen sie ohne.
fn ignored_path(prefix: &str, path: &str) -> String {
    // Der Projektordner selbst oder ein Ordner über ihm ist ignoriert.
    if path.ends_with('/') && prefix.starts_with(path) {
        return String::new();
    }
    project_path(prefix, path.strip_suffix('/').unwrap_or(path))
}
