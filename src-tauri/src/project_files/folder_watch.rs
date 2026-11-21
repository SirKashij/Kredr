//! Beobachtet einen Ordner samt Unterordnern mit `ReadDirectoryChangesW`.
//!
//! Windows sammelt die Änderungen eines Ordners in einem Zwischenspeicher
//! fester Größe. Wird er nicht schnell genug abgeholt, verwirft Windows den
//! gesamten Inhalt und meldet stattdessen eine Antwort ohne Inhalt. Genau
//! dieser Fall muss beim Empfänger ankommen ([`FolderEvent::Lost`]); wer ihn
//! übergeht, verliert Änderungen, ohne es zu merken.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_NOTIFY_ENUM_DIR, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
    FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION,
    FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
    FILE_NOTIFY_CHANGE_SECURITY, FILE_NOTIFY_CHANGE_SIZE, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// Was der beobachtete Ordner meldet.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum FolderEvent {
    /// Dieser Eintrag (voller Pfad) wurde angelegt, geändert, umbenannt oder gelöscht.
    Changed(PathBuf),
    /// Es gab Änderungen, die nicht mehr einzeln zu erfahren sind.
    Lost,
}

/// So viel hält Windows an noch nicht abgeholten Änderungen vor; mehr
/// erlaubt Windows für Ordner auf Netzlaufwerken nicht.
const BUFFER_SIZE: usize = 64 * 1024;

/// Namen, Inhalt und Eigenschaften; bloßes Lesen zählt nicht als Änderung.
const WATCHED_CHANGES: u32 = FILE_NOTIFY_CHANGE_FILE_NAME
    | FILE_NOTIFY_CHANGE_DIR_NAME
    | FILE_NOTIFY_CHANGE_ATTRIBUTES
    | FILE_NOTIFY_CHANGE_SIZE
    | FILE_NOTIFY_CHANGE_LAST_WRITE
    | FILE_NOTIFY_CHANGE_CREATION
    | FILE_NOTIFY_CHANGE_SECURITY;

/// Ein Windows-Handle, das mit diesem Wert geschlossen wird.
struct Handle(HANDLE);

// SAFETY: Handles auf Ordner und Ereignisobjekte sind an keinen Thread gebunden.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: Das Handle gehört diesem Wert und wird nur hier geschlossen.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Ein Ereignisobjekt, das gesetzt bleibt, bis Windows es zurücksetzt.
fn signal() -> io::Result<Handle> {
    // SAFETY: Aufruf ohne Zeiger auf eigene Daten.
    let handle = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Handle(handle))
}

/// Die laufende Beobachtung eines Ordners; sie endet, wenn dieser Wert verworfen wird.
pub(super) struct FolderWatch {
    stop: Arc<Handle>,
    reader: Option<JoinHandle<()>>,
}

impl FolderWatch {
    /// Beobachtet `folder` samt Unterordnern und meldet nach `events`.
    /// Änderungen nach der Rückkehr gehen nicht unbemerkt verloren: Jede
    /// kommt einzeln an, oder es kommt [`FolderEvent::Lost`].
    pub(super) fn start(folder: &Path, events: Sender<FolderEvent>) -> io::Result<FolderWatch> {
        let name: Vec<u16> = folder.as_os_str().encode_wide().chain([0]).collect();
        // SAFETY: `name` ist nullterminiert und lebt über den Aufruf hinaus.
        let directory = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                ptr::null_mut(),
            )
        };
        if directory == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut reading = Reading {
            folder: folder.to_path_buf(),
            directory: Handle(directory),
            completed: signal()?,
            stop: Arc::new(signal()?),
            // Windows verlangt einen an 32 Bit ausgerichteten Speicher.
            buffer: vec![0u32; BUFFER_SIZE / 4],
            events,
        };
        let stop = reading.stop.clone();
        let (started, first_request) = mpsc::channel();
        let reader = thread::Builder::new()
            .name("project-files-watch".to_owned())
            .spawn(move || {
                // Windows sammelt Änderungen ab dem ersten Leseauftrag.
                let mut pending = OVERLAPPED::default();
                let first = reading.request(&mut pending);
                let watching = first.is_ok();
                let _ = started.send(first);
                if watching {
                    reading.run(&mut pending);
                }
            })?;
        match first_request.recv() {
            Ok(Ok(())) => Ok(FolderWatch {
                stop,
                reader: Some(reader),
            }),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(io::Error::other(e)),
        }
    }
}

impl Drop for FolderWatch {
    fn drop(&mut self) {
        // SAFETY: Das Ereignisobjekt lebt, solange `self.stop` lebt.
        unsafe {
            SetEvent(self.stop.0);
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// Was der lesende Thread braucht.
struct Reading {
    folder: PathBuf,
    directory: Handle,
    /// Gesetzt, sobald der offene Leseauftrag beantwortet ist.
    completed: Handle,
    /// Gesetzt, sobald die Beobachtung enden soll.
    stop: Arc<Handle>,
    buffer: Vec<u32>,
    events: Sender<FolderEvent>,
}

impl Reading {
    /// Bittet Windows um die nächsten Änderungen. Die Antwort landet in
    /// `self.buffer`. Gelingt der Auftrag, müssen `pending` und der Speicher
    /// bleiben, wo sie sind, bis die Antwort abgeholt ist.
    fn request(&mut self, pending: &mut OVERLAPPED) -> io::Result<()> {
        *pending = OVERLAPPED::default();
        pending.hEvent = self.completed.0;
        // SAFETY: `run` gibt `pending` und den Speicher erst auf, wenn der
        // Auftrag beantwortet oder abgebrochen und abgewartet ist.
        let requested = unsafe {
            ReadDirectoryChangesW(
                self.directory.0,
                self.buffer.as_mut_ptr().cast(),
                BUFFER_SIZE as u32,
                1,
                WATCHED_CHANGES,
                ptr::null_mut(),
                pending,
                None,
            )
        };
        if requested == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Bricht den offenen Leseauftrag ab und wartet, bis Windows ihn losgelassen hat.
    fn cancel(&self, pending: &mut OVERLAPPED) {
        let mut length = 0u32;
        // SAFETY: `pending` ist der offene Leseauftrag dieses Ordners.
        unsafe {
            CancelIoEx(self.directory.0, pending);
            GetOverlappedResult(self.directory.0, pending, &mut length, 1);
        }
    }

    /// Holt Antworten ab und stellt neue Leseaufträge, bis die Beobachtung
    /// enden soll, der Ordner nicht mehr lesbar ist oder niemand mehr zuhört.
    /// Beim Aufruf ist `pending` ein offener Leseauftrag.
    fn run(mut self, pending: &mut OVERLAPPED) {
        loop {
            let signals = [self.stop.0, self.completed.0];
            // SAFETY: Beide Handles leben in `self`.
            let woken = unsafe { WaitForMultipleObjects(2, signals.as_ptr(), 0, INFINITE) };
            if woken != WAIT_OBJECT_0 + 1 {
                return self.cancel(pending);
            }
            let mut length = 0u32;
            // SAFETY: `pending` ist der eben beantwortete Leseauftrag.
            let answered =
                unsafe { GetOverlappedResult(self.directory.0, pending, &mut length, 0) } != 0;
            // Windows kann den Überlauf auch als Fehler melden; alles andere
            // heißt, dass der Ordner nicht mehr lesbar ist, etwa weil er gelöscht wurde.
            // SAFETY: Fehlercode des Aufrufs unmittelbar davor.
            let readable = answered || unsafe { GetLastError() } == ERROR_NOTIFY_ENUM_DIR;
            let names = if answered {
                // SAFETY: Windows hat `length` Bytes in den Speicher geschrieben,
                // nie mehr als `BUFFER_SIZE`.
                let answer = unsafe {
                    std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), length as usize)
                };
                changed_names(answer)
            } else {
                None
            };
            // Erst der nächste Auftrag, dann das Weiterreichen: So bleibt die
            // Zeit kurz, in der Windows nur zwischenspeichert.
            let watching = readable && self.request(pending).is_ok();

            let complete = names.is_some();
            let listening = match names {
                Some(names) => names
                    .into_iter()
                    .all(|name| self.send(FolderEvent::Changed(self.folder.join(name)))),
                None => self.send(FolderEvent::Lost),
            };
            if !watching {
                // Was ab jetzt geschieht, erfährt niemand mehr.
                if complete {
                    self.send(FolderEvent::Lost);
                }
                return;
            }
            if !listening {
                return self.cancel(pending);
            }
        }
    }

    /// Reicht ein Ereignis weiter; `false`, wenn niemand mehr zuhört.
    fn send(&self, event: FolderEvent) -> bool {
        self.events.send(event).is_ok()
    }
}

/// Die Namen aus einer Antwort von `ReadDirectoryChangesW` (einer Folge von
/// `FILE_NOTIFY_INFORMATION`), relativ zum beobachteten Ordner. `None`, wenn
/// die Antwort keinen Inhalt hat oder unvollständig ist: Dann hat Windows
/// Änderungen verworfen.
fn changed_names(mut answer: &[u8]) -> Option<Vec<PathBuf>> {
    /// Vor dem Namen stehen: Abstand zum nächsten Eintrag, Art der Änderung, Länge des Namens.
    const NAME_OFFSET: usize = 12;
    let mut names = Vec::new();
    loop {
        let field = |at: usize| {
            let bytes = answer.get(at..at + 4)?.try_into().ok()?;
            Some(u32::from_le_bytes(bytes) as usize)
        };
        let next = field(0)?;
        let name_length = field(8)?;
        let name: Vec<u16> = answer
            .get(NAME_OFFSET..NAME_OFFSET + name_length)?
            .as_chunks::<2>()
            .0
            .iter()
            .map(|unit| u16::from_le_bytes(*unit))
            .collect();
        names.push(PathBuf::from(OsString::from_wide(&name)));
        if next == 0 {
            return Some(names);
        }
        answer = answer.get(next..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Eintrag, wie Windows ihn in die Antwort schreibt.
    fn entry(name: &str, last: bool) -> Vec<u8> {
        let name: Vec<u8> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let length = (12 + name.len()).next_multiple_of(4);
        let next = if last { 0 } else { length as u32 };
        let mut entry = Vec::new();
        entry.extend(next.to_le_bytes());
        entry.extend(1u32.to_le_bytes());
        entry.extend((name.len() as u32).to_le_bytes());
        entry.extend(name);
        entry.resize(length, 0);
        entry
    }

    #[test]
    fn antwort_liefert_die_namen_aller_eintraege() {
        let answer = [entry("src\\ui\\App.tsx", false), entry("näu.txt", true)].concat();

        assert_eq!(
            changed_names(&answer),
            Some(vec![
                PathBuf::from("src\\ui\\App.tsx"),
                PathBuf::from("näu.txt")
            ])
        );
    }

    #[test]
    fn antwort_ohne_inhalt_heisst_aenderungen_sind_verloren() {
        assert_eq!(changed_names(&[]), None);
    }

    #[test]
    fn abgeschnittene_antwort_heisst_aenderungen_sind_verloren() {
        let answer = [entry("eins.txt", false), entry("zwei.txt", true)].concat();

        assert_eq!(changed_names(&answer[..answer.len() - 6]), None);
    }
}
