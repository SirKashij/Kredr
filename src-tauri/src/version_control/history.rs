//! Die Commit-Liste (Verlauf): Commits des aktuellen Branches, ihre Dateien
//! und deren Diffs.

use serde::{Deserialize, Serialize};

use super::{failed, Diff, FileStatus, VersionControl, VersionControlError};

/// Ein Commit des aktuellen Branches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// Die volle Kennung (Hash).
    pub id: String,
    /// Die vollständige Nachricht, auch mehrzeilig; ohne Leerzeilen am Ende.
    pub message: String,
    /// Der Name des Autors.
    pub author: String,
    /// Wann der Autor festgeschrieben hat, in Sekunden seit 1970 (UTC).
    pub time: i64,
    /// Ob der Commit auf einem Branch eines Remotes liegt. Ohne
    /// eingetragenes Remote gilt jeder Commit als gepusht, weil es nichts
    /// gibt, wohin er fehlen könnte.
    pub pushed: bool,
}

/// Eine Datei, die ein Commit geändert hat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Relativ zum Projektordner und mit `/` getrennt.
    pub path: String,
    /// Der frühere Pfad einer umbenannten Datei.
    pub original_path: Option<String>,
    /// `Modified`, `Added`, `Deleted` oder `Renamed`.
    pub status: FileStatus,
}

impl VersionControl {
    /// Liefert Commits des aktuellen Branches, die neuesten zuerst: höchstens
    /// `limit` Stück nach den ersten `skip`. Kommen weniger als `limit`
    /// zurück, gibt es keine älteren mehr. Vor dem ersten Commit ist die
    /// Liste leer.
    pub fn commits(&self, skip: usize, limit: usize) -> Result<Vec<Commit>, VersionControlError> {
        let (skip, limit) = (format!("--skip={skip}"), format!("--max-count={limit}"));
        // Je Commit ein Abschnitt, die Felder durch das Zeichen 0x1f getrennt.
        let format = "--format=%H%x1f%an%x1f%at%x1f%B";
        let output = match self.git(&["log", "-z", format, &skip, &limit, "HEAD", "--"], None) {
            Ok(output) => output,
            // Ein frisches Repository hat noch keinen Commit.
            Err(error) if error.details.contains("bad revision 'HEAD'") => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let text = String::from_utf8_lossy(&output);
        let mut commits = Vec::new();
        for record in text.split('\0').filter(|record| !record.is_empty()) {
            let fields: Vec<&str> = record.splitn(4, '\x1f').collect();
            let [id, author, time, message] = fields[..] else {
                return Err(failed("unexpected output of git log"));
            };
            commits.push(Commit {
                id: id.to_owned(),
                message: message.trim_end().to_owned(),
                author: author.to_owned(),
                time: time.parse().unwrap_or_default(),
                pushed: true,
            });
        }
        if commits.is_empty() {
            return Ok(commits);
        }
        let unpushed = self.unpushed()?;
        for commit in &mut commits {
            commit.pushed = !unpushed.contains(&commit.id);
        }
        Ok(commits)
    }

    /// Die Commits des aktuellen Branches, die auf keinem Branch eines
    /// Remotes liegen (nach dem Stand des letzten Abgleichs; es wird nichts
    /// geholt). Ohne eingetragenes Remote ist die Menge leer.
    fn unpushed(&self) -> Result<std::collections::HashSet<String>, VersionControlError> {
        if self.git(&["remote"], None)?.is_empty() {
            return Ok(std::collections::HashSet::new());
        }
        let output = self.git(&["rev-list", "HEAD", "--not", "--remotes", "--"], None)?;
        let text = String::from_utf8_lossy(&output);
        Ok(text.lines().map(str::to_owned).collect())
    }

    /// Liefert die Dateien im Projektordner, die der Commit gegenüber seinem
    /// Vorgänger geändert hat (bei einer Zusammenführung gegenüber dem ersten
    /// Vorgänger), nach Pfad sortiert.
    pub fn commit_files(&self, commit: &str) -> Result<Vec<CommitFile>, VersionControlError> {
        let commit = commit_id(commit)?;
        let output = self.git(
            &[
                "diff-tree",
                "-r",
                "-z",
                "--no-commit-id",
                "--name-status",
                "--find-renames",
                // Der erste Commit hat keinen Vorgänger: Alles ist neu.
                "--root",
                "--diff-merges=first-parent",
                // Nur der Projektordner, die Pfade ab dort.
                "--relative",
                commit,
                "--",
            ],
            None,
        )?;
        let text = String::from_utf8_lossy(&output);
        let mut fields = text.split('\0');
        let mut files = Vec::new();
        while let Some(code) = fields.next().filter(|code| !code.is_empty()) {
            let unexpected = || failed("unexpected output of git diff-tree");
            let status = match code.chars().next() {
                Some('A' | 'C') => FileStatus::Added,
                Some('D') => FileStatus::Deleted,
                Some('R') => FileStatus::Renamed,
                _ => FileStatus::Modified,
            };
            // Bei einer Umbenennung steht der frühere Pfad vor dem neuen.
            let original_path = match status {
                FileStatus::Renamed => Some(fields.next().ok_or_else(unexpected)?.to_owned()),
                _ => None,
            };
            files.push(CommitFile {
                path: fields.next().ok_or_else(unexpected)?.to_owned(),
                original_path,
                status,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// Liefert die beiden Fassungen, die der Diff einer Datei eines Commits
    /// gegenüberstellt: die des (ersten) Vorgängers und die des Commits. Eine
    /// Fassung, die es nicht gibt (neue oder gelöschte Datei), ist `Missing`.
    pub fn commit_diff(
        &self,
        commit: &str,
        file: &CommitFile,
    ) -> Result<Diff, VersionControlError> {
        let commit = commit_id(commit)?;
        let path = &file.path;
        let earlier = file.original_path.as_deref().unwrap_or(path);
        let revisions = [
            format!("{commit}^:./{earlier}"),
            format!("{commit}:./{path}"),
        ];
        let [original, modified] = self.versions(revisions)?;
        Ok(Diff { original, modified })
    }
}

/// Lässt als Commit nur eine Kennung (Hash) zu, damit die Angabe weder als
/// Option noch als anderer Stand gelesen werden kann.
fn commit_id(commit: &str) -> Result<&str, VersionControlError> {
    if commit.is_empty() || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(failed(format!("not a commit id: {commit}")));
    }
    Ok(commit)
}
