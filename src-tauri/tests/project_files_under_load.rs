//! Der Ereignisstrom der Projektdateien, wenn Kredr mit dem Abholen der
//! Änderungen nicht nachkommt. Ein eigenes Testprogramm, weil der Test alle
//! übrigen Threads des Prozesses anhält.

use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use kredr_lib::project_files::{ProjectChanges, ProjectWatcher};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, GetCurrentThreadId, OpenThread, ResumeThread, SuspendThread,
    THREAD_SUSPEND_RESUME,
};

const TIMEOUT: Duration = Duration::from_secs(30);
/// Ein Mehrfaches dessen, was Windows für einen Beobachter zwischenspeichert.
const FILES: usize = 3000;

/// Führt `work` aus, während alle anderen Threads des Prozesses stillstehen.
/// `work` darf auf nichts warten, was ein anderer Thread hält.
fn while_all_other_threads_stand_still(work: impl FnOnce()) {
    let mut suspended = Vec::new();
    // SAFETY: Die Aufrufe bekommen nur Handles, die hier geöffnet und wieder
    // geschlossen werden, und einen Eintrag passender Größe.
    unsafe {
        let threads = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        assert_ne!(threads, INVALID_HANDLE_VALUE);
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = Thread32First(threads, &mut entry) != 0;
        while found {
            if entry.th32OwnerProcessID == GetCurrentProcessId()
                && entry.th32ThreadID != GetCurrentThreadId()
            {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() && SuspendThread(thread) != u32::MAX {
                    suspended.push(thread);
                }
            }
            found = Thread32Next(threads, &mut entry) != 0;
        }
        CloseHandle(threads);
    }
    assert!(!suspended.is_empty());

    work();

    for thread in suspended {
        // SAFETY: `thread` wurde oben geöffnet und angehalten.
        unsafe {
            ResumeThread(thread);
            CloseHandle(thread);
        }
    }
}

#[test]
fn was_windows_nicht_mehr_einzeln_meldet_verlangt_ausdruecklich_neu_lesen() {
    let project = tempfile::Builder::new()
        .prefix("kredr-test-")
        .tempdir()
        .expect("Testordner sollte anlegbar sein");
    let files: Vec<PathBuf> = (0..FILES)
        .map(|file| project.path().join(format!("datei-{file}.txt")))
        .collect();
    let watcher =
        ProjectWatcher::start(project.path()).expect("Projektordner sollte beobachtbar sein");
    let (sender, events) = channel::<ProjectChanges>();
    let _subscription = watcher.subscribe(move |changes| {
        let _ = sender.send(changes.clone());
    });

    // Solange geschrieben wird, holt niemand die Änderungen ab, wie auf einem
    // ausgelasteten Rechner: Der Zwischenspeicher von Windows läuft über, und
    // Windows verwirft, was darin stand.
    while_all_other_threads_stand_still(|| {
        for file in &files {
            fs::write(file, "inhalt").unwrap();
        }
    });

    let mut reported = 0;
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let Ok(changes) = events.recv_timeout(remaining) else {
            panic!(
                "Der Ereignisstrom hat nur {reported} von {FILES} Dateien gemeldet \
                 und nicht verlangt, alles neu zu lesen"
            );
        };
        if changes.rescan {
            break;
        }
        reported += changes.paths.len();
    }
}
