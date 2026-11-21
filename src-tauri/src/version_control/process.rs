//! Der Kindprozess eines Git-Aufrufs: seine Ausgaben lesen, bis zur
//! Zeitgrenze auf sein Ende warten und ihn samt allem beenden, was er startete.

use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::process::{Child, ExitStatus};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
};

/// Liest einen Ausgabekanal des Kindprozesses bis zu dessen Ende.
pub(super) fn read_in_background(
    pipe: Option<impl Read + Send + 'static>,
) -> mpsc::Receiver<Vec<u8>> {
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
pub(super) fn finish(
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
pub(super) struct Job(HANDLE);

impl Job {
    pub(super) fn containing(child: &Child) -> Option<Job> {
        // SAFETY: Die Zeiger dürfen null sein (keine Sicherheitsangaben, kein Name).
        let job = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        if job.0.is_null() {
            return None;
        }
        // SAFETY: Beide Kennungen sind gültig; `child` lebt über den Aufruf hinaus.
        let assigned = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) };
        (assigned != 0).then_some(job)
    }

    pub(super) fn terminate(&self) {
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
