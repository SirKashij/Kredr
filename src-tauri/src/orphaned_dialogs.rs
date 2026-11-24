//! Verwaiste Dialoge: native Dialoge, deren Fenster es nicht mehr gibt.
//!
//! Ein nativer Dialog (Rückfrage, Fehlermeldung, Ordnerwahl) läuft in einem
//! eigenen Thread und gehört dem Windows-Fenster, das ihn öffnete; solange es
//! lebt, sperrt er es. Endet dieses Fenster, schließt Windows den Dialog
//! nicht mit, weil er zu einem anderen Thread gehört; es nimmt ihm nur den
//! Besitzer. Seine Antwort erreicht dann niemanden mehr. Deshalb schließt
//! Kredr nach dem Ende eines Fensters jeden eigenen Dialog ohne lebendes
//! Besitzerfenster, als hätte die Person ihn abgebrochen.
//!
//! Alle Dialoge der Oberfläche haben ein Besitzerfenster (das Dialog-Plugin
//! gibt das aufrufende Fenster mit). Ein Dialog, der bewusst keines hat,
//! würde hier mit abgebrochen.

#[cfg(windows)]
use std::time::Duration;

/// Die Fensterklasse der Dialoge von Windows, auch der Task-Dialoge.
const DIALOG_CLASS: &str = "#32770";

/// Wann nach dem Ende eines Fensters nach verwaisten Dialogen gesucht wird,
/// jeweils als Abstand zur vorigen Suche. Das Ereignis kommt schon während
/// `WM_DESTROY`, wenn das Fenster noch lebt; spätere Suchen sehen es tot.
#[cfg(windows)]
const SEARCHES: [Duration; 4] = [
    Duration::ZERO,
    Duration::from_millis(50),
    Duration::from_millis(200),
    Duration::from_millis(1000),
];

/// Ob ein Windows-Fenster der Klasse `class` ein verwaister Dialog ist.
/// Andere Fenster ohne Besitzer, etwa die Hilfsfenster der Fensterverwaltung,
/// bleiben unberührt.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_orphaned_dialog(class: &str, has_living_owner: bool) -> bool {
    class == DIALOG_CLASS && !has_living_owner
}

/// Schließt nach dem Ende eines Fensters die verwaisten Dialoge dieses
/// Prozesses, ohne zu warten. Ein geschlossener Dialog antwortet wie mit
/// „Abbrechen“.
#[cfg(windows)]
pub fn close_orphaned_dialogs() {
    std::thread::spawn(|| {
        for pause in SEARCHES {
            std::thread::sleep(pause);
            close_orphaned_dialogs_now();
        }
    });
}

/// Außerhalb von Windows schließt das Betriebssystem die Dialoge selbst.
#[cfg(not(windows))]
pub fn close_orphaned_dialogs() {}

/// Schließt die verwaisten Dialoge dieses Prozesses, die es gerade gibt.
#[cfg(windows)]
fn close_orphaned_dialogs_now() {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowThreadProcessId, IsWindow, PostMessageW,
        GW_OWNER, WM_CLOSE,
    };

    unsafe extern "system" fn close_if_orphaned(window: HWND, _: LPARAM) -> i32 {
        let mut process = 0;
        // SAFETY: `window` kommt von EnumWindows, `process` lebt bis zum Ende des Aufrufs.
        unsafe { GetWindowThreadProcessId(window, &mut process) };
        // SAFETY: Abfrage ohne Nebenwirkung.
        if process != unsafe { GetCurrentProcessId() } {
            return 1;
        }
        // Länger als `#32770` muss der Name nicht sein; längere werden
        // abgeschnitten und sind damit ohnehin kein Dialog.
        let mut class = [0u16; 16];
        // SAFETY: Der Puffer fasst `class.len()` Zeichen.
        let length = unsafe { GetClassNameW(window, class.as_mut_ptr(), class.len() as i32) };
        let class = String::from_utf16_lossy(&class[..length.max(0) as usize]);
        // SAFETY: Abfragen ohne Nebenwirkung; ein toter Besitzer ergibt `IsWindow` 0.
        let owner = unsafe { GetWindow(window, GW_OWNER) };
        let has_living_owner = !owner.is_null() && unsafe { IsWindow(owner) } != 0;
        if is_orphaned_dialog(&class, has_living_owner) {
            // SAFETY: Eine Nachricht an ein Fenster dieses Prozesses. Die
            // Task-Dialoge des Plugins erlauben das Abbrechen und
            // beantworten WM_CLOSE wie „Abbrechen“.
            unsafe { PostMessageW(window, WM_CLOSE, 0, 0) };
        }
        1
    }

    // SAFETY: `close_if_orphaned` bleibt gültig, solange EnumWindows läuft.
    unsafe { EnumWindows(Some(close_if_orphaned), 0) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dialog_without_a_living_owner_is_orphaned() {
        assert!(is_orphaned_dialog("#32770", false));
    }

    #[test]
    fn a_dialog_whose_window_lives_stays_open() {
        assert!(!is_orphaned_dialog("#32770", true));
    }

    #[test]
    fn other_windows_without_an_owner_stay_untouched() {
        assert!(!is_orphaned_dialog("Tao Thread Event Target", false));
        assert!(!is_orphaned_dialog("Tauri Window", false));
    }
}
