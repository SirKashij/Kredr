//! Projektdateien: liest Ordnerinhalte, liest und schreibt Dateien und meldet Änderungen im
//! Projektordner als entprellte, zusammengefasste Ereignisse.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Folder,
    File,
}

/// Ein Eintrag eines Ordners.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Debug)]
pub struct ProjectFilesError(String);

impl fmt::Display for ProjectFilesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProjectFilesError {}

fn error(source: impl fmt::Display) -> ProjectFilesError {
    ProjectFilesError(source.to_string())
}

/// Liest die Einträge genau eines Ordners, ohne Unterordner zu betreten und
/// ohne festgelegte Reihenfolge. Verknüpfungen auf Ordner zählen als Ordner.
pub fn list_folder(folder: &Path) -> Result<Vec<Entry>, ProjectFilesError> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(folder).map_err(error)? {
        let entry = entry.map_err(error)?;
        // Unter Windows kommt die Art mit dem Verzeichniseintrag; nur
        // Verknüpfungen kosten einen weiteren Zugriff.
        let is_folder = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => entry.path().is_dir(),
            Ok(kind) => kind.is_dir(),
            Err(_) => false,
        };
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if is_folder {
                EntryKind::Folder
            } else {
                EntryKind::File
            },
        });
    }
    Ok(entries)
}

/// Größere Dateien lädt die Dateiansicht nicht.
pub const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// Was beim Lesen einer Datei herauskommt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContent {
    /// Der Inhalt als UTF-8-Text, Byte für Byte wie auf der Festplatte
    /// (Zeilenenden und eine Byte-Order-Mark bleiben erhalten).
    Text { text: String },
    /// Kein UTF-8-Text; der Inhalt wird nicht geliefert.
    Binary,
    /// Größer als [`MAX_FILE_SIZE`]; der Inhalt wurde nicht gelesen.
    TooLarge { size: u64 },
    /// Die Datei gibt es nicht (mehr).
    Missing,
}

/// Liest eine Datei für die Dateiansicht. Binäre, übergroße und fehlende
/// Dateien sind kein Fehler, sondern ein eigenes Ergebnis.
pub fn read_file(path: &Path) -> Result<FileContent, ProjectFilesError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(FileContent::Missing),
        Err(e) => return Err(error(e)),
    };
    if metadata.is_dir() {
        return Err(error("is a folder"));
    }
    if metadata.len() > MAX_FILE_SIZE {
        return Ok(FileContent::TooLarge {
            size: metadata.len(),
        });
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        // Zwischen Prüfung und Lesen gelöscht.
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(FileContent::Missing),
        Err(e) => return Err(error(e)),
    };
    // Die Datei kann seit der Prüfung gewachsen sein.
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Ok(FileContent::TooLarge {
            size: bytes.len() as u64,
        });
    }
    if bytes.contains(&0) {
        return Ok(FileContent::Binary);
    }
    Ok(match String::from_utf8(bytes) {
        Ok(text) => FileContent::Text { text },
        Err(_) => FileContent::Binary,
    })
}

/// Schreibt `text` als neuen Inhalt der Datei und legt sie an, wenn sie fehlt.
pub fn write_file(path: &Path, text: &str) -> Result<(), ProjectFilesError> {
    std::fs::write(path, text).map_err(error)
}

/// So lange werden Änderungen gesammelt, bevor sie als ein Ereignis
/// weitergehen. Kurz genug, dass eine neue Datei ohne spürbare Verzögerung
/// erscheint; lang genug, dass ein Agent, der hunderte Dateien schreibt, nur
/// wenige Ereignisse auslöst.
const CHANGE_WINDOW: Duration = Duration::from_millis(150);
/// Mehr einzelne Pfade trägt ein Ereignis nicht; darüber heißt es nur noch
/// „alles neu lesen“.
const MAX_PATHS: usize = 2000;

/// Was sich im Projektordner innerhalb eines Zeitfensters geändert hat.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ProjectChanges {
    /// Angelegte, geänderte, umbenannte (alter und neuer Name) und gelöschte
    /// Dateien und Ordner, je einmal; relativ zum Projektordner und mit `/`
    /// getrennt, etwa `src/ui/App.tsx`.
    pub paths: Vec<String>,
    /// Es ist mehr passiert, als einzeln gemeldet werden kann. `paths` ist
    /// dann leer; wer zuhört, liest seinen Stand vollständig neu.
    pub rescan: bool,
}

type Subscriber = Box<dyn Fn(&ProjectChanges) + Send>;
type Subscribers = Mutex<HashMap<u64, Subscriber>>;

/// Beobachtet einen Projektordner samt Unterordnern. Alle Abonnenten hängen
/// am selben Ereignisstrom. Wird der Beobachter verworfen, endet der Strom.
pub struct ProjectWatcher {
    subscribers: Arc<Subscribers>,
    next_id: AtomicU64,
    /// Hält die Beobachtung des Betriebssystems am Leben.
    _watcher: RecommendedWatcher,
}

impl ProjectWatcher {
    pub fn start(project: &Path) -> Result<ProjectWatcher, ProjectFilesError> {
        let (sender, events) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(sender).map_err(error)?;
        watcher
            .watch(project, RecursiveMode::Recursive)
            .map_err(error)?;

        let subscribers = Arc::new(Subscribers::default());
        let listeners = subscribers.clone();
        let project = project.to_path_buf();
        // Endet von selbst, sobald der Beobachter verworfen ist.
        thread::spawn(move || {
            while let Ok(first) = events.recv() {
                let mut batch = Batch::default();
                batch.add(&project, first);
                let deadline = Instant::now() + CHANGE_WINDOW;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match events.recv_timeout(remaining) {
                        Ok(event) => batch.add(&project, event),
                        Err(_) => break,
                    }
                }
                let Some(changes) = batch.finish() else {
                    continue;
                };
                if let Ok(listeners) = listeners.lock() {
                    for listener in listeners.values() {
                        listener(&changes);
                    }
                }
            }
        });

        Ok(ProjectWatcher {
            subscribers,
            next_id: AtomicU64::new(0),
            _watcher: watcher,
        })
    }

    /// Abonniert den Ereignisstrom. `on_change` wird der Reihe nach aus
    /// einem Hintergrund-Thread aufgerufen, höchstens einmal je Zeitfenster,
    /// und sollte schnell zurückkehren. Das Abonnement endet, sobald der
    /// Rückgabewert verworfen wird; danach kommt kein Aufruf mehr.
    pub fn subscribe(&self, on_change: impl Fn(&ProjectChanges) + Send + 'static) -> Subscription {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.insert(id, Box::new(on_change));
        }
        Subscription {
            id,
            subscribers: Arc::downgrade(&self.subscribers),
        }
    }
}

/// Ein Abonnement des Ereignisstroms; es endet, wenn es verworfen wird.
pub struct Subscription {
    id: u64,
    subscribers: Weak<Subscribers>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(subscribers) = self.subscribers.upgrade() {
            if let Ok(mut subscribers) = subscribers.lock() {
                subscribers.remove(&self.id);
            }
        }
    }
}

/// Die Änderungen eines Zeitfensters, ohne Doppelte.
#[derive(Default)]
struct Batch {
    paths: BTreeSet<String>,
    rescan: bool,
}

impl Batch {
    fn add(&mut self, project: &Path, event: notify::Result<notify::Event>) {
        let Ok(event) = event else {
            // Was bei einem Fehler der Beobachtung verloren ging, ist unbekannt.
            self.rescan = true;
            return;
        };
        if event.need_rescan() {
            self.rescan = true;
        }
        // Bloßes Lesen ändert nichts.
        if matches!(event.kind, EventKind::Access(_)) || self.rescan {
            return;
        }
        for path in &event.paths {
            match path.strip_prefix(project) {
                Ok(relative) if relative.as_os_str().is_empty() => {}
                Ok(relative) => {
                    self.paths
                        .insert(relative.to_string_lossy().replace('\\', "/"));
                }
                Err(_) => self.rescan = true,
            }
        }
        if self.paths.len() > MAX_PATHS {
            self.rescan = true;
        }
    }

    fn finish(self) -> Option<ProjectChanges> {
        if self.rescan {
            return Some(ProjectChanges {
                paths: Vec::new(),
                rescan: true,
            });
        }
        if self.paths.is_empty() {
            return None;
        }
        Some(ProjectChanges {
            paths: self.paths.into_iter().collect(),
            rescan: false,
        })
    }
}

/// Warum eine Dateioperation abgelehnt wurde oder scheiterte. Die Oberfläche
/// macht daraus eine Meldung in der Sprache des Nutzers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "details", rename_all = "camelCase")]
pub enum FileOperationError {
    /// Der Name ist unter Windows nicht erlaubt.
    InvalidName,
    /// Im selben Ordner gibt es bereits einen Eintrag dieses Namens.
    AlreadyExists,
    /// Der Eintrag oder sein Ordner ist inzwischen verschwunden.
    NotFound,
    /// Das Betriebssystem hat abgelehnt; mit dessen Begründung.
    Failed(String),
}

impl fmt::Display for FileOperationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FileOperationError::InvalidName => f.write_str("invalid name"),
            FileOperationError::AlreadyExists => f.write_str("name already exists"),
            FileOperationError::NotFound => f.write_str("not found"),
            FileOperationError::Failed(details) => f.write_str(details),
        }
    }
}

impl std::error::Error for FileOperationError {}

impl From<std::io::Error> for FileOperationError {
    fn from(source: std::io::Error) -> Self {
        match source.kind() {
            std::io::ErrorKind::AlreadyExists => FileOperationError::AlreadyExists,
            std::io::ErrorKind::NotFound => FileOperationError::NotFound,
            _ => FileOperationError::Failed(source.to_string()),
        }
    }
}

/// Namen, die Windows für Geräte reserviert, auch mit Endung (`nul.txt`).
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Ob Windows eine Datei oder einen Ordner dieses Namens zulässt.
fn is_valid_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return false;
    }
    if name
        .chars()
        .any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    !RESERVED_NAMES
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
}

/// Der Pfad für einen neuen Eintrag `name` in `folder`, sofern der Name gültig und frei ist.
fn free_path(folder: &Path, name: &str) -> Result<std::path::PathBuf, FileOperationError> {
    if !is_valid_name(name) {
        return Err(FileOperationError::InvalidName);
    }
    let path = folder.join(name);
    if path.symlink_metadata().is_ok() {
        return Err(FileOperationError::AlreadyExists);
    }
    Ok(path)
}

/// Legt in `folder` eine leere Datei an. Ein vorhandener Eintrag gleichen
/// Namens bleibt unberührt.
pub fn create_file(folder: &Path, name: &str) -> Result<(), FileOperationError> {
    let path = free_path(folder, name)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    Ok(())
}

/// Legt in `folder` einen leeren Ordner an.
pub fn create_folder(folder: &Path, name: &str) -> Result<(), FileOperationError> {
    Ok(std::fs::create_dir(free_path(folder, name)?)?)
}

/// Gibt der Datei oder dem Ordner `path` im selben Ordner den Namen
/// `new_name`. Ein vorhandener Eintrag dieses Namens wird nie überschrieben.
pub fn rename(path: &Path, new_name: &str) -> Result<(), FileOperationError> {
    if !is_valid_name(new_name) {
        return Err(FileOperationError::InvalidName);
    }
    if path.symlink_metadata().is_err() {
        return Err(FileOperationError::NotFound);
    }
    let old_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if old_name == new_name {
        return Ok(());
    }
    let target = path.with_file_name(new_name);
    // Ändert sich nur die Groß- und Kleinschreibung, ist der „vorhandene“
    // Eintrag der umzubenennende selbst.
    let same_entry = old_name.to_lowercase() == new_name.to_lowercase();
    if !same_entry && target.symlink_metadata().is_ok() {
        return Err(FileOperationError::AlreadyExists);
    }
    Ok(std::fs::rename(path, target)?)
}

/// Verschiebt die Datei oder den Ordner samt Inhalt in den Windows-Papierkorb.
/// Zeigt selbst keine Rückfrage; nur wenn Windows den Eintrag nicht in den
/// Papierkorb legen kann und endgültig löschen müsste, fragt Windows nach.
pub fn move_to_trash(path: &Path) -> Result<(), FileOperationError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW,
    };

    if path.symlink_metadata().is_err() {
        return Err(FileOperationError::NotFound);
    }
    let path = std::path::absolute(path)?;
    // Die Shell erwartet eine Liste von Pfaden, die mit zwei Nullzeichen endet.
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO
            | FOF_NOCONFIRMATION
            | FOF_NOERRORUI
            | FOF_SILENT
            | FOF_WANTNUKEWARNING) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `operation` und die Pfadliste leben bis zum Ende des Aufrufs;
    // die Liste ist doppelt nullterminiert.
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(FileOperationError::Failed(format!(
            "SHFileOperationW failed with code {result:#x}"
        )));
    }
    if operation.fAnyOperationsAborted != 0 || path.symlink_metadata().is_ok() {
        return Err(FileOperationError::Failed("operation aborted".to_owned()));
    }
    Ok(())
}
