//! Versionskontrolle: liefert den Zustand eines Projekts (Branch, geänderte
//! Dateien mit Status, ausgewählt oder nicht) und Diffs, indem es das
//! installierte Git aufruft und dessen maschinenlesbare Ausgabe liest.
//!
//! Jeder Git-Aufruf läuft ohne interaktive Abfragen und mit Zeitgrenze. Wer
//! dem Zustand folgen will (Oberfläche, Explorer), abonniert ihn über
//! [`VersionControl::watch`].

mod branches;
mod history;
mod process;
mod status;
mod sync;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::project_files::{self, FileContent, ProjectWatcher, MAX_FILE_SIZE};

pub use branches::Branch;
pub use history::{Commit, CommitFile};
pub use sync::{BackgroundFetch, Committed};

use process::{finish, read_in_background, Job};
use status::parse_status;

/// Wie Git aufgerufen wird. Der Standard nimmt das installierte Git aus dem
/// Suchpfad; Tests schirmen es über `env` von der Konfiguration des Rechners ab.
#[derive(Debug, Clone)]
pub struct GitOptions {
    /// Das Git-Programm: ein Name im Suchpfad oder ein voller Pfad.
    pub program: OsString,
    /// Länger darf kein Aufruf dauern; danach wird er samt seinen
    /// Kindprozessen beendet.
    pub timeout: Duration,
    /// Die Zeitgrenze der Aufrufe, die von sich aus dauern dürfen: der
    /// Abgleich übers Netz (Push, Pull, Fetch) und der Commit, dessen Hooks
    /// etwa Prüfungen des Projekts ausführen.
    pub long_timeout: Duration,
    /// Zusätzliche Umgebungsvariablen für jeden Aufruf.
    pub env: Vec<(OsString, OsString)>,
}

impl Default for GitOptions {
    fn default() -> Self {
        GitOptions {
            program: "git".into(),
            timeout: Duration::from_secs(30),
            long_timeout: Duration::from_secs(300),
            env: Vec::new(),
        }
    }
}

/// Warum die Versionskontrolle etwas nicht liefern oder ausführen konnte.
/// Die Oberfläche macht aus dem Grund eine Meldung in der Sprache des Nutzers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorReason {
    /// Git ist nicht installiert oder nicht im Suchpfad.
    GitMissing,
    /// Der Projektordner liegt in keinem Git-Repository.
    NotARepository,
    /// Git hat nicht innerhalb der Zeitgrenze geantwortet und wurde beendet.
    TimedOut,
    /// Git hat einen Fehler gemeldet.
    Failed,
    /// Der Abgleich bräuchte eine Anmeldung oder Bestätigung des Nutzers
    /// (Zugangsdaten, Passwort des Schlüssels, unbekannter Server). Kredr
    /// fragt nicht selbst nach; ein Abgleich im Terminal holt das nach.
    AuthenticationRequired,
    /// Der Push wurde abgelehnt, weil das Remote neuere Commits hat.
    PushRejected,
    /// Das Remote ist nicht erreichbar (kein Netz, falsche Adresse).
    Unreachable,
    /// Das Repository kennt kein Remote, mit dem es abgleichen könnte.
    NoRemote,
    /// Beim Zusammenführen sind Konflikte entstanden; die betroffenen
    /// Dateien stehen als `Conflicted` im Zustand.
    Conflict,
    /// Der Branch-Wechsel würde lokale Änderungen überschreiben; Git hat ihn
    /// deshalb nicht ausgeführt, und alles ist wie zuvor.
    LocalChangesBlockSwitch,
    /// Einen Branch mit diesem Namen gibt es schon.
    BranchExists,
    /// So darf ein Branch nicht heißen.
    InvalidBranchName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VersionControlError {
    pub reason: ErrorReason,
    /// Der Originaltext von Git bzw. des Betriebssystems, unübersetzt.
    pub details: String,
}

impl fmt::Display for VersionControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.details)
    }
}

impl std::error::Error for VersionControlError {}

fn failed(details: impl fmt::Display) -> VersionControlError {
    VersionControlError {
        reason: ErrorReason::Failed,
        details: details.to_string(),
    }
}

/// Was mit einer Datei geschehen ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Modified,
    /// Neu und zum Festschreiben ausgewählt.
    Added,
    Deleted,
    Renamed,
    /// Neu und Git noch unbekannt.
    Untracked,
    /// Beim Zusammenführen in Konflikt geraten.
    Conflicted,
}

/// Eine Änderung an einer Datei. Eine Datei erscheint zweimal, wenn ein Teil
/// ihrer Änderungen ausgewählt ist und ein weiterer nicht.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relativ zum Projektordner und mit `/` getrennt.
    pub path: String,
    /// Der frühere Pfad einer umbenannten Datei.
    pub original_path: Option<String>,
    pub status: FileStatus,
    /// Ob die Änderung zum Festschreiben ausgewählt ist.
    pub staged: bool,
}

/// Der Zustand des Repositorys, in dem das Projekt liegt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryState {
    /// Der aktuelle Branch; fehlt, wenn kein Branch ausgecheckt ist.
    pub branch: Option<String>,
    /// Der aktuelle Commit; fehlt, solange es noch keinen gibt.
    pub commit: Option<String>,
    /// Alle Änderungen im Projektordner, in der Reihenfolge von Git: erst die
    /// Git bekannten Dateien nach Pfad, dann die unbekannten.
    pub files: Vec<ChangedFile>,
    /// Der Branch des Remotes, dem der aktuelle folgt, etwa `origin/main`;
    /// fehlt, solange der Branch noch nie gepusht wurde.
    pub upstream: Option<String>,
    /// Wie viele Commits noch nicht gepusht sind.
    pub ahead: u32,
    /// Wie viele Commits das Remote voraus ist, nach dem Stand des
    /// letzten Fetch.
    pub behind: u32,
    /// Was Git ignoriert, nach Pfad sortiert: Pfade ab dem Projektordner mit
    /// `/`. Ein ignorierter Ordner steht für alles darin und wird nicht
    /// Datei für Datei aufgeführt; der leere Pfad ist der Projektordner selbst.
    pub ignored: Vec<String>,
}

/// Der Zustand oder der Grund, warum es keinen gibt (kein Git, kein
/// Repository, Fehler).
pub type StateResult = Result<RepositoryState, VersionControlError>;

/// Die beiden Fassungen einer Datei, die ein Diff gegenüberstellt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diff {
    /// Die frühere Fassung.
    pub original: FileContent,
    /// Die Fassung mit der Änderung.
    pub modified: FileContent,
}

/// Die Versionskontrolle eines Projekts.
#[derive(Debug, Clone)]
pub struct VersionControl {
    project: PathBuf,
    options: GitOptions,
}

impl VersionControl {
    /// Die Versionskontrolle des Projektordners mit dem installierten Git.
    /// Der Aufruf selbst prüft nichts; ob es Git und ein Repository gibt,
    /// zeigt sich bei der ersten Abfrage.
    pub fn open(project: &Path) -> VersionControl {
        VersionControl::with_options(project, GitOptions::default())
    }

    pub fn with_options(project: &Path, options: GitOptions) -> VersionControl {
        VersionControl {
            project: project.to_path_buf(),
            options,
        }
    }

    /// Liest den aktuellen Zustand: Branch, Commit und alle Änderungen im
    /// Projektordner. Der Aufruf verändert im Repository nichts.
    pub fn state(&self) -> StateResult {
        let prefix = self.prefix()?;
        let output = self.git(
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
                // Ignorierte Ordner nur nennen, nicht durchsuchen: Sonst
                // kostete `node_modules` jede Abfrage ein Vielfaches.
                "--ignored=matching",
                "--",
                ".",
            ],
            None,
        )?;
        Ok(parse_status(&output, &prefix))
    }

    /// Liefert die beiden Fassungen, die der Diff dieser Änderung
    /// gegenüberstellt. Für eine ausgewählte Änderung sind das der letzte
    /// Commit und die Auswahl, sonst die Auswahl und die Datei im
    /// Projektordner. Eine Fassung, die es nicht gibt (neue oder gelöschte
    /// Datei), ist `Missing`; binäre und übergroße werden nicht geliefert.
    pub fn diff(&self, file: &ChangedFile) -> Result<Diff, VersionControlError> {
        let path = &file.path;
        let earlier = file.original_path.as_deref().unwrap_or(path);
        if file.staged {
            let revisions = [format!("HEAD:./{earlier}"), format!(":./{path}")];
            let [original, modified] = self.versions(revisions)?;
            return Ok(Diff { original, modified });
        }
        let original = match file.status {
            FileStatus::Untracked => None,
            // Im Konflikt gibt es keine eine ausgewählte Fassung.
            FileStatus::Conflicted => self
                .versions([format!("HEAD:./{path}")])?
                .into_iter()
                .next(),
            _ => self.versions([format!(":./{earlier}")])?.into_iter().next(),
        }
        .unwrap_or(FileContent::Missing);
        let modified = project_files::read_file(&self.project.join(path)).map_err(failed)?;
        Ok(Diff { original, modified })
    }

    /// Liest Fassungen von Dateien aus dem Repository. Jede Angabe nennt
    /// Stand und Pfad in der Schreibweise von Git (`HEAD:./pfad`, `:./pfad`
    /// für die Auswahl), der Pfad gilt ab dem Projektordner.
    fn versions<const N: usize>(
        &self,
        revisions: [String; N],
    ) -> Result<[FileContent; N], VersionControlError> {
        let unexpected = || failed("unexpected output of git cat-file");
        // Erst Art und Größe erfragen, damit keine übergroße Fassung geladen wird.
        let checked = self.git(
            &["cat-file", "--batch-check"],
            Some(lines(&revisions)?.as_bytes()),
        )?;
        let checked = String::from_utf8_lossy(&checked);
        let mut contents = Vec::with_capacity(N);
        let mut wanted = Vec::new();
        for line in checked.lines() {
            let fields: Vec<&str> = line.split(' ').collect();
            contents.push(match fields[..] {
                [.., "missing"] => FileContent::Missing,
                [object, "blob", size] => {
                    let size: u64 = size.parse().map_err(|_| unexpected())?;
                    if size > MAX_FILE_SIZE {
                        FileContent::TooLarge { size }
                    } else {
                        // Der Platz wird unten mit dem Inhalt gefüllt.
                        wanted.push((contents.len(), object.to_owned(), size as usize));
                        FileContent::Missing
                    }
                }
                // Kein Dateiinhalt, etwa ein eingebundenes Repository.
                _ => FileContent::Binary,
            });
        }
        let mut contents: [FileContent; N] = contents.try_into().map_err(|_| unexpected())?;

        if !wanted.is_empty() {
            let objects: Vec<String> = wanted.iter().map(|(_, object, _)| object.clone()).collect();
            let output = self.git(&["cat-file", "--batch"], Some(lines(&objects)?.as_bytes()))?;
            let mut rest = &output[..];
            for (index, _, size) in wanted {
                // Je Fassung eine Kopfzeile, der Inhalt und ein Zeilenende.
                let header = rest.iter().position(|&byte| byte == b'\n');
                let start = header.map(|end| end + 1).ok_or_else(unexpected)?;
                let content = rest.get(start..start + size).ok_or_else(unexpected)?;
                contents[index] = FileContent::from_bytes(content.to_vec());
                rest = rest.get(start + size + 1..).unwrap_or_default();
            }
        }
        Ok(contents)
    }

    /// Folgt dem Zustand des Projekts: Nach jeder Änderung im Projektordner
    /// und in Git (also auch nach Commits und Branch-Wechseln im Terminal)
    /// wird er neu gelesen. `watcher` muss der Beobachter desselben
    /// Projektordners sein. Liegt das Git-Verzeichnis außerhalb des
    /// Projektordners (das Projekt ist ein Unterordner des Repositorys oder
    /// ein weiterer Arbeitsordner), meldet der Ereignisstrom von `watcher`
    /// fortan auch dessen Änderungen, und zwar unter `.git/`. Der Aufruf
    /// fragt dafür einmal Git. Das Folgen endet, wenn der Rückgabewert oder
    /// der Beobachter verworfen wird.
    pub fn watch(self, watcher: &ProjectWatcher) -> StateWatch {
        for folder in self.git_folders_outside() {
            // Scheitert das, folgt der Zustand nur den Dateien des Projekts.
            let _ = watcher.include(&folder, ".git");
        }
        let (wake, signals) = mpsc::channel();
        // Der erste Stand wird sofort gelesen.
        let _ = wake.send(());
        let changes = watcher.subscribe(move |_| {
            let _ = wake.send(());
        });
        let shared = Arc::new(Mutex::new(Shared::default()));
        let state = shared.clone();
        // Endet, sobald das Abonnement der Änderungen verworfen ist.
        thread::spawn(move || {
            let mut last_read: Option<Instant> = None;
            while signals.recv().is_ok() {
                if let Some(last_read) = last_read {
                    thread::sleep(MIN_READ_INTERVAL.saturating_sub(last_read.elapsed()));
                }
                // Was bis jetzt gemeldet wurde, deckt dieses Lesen mit ab.
                while signals.try_recv().is_ok() {}
                let read = self.state();
                last_read = Some(Instant::now());
                let mut state = lock(&state);
                if state.last.as_ref() == Some(&read) {
                    continue;
                }
                // Unter der Sperre: So kommt nach dem Ende eines Abonnements
                // kein Aufruf mehr (siehe `StateSubscription`).
                for listener in state.listeners.values() {
                    listener(&read);
                }
                state.last = Some(read);
            }
        });
        StateWatch {
            shared,
            _changes: changes,
        }
    }

    /// Die Ordner, in denen Git den Stand dieses Projekts hält, soweit sie
    /// nicht im Projektordner liegen: das Git-Verzeichnis und, bei einem
    /// weiteren Arbeitsordner, das gemeinsame des Repositorys.
    fn git_folders_outside(&self) -> Vec<PathBuf> {
        // Der Regelfall kommt ohne Git-Aufruf aus.
        if self.project.join(".git").is_dir() {
            return Vec::new();
        }
        let args = [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--git-dir",
        ];
        let Ok(output) = self.git(&args, None) else {
            return Vec::new();
        };
        let mut folders: Vec<PathBuf> = Vec::new();
        for line in String::from_utf8_lossy(&output).lines() {
            let folder = PathBuf::from(line);
            let covered = |known: &PathBuf| folder.starts_with(known);
            if !covered(&self.project) && !folders.iter().any(covered) {
                folders.push(folder);
            }
        }
        folders
    }

    /// Der Pfad des Projektordners innerhalb seines Repositorys, mit `/` am
    /// Ende; leer, wenn der Projektordner das Repository selbst ist.
    fn prefix(&self) -> Result<String, VersionControlError> {
        // Der Regelfall kommt ohne Git-Aufruf aus.
        if self.project.join(".git").exists() {
            return Ok(String::new());
        }
        let output = self.git(&["rev-parse", "--show-prefix"], None)?;
        Ok(String::from_utf8_lossy(&output).trim().to_owned())
    }

    /// Ruft Git im Projektordner auf und liefert seine Ausgabe. Git erhält
    /// keine Möglichkeit nachzufragen: Es hat weder Terminal noch Eingabe, und
    /// wer länger als die Zeitgrenze braucht, wird beendet.
    fn git(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, VersionControlError> {
        self.run(args, input, self.options.timeout)
    }

    /// Wie `git`, mit frei gewählter Zeitgrenze.
    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<Vec<u8>, VersionControlError> {
        /// Kein Konsolenfenster für den Kindprozess.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let mut command = Command::new(&self.options.program);
        command
            .current_dir(&self.project)
            .args(args)
            // Keine Rückfrage nach Zugangsdaten, weder im Terminal noch als Fenster.
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            // Ein leerer Wert schaltet jedes Abfrageprogramm ab, auch ein
            // konfiguriertes (`core.askPass`, `SSH_ASKPASS`). Der
            // Anmeldemanager ist kein solches Programm und liefert die
            // gespeicherte Anmeldung weiterhin.
            .env("GIT_ASKPASS", "")
            // SSH fragt weder nach dem Passwort eines Schlüssels noch nach
            // der Bestätigung eines unbekannten Servers; ein laufender
            // Schlüssel-Agent wird weiter benutzt.
            .env("SSH_ASKPASS_REQUIRE", "never")
            // Ein Zusammenführen öffnet keinen Editor für seine Nachricht.
            .env("GIT_MERGE_AUTOEDIT", "no")
            // Lesende Aufrufe schreiben nichts ins Repository; sonst würde
            // jede Abfrage des Zustands die nächste auslösen.
            .env("GIT_OPTIONAL_LOCKS", "0")
            // Meldungen in einer festen Sprache, damit sie sich einordnen lassen.
            .env("LC_ALL", "en_US.UTF-8")
            .env("LANG", "en_US.UTF-8")
            .envs(self.options.env.iter().map(|(name, value)| (name, value)))
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|e| VersionControlError {
            reason: match e.kind() {
                io::ErrorKind::NotFound => ErrorReason::GitMissing,
                _ => ErrorReason::Failed,
            },
            details: e.to_string(),
        })?;
        let job = Job::containing(&child);

        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            // Scheitert das Schreiben, meldet Git selbst, was fehlt.
            let _ = stdin.write_all(input);
        }
        let stdout = read_in_background(child.stdout.take());
        let stderr = read_in_background(child.stderr.take());
        let deadline = Instant::now() + timeout;
        let Some((status, stdout, stderr)) = finish(&mut child, &stdout, &stderr, deadline) else {
            if let Some(job) = &job {
                job.terminate();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(VersionControlError {
                reason: ErrorReason::TimedOut,
                details: format!(
                    "git {} did not finish within {} s",
                    args.join(" "),
                    timeout.as_secs_f32()
                ),
            });
        };

        if status.success() {
            return Ok(stdout);
        }
        let mut message = String::from_utf8_lossy(&stderr).trim().to_owned();
        // Manches erklärt Git nur in der gewöhnlichen Ausgabe, etwa die
        // Konflikte eines Zusammenführens oder die Meldungen eines Hooks.
        let output = String::from_utf8_lossy(&stdout);
        if !output.trim().is_empty() {
            if !message.is_empty() {
                message.push('\n');
            }
            message.push_str(output.trim());
        }
        Err(VersionControlError {
            reason: if message.contains("not a git repository") {
                ErrorReason::NotARepository
            } else {
                ErrorReason::Failed
            },
            details: if message.is_empty() {
                format!("git {} failed ({status})", args.join(" "))
            } else {
                message
            },
        })
    }
}

/// Zwischen zwei Abfragen des Zustands vergeht mindestens diese Zeit, damit
/// ein Agent, der fortlaufend Dateien schreibt, Git nicht pausenlos beschäftigt.
const MIN_READ_INTERVAL: Duration = Duration::from_millis(300);

type StateListener = Box<dyn Fn(&StateResult) + Send>;

#[derive(Default)]
struct Shared {
    /// Der zuletzt gelesene Zustand; fehlt bis zum ersten Lesen.
    last: Option<StateResult>,
    listeners: HashMap<u64, StateListener>,
    next_id: u64,
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    // Ein Abonnent, der abgestürzt ist, nimmt den übrigen nicht den Zustand.
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Der laufend aktuelle Zustand eines Projekts. Die eine Stelle, an der alle
/// (Versionskontrolle, Statusleiste, Explorer) denselben Zustand abonnieren.
pub struct StateWatch {
    shared: Arc<Mutex<Shared>>,
    /// Das Abonnement am Ereignisstrom der Projektdateien.
    _changes: project_files::Subscription,
}

impl StateWatch {
    /// Abonniert den Zustand. `on_state` erhält sofort den aktuellen
    /// Zustand, sofern er schon gelesen ist, und danach jeden, der sich vom
    /// vorigen unterscheidet. Die Aufrufe kommen der Reihe nach aus einem
    /// Hintergrund-Thread und sollten schnell zurückkehren; aus ihnen heraus
    /// darf weder abonniert noch ein Abonnement verworfen werden. Das Abonnement
    /// endet, sobald der Rückgabewert verworfen wird.
    pub fn subscribe(&self, on_state: impl Fn(&StateResult) + Send + 'static) -> StateSubscription {
        let mut shared = lock(&self.shared);
        if let Some(last) = &shared.last {
            on_state(last);
        }
        let id = shared.next_id;
        shared.next_id += 1;
        shared.listeners.insert(id, Box::new(on_state));
        StateSubscription {
            id,
            shared: Arc::downgrade(&self.shared),
        }
    }
}

/// Ein Abonnement des Zustands; es endet, wenn es verworfen wird. Danach
/// kommt kein Aufruf mehr, und ein laufender ist abgeschlossen.
pub struct StateSubscription {
    id: u64,
    shared: Weak<Mutex<Shared>>,
}

impl Drop for StateSubscription {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.upgrade() {
            lock(&shared).listeners.remove(&self.id);
        }
    }
}

/// Die Eingabe für Git-Befehle, die je Zeile eine Angabe lesen.
fn lines(entries: &[String]) -> Result<String, VersionControlError> {
    if entries.iter().any(|entry| entry.contains('\n')) {
        return Err(failed("path contains a line break"));
    }
    Ok(entries.iter().map(|entry| format!("{entry}\n")).collect())
}
