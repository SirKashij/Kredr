//! Öffnen außerhalb von Kredr: Web-Adressen im Standardbrowser und Dateien
//! im Windows-Standardprogramm. Dazu die Prüfung, ob ein Text aus einem
//! Terminal eine vorhandene Datei bezeichnet.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Endungen, deren Dateien Windows beim Öffnen ausführt statt anzeigt,
/// zusätzlich zu denen aus `PATHEXT`.
const RUNNING_EXTENSIONS: &[&str] = &[
    "exe", "com", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msc", "msi", "scr",
    "lnk", "pif", "hta", "cpl", "jar", "py", "pyw", "reg",
];

/// Der volle Pfad der Datei, die `candidate` bezeichnet; relative Angaben
/// gelten ab `base`. `None`, wenn es dort keine Datei gibt.
pub fn resolve_file(base: &Path, candidate: &str) -> Option<PathBuf> {
    if candidate.is_empty() {
        return None;
    }
    let path = std::path::absolute(base.join(candidate)).ok()?;
    path.is_file().then_some(path)
}

/// Ob Windows die Datei beim Öffnen ausführen würde (Programm oder Skript).
pub fn runs_when_opened(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(OsStr::to_str) else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    let path_extensions = std::env::var("PATHEXT").unwrap_or_default();
    RUNNING_EXTENSIONS.contains(&extension.as_str())
        || path_extensions.split(';').any(|known| {
            known
                .trim_start_matches('.')
                .eq_ignore_ascii_case(&extension)
        })
}

/// Öffnet eine Web-Adresse (`http` oder `https`) im Standardbrowser.
pub fn open_url(url: &str) -> io::Result<()> {
    let lower = url.to_ascii_lowercase();
    let is_web = lower.starts_with("http://") || lower.starts_with("https://");
    if !is_web || url.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a web address",
        ));
    }
    shell_open(OsStr::new(url))
}

/// Öffnet die Datei im Windows-Standardprogramm. Ein Klick auf einen Pfad im
/// Terminal soll nichts starten: Programme und Skripte werden deshalb nur im
/// Windows-Explorer markiert.
pub fn open_file(path: &Path) -> io::Result<()> {
    if !path.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "file not found"));
    }
    if runs_when_opened(path) {
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()?;
        return Ok(());
    }
    shell_open(path.as_os_str())
}

/// Übergibt das Ziel an Windows, als wäre es im Explorer doppelt geklickt worden.
fn shell_open(target: &OsStr) -> io::Result<()> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |text: &OsStr| text.encode_wide().chain([0]).collect::<Vec<u16>>();
    let verb = wide(OsStr::new("open"));
    let target = wide(target);
    // SAFETY: Beide Zeichenketten sind nullterminiert und leben bis zum Ende des Aufrufs.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Laut Windows-Dokumentation bedeutet jeder Wert über 32 Erfolg.
    if result as usize > 32 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
