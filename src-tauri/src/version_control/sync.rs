//! Festschreiben und Abgleichen: Auswählen, Verwerfen, Commit, Push, Pull
//! und Fetch.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::{failed, ChangedFile, ErrorReason, FileStatus, VersionControl, VersionControlError};
use crate::project_files;

/// Das Ergebnis von „Commit & Push“, sobald der Commit geschrieben ist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    /// Warum der anschließende Push scheiterte; fehlt, wenn er gelang. Der
    /// Commit besteht in beiden Fällen.
    pub push_error: Option<VersionControlError>,
}

/// Festschreiben und Abgleichen. Jede Operation verändert das Repository;
/// wer den Zustand abonniert hat, erfährt das Ergebnis von selbst.
impl VersionControl {
    /// Wählt die Änderungen zum Festschreiben aus.
    pub fn stage(&self, files: &[ChangedFile]) -> Result<(), VersionControlError> {
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        self.with_paths(&["add", "--all"], &paths)
    }

    /// Wählt alle Änderungen im Projektordner aus.
    pub fn stage_all(&self) -> Result<(), VersionControlError> {
        self.git(&["add", "--all", "--", "."], None).map(drop)
    }

    /// Nimmt Änderungen aus der Auswahl; die Dateien selbst bleiben, wie sie sind.
    pub fn unstage(&self, files: &[ChangedFile]) -> Result<(), VersionControlError> {
        // Eine Umbenennung besteht in der Auswahl aus beiden Pfaden.
        let paths: Vec<&str> = files
            .iter()
            .flat_map(|file| [Some(file.path.as_str()), file.original_path.as_deref()])
            .flatten()
            .collect();
        self.with_paths(&["reset", "--quiet"], &paths)
    }

    /// Nimmt alle Änderungen im Projektordner aus der Auswahl.
    pub fn unstage_all(&self) -> Result<(), VersionControlError> {
        self.git(&["reset", "--quiet", "--", "."], None).map(drop)
    }

    /// Verwirft eine nicht ausgewählte Änderung: Die Datei erhält wieder den
    /// Stand der Auswahl bzw. des letzten Commits. Eine Datei, die Git noch
    /// nicht kennt, wandert in den Windows-Papierkorb. Die Rückfrage stellt
    /// die Oberfläche.
    pub fn discard(&self, file: &ChangedFile) -> Result<(), VersionControlError> {
        if file.staged {
            return Err(failed("a staged change has to be unstaged first"));
        }
        match file.status {
            FileStatus::Untracked => {
                project_files::move_to_trash(&self.project.join(&file.path)).map_err(failed)
            }
            FileStatus::Conflicted => Err(failed("a conflict cannot be discarded")),
            _ => self.with_paths(&["checkout"], &[&file.path]),
        }
    }

    /// Schreibt fest: die ausgewählten Änderungen, oder, wenn im
    /// Projektordner nichts ausgewählt ist, alle (wie VS Code).
    pub fn commit(&self, message: &str) -> Result<(), VersionControlError> {
        if !self.state()?.files.iter().any(|file| file.staged) {
            self.stage_all()?;
        }
        self.slow(&["commit", "--quiet", "--file=-"], Some(message.as_bytes()))
            .map(drop)
    }

    /// „Commit & Push“: schreibt fest wie [`VersionControl::commit`] und
    /// pusht danach. Scheitert der Commit, wird nicht gepusht. Scheitert nur
    /// der Push, bleibt der Commit bestehen und das Ergebnis nennt den Grund.
    pub fn commit_and_push(&self, message: &str) -> Result<Committed, VersionControlError> {
        self.commit(message)?;
        Ok(Committed {
            push_error: self.push().err(),
        })
    }

    /// Pusht den aktuellen Branch. Gibt es ihn auf dem Remote noch nicht,
    /// wird er dort angelegt und fortan verfolgt. Hat das Remote neuere Commits,
    /// scheitert der Push mit `PushRejected`.
    pub fn push(&self) -> Result<(), VersionControlError> {
        let state = self.state()?;
        if state.upstream.is_some() {
            return self.sync(&["push"]);
        }
        let branch = state
            .branch
            .ok_or_else(|| failed("no branch is checked out, so there is nothing to push"))?;
        let remote = self.remote()?;
        self.sync(&["push", "--set-upstream", &remote, &branch])
    }

    /// Holt die neueren Commits des Remotes und führt sie mit dem
    /// aktuellen Branch zusammen. Entstehen dabei Konflikte, scheitert der
    /// Aufruf mit `Conflict`.
    pub fn pull(&self) -> Result<(), VersionControlError> {
        // Hat der Nutzer festgelegt, wie auseinandergelaufene Branches
        // zusammenkommen, gilt das. Ohne Festlegung verweigert Git den Pull;
        // dann wird zusammengeführt.
        let configured = self
            .git(
                &[
                    "config",
                    "--get-regexp",
                    r"^(pull\.(rebase|ff)|branch\..*\.rebase)$",
                ],
                None,
            )
            .is_ok();
        if configured {
            self.sync(&["pull"])
        } else {
            self.sync(&["pull", "--no-rebase"])
        }
    }

    /// „Erst holen, dann pushen“: der Ausweg nach einem abgelehnten Push.
    /// Gepusht wird nur, wenn das Holen ohne Konflikte gelang.
    pub fn pull_and_push(&self) -> Result<(), VersionControlError> {
        self.pull()?;
        self.push()
    }

    /// Fragt den Stand des Remotes ab, ohne den Branch oder die Dateien
    /// zu verändern. Danach nennt der Zustand den aktuellen Rückstand.
    pub fn fetch(&self) -> Result<(), VersionControlError> {
        self.remote()?;
        self.sync(&["fetch"])
    }

    /// Fragt den Stand des Remotes sofort und danach in diesem Abstand
    /// im Hintergrund ab, bis der Rückgabewert verworfen wird. Was dabei
    /// scheitert (kein Netz, keine Anmeldung, kein Remote), bleibt
    /// still: Der Zustand behält dann den zuletzt bekannten Stand.
    pub fn fetch_regularly(self, interval: Duration) -> BackgroundFetch {
        let (stop, stopped) = mpsc::channel::<()>();
        thread::spawn(move || loop {
            let _ = self.fetch();
            // Endet, sobald der Rückgabewert verworfen ist.
            if stopped.recv_timeout(interval) != Err(mpsc::RecvTimeoutError::Timeout) {
                break;
            }
        });
        BackgroundFetch { _stop: stop }
    }

    /// Das Remote, mit dem abgeglichen wird: `origin`, sonst das erste.
    fn remote(&self) -> Result<String, VersionControlError> {
        let output = self.git(&["remote"], None)?;
        let output = String::from_utf8_lossy(&output);
        let mut remotes = output.lines();
        let first = remotes.next();
        let remote = remotes.find(|remote| *remote == "origin").or(first);
        remote.map(str::to_owned).ok_or(VersionControlError {
            reason: ErrorReason::NoRemote,
            details: "no remote is configured".to_owned(),
        })
    }

    /// Ruft Git mit der langen Zeitgrenze auf.
    fn slow(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, VersionControlError> {
        self.run(args, input, self.options.long_timeout)
    }

    /// Ein Aufruf, der mit dem Remote abgleicht; sein Scheitern wird
    /// eingeordnet, damit die Oberfläche den passenden Ausweg anbieten kann.
    fn sync(&self, args: &[&str]) -> Result<(), VersionControlError> {
        match self.slow(args, None) {
            Ok(_) => Ok(()),
            Err(error) if error.reason == ErrorReason::Failed => Err(VersionControlError {
                reason: sync_failure(&error.details),
                details: error.details,
            }),
            Err(error) => Err(error),
        }
    }

    /// Ruft einen Git-Befehl für genau diese Pfade auf (ab dem Projektordner,
    /// wörtlich genommen). Ohne Pfade geschieht nichts.
    fn with_paths(&self, command: &[&str], paths: &[&str]) -> Result<(), VersionControlError> {
        if paths.is_empty() {
            return Ok(());
        }
        // Über die Eingabe, weil die Befehlszeile für viele Dateien zu kurz ist.
        let mut args = vec!["--literal-pathspecs"];
        args.extend(command);
        args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        self.git(&args, Some(paths.join("\0").as_bytes())).map(drop)
    }
}

/// Das regelmäßige Abfragen des Remotes; es endet, wenn der Wert
/// verworfen wird.
pub struct BackgroundFetch {
    _stop: mpsc::Sender<()>,
}

/// Ordnet die Meldung eines gescheiterten Abgleichs ein.
fn sync_failure(details: &str) -> ErrorReason {
    let mentions = |texts: &[&str]| texts.iter().any(|text| details.contains(text));
    if mentions(&["(fetch first)", "(non-fast-forward)"]) {
        ErrorReason::PushRejected
    } else if mentions(&["CONFLICT", "Automatic merge failed", "could not apply"]) {
        ErrorReason::Conflict
    } else if mentions(&[
        "terminal prompts disabled",
        "could not read Username",
        "could not read Password",
        "Authentication failed",
        "user interactivity has been disabled",
        "Permission denied",
        "Host key verification failed",
    ]) {
        ErrorReason::AuthenticationRequired
    } else if mentions(&[
        "Could not resolve host",
        "Could not resolve hostname",
        "Failed to connect",
        "Couldn't connect",
        "Connection timed out",
        "Connection refused",
        "Network is unreachable",
        "does not appear to be a git repository",
        "Could not read from remote repository",
    ]) {
        ErrorReason::Unreachable
    } else {
        ErrorReason::Failed
    }
}
