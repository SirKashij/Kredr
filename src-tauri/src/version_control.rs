//! Versionskontrolle: liefert den Zustand eines Projekts (Branch, geänderte
//! Dateien mit Status, ausgewählt oder nicht) und Diffs, indem es das
//! installierte Git aufruft und dessen maschinenlesbare Ausgabe liest.
//!
//! Jeder Git-Aufruf läuft ohne interaktive Abfragen und mit Zeitgrenze. Wer
//! dem Zustand folgen will (Oberfläche, Explorer), abonniert ihn über
//! [`VersionControl::watch`].

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
};

use crate::project_files::{self, FileContent, ProjectWatcher, MAX_FILE_SIZE};

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
    /// Der Push wurde abgelehnt, weil das Gegenstück neuere Commits hat.
    PushRejected,
    /// Das Gegenstück ist nicht erreichbar (kein Netz, falsche Adresse).
    Unreachable,
    /// Das Repository kennt kein Gegenstück, mit dem es abgleichen könnte.
    NoRemote,
    /// Beim Zusammenführen sind Konflikte entstanden; die betroffenen
    /// Dateien stehen als `Conflicted` im Zustand.
    Conflict,
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
    /// Ob die Änderung zum Festschreiben ausgewählt (gestagt) ist.
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
    /// Das Gegenstück des Branches, etwa `origin/main`; fehlt, solange der
    /// Branch noch nie gepusht wurde.
    pub upstream: Option<String>,
    /// Wie viele Commits noch nicht gepusht sind.
    pub ahead: u32,
    /// Wie viele Commits das Gegenstück voraus ist, nach dem Stand des
    /// letzten Fetch.
    pub behind: u32,
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
    /// (auch in `.git`, also nach Commits und Branch-Wechseln im Terminal)
    /// wird er neu gelesen. `watcher` muss der Beobachter desselben
    /// Projektordners sein. Das Folgen endet, wenn der Rückgabewert oder der
    /// Beobachter verworfen wird.
    pub fn watch(self, watcher: &ProjectWatcher) -> StateWatch {
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
    /// Hintergrund-Thread und sollten schnell zurückkehren. Das Abonnement
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

/// Ein Abonnement des Zustands; es endet, wenn es verworfen wird.
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

/// Liest einen Ausgabekanal des Kindprozesses bis zu dessen Ende.
fn read_in_background(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        let _ = sender.send(bytes);
    });
    receiver
}

/// Wartet bis `deadline` auf das Ende des Kindprozesses und seine Ausgaben.
fn finish(
    child: &mut Child,
    stdout: &mpsc::Receiver<Vec<u8>>,
    stderr: &mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
) -> Option<(ExitStatus, Vec<u8>, Vec<u8>)> {
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let stdout = stdout.recv_timeout(remaining()).ok()?;
    let stderr = stderr.recv_timeout(remaining()).ok()?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some((status, stdout, stderr)),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
            _ => return None,
        }
    }
}

/// Fasst einen Git-Aufruf mit allen Prozessen zusammen, die er startet
/// (Hilfsprogramme für Netzwerk und Zugangsdaten), damit sich bei
/// überschrittener Zeitgrenze alle gemeinsam beenden lassen.
struct Job(HANDLE);

impl Job {
    fn containing(child: &Child) -> Option<Job> {
        // SAFETY: Die Zeiger dürfen null sein (keine Sicherheitsangaben, kein Name).
        let job = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        if job.0.is_null() {
            return None;
        }
        // SAFETY: Beide Kennungen sind gültig; `child` lebt über den Aufruf hinaus.
        let assigned = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) };
        (assigned != 0).then_some(job)
    }

    fn terminate(&self) {
        // SAFETY: Die Kennung gehört diesem Wert und ist bis `drop` gültig.
        unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Die Kennung wurde von `CreateJobObjectW` geliefert und noch nicht geschlossen.
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Liest die Ausgabe von `git status --porcelain=v2 --branch -z`. `prefix`
/// ist der Pfad des Projektordners im Repository.
fn parse_status(output: &[u8], prefix: &str) -> RepositoryState {
    let text = String::from_utf8_lossy(output);
    let mut state = RepositoryState {
        branch: None,
        commit: None,
        files: Vec::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
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
            _ => {}
        }
    }
    state.files.append(&mut untracked);
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
    /// Wählt die Änderungen zum Festschreiben aus (stagen).
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

    /// Pusht den aktuellen Branch. Hat er noch kein Gegenstück, wird es
    /// angelegt und fortan verfolgt. Hat das Gegenstück neuere Commits,
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

    /// Holt die neueren Commits des Gegenstücks und führt sie mit dem
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

    /// Fragt den Stand des Gegenstücks ab, ohne den Branch oder die Dateien
    /// zu verändern. Danach nennt der Zustand den aktuellen Rückstand.
    pub fn fetch(&self) -> Result<(), VersionControlError> {
        self.remote()?;
        self.sync(&["fetch"])
    }

    /// Fragt den Stand des Gegenstücks sofort und danach in diesem Abstand
    /// im Hintergrund ab, bis der Rückgabewert verworfen wird. Was dabei
    /// scheitert (kein Netz, keine Anmeldung, kein Gegenstück), bleibt
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

    /// Das Gegenstück, mit dem abgeglichen wird: `origin`, sonst das erste.
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

    /// Ein Aufruf, der mit dem Gegenstück abgleicht; sein Scheitern wird
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

/// Das regelmäßige Abfragen des Gegenstücks; es endet, wenn der Wert
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
