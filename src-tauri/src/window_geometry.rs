//! Fenstergeometrie: Ort und Größe eines Fensters, wie der
//! Aufteilungsspeicher sie pro Projekt festhält, und die Entscheidungen
//! darüber, was gemerkt wird und wo ein Fenster wieder erscheint. Alles hier
//! rechnet nur; Fenster und Bildschirme liefert der Aufrufer.

use serde::{Deserialize, Serialize};

/// Höhe des Streifens am oberen Fensterrand, an dem sich ein Fenster greifen lässt.
const TITLE_BAR: i64 = 32;
/// So breit muss dieser Streifen auf einem Bildschirm liegen.
const MIN_GRIP: i64 = 100;
/// So weit darf der obere Rand über den Bildschirm hinausragen; Windows legt
/// den unsichtbaren Rahmen angedockter und maximierter Fenster dorthin.
const FRAME: i64 = 16;

/// Ort und Größe eines Fensters in Bildschirmpunkten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometry {
    /// Die linke obere Ecke des Fensters samt Rahmen.
    pub x: i32,
    pub y: i32,
    /// Die Größe der Fläche innerhalb des Rahmens.
    pub width: u32,
    pub height: u32,
    /// Ob das Fenster maximiert ist; Ort und Größe gelten dann für danach.
    pub maximized: bool,
}

/// Die nutzbare Fläche eines Bildschirms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Was sich an einem offenen Fenster gerade ablesen lässt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Observed {
    Normal(WindowGeometry),
    Maximized(WindowGeometry),
    Minimized,
}

impl WindowGeometry {
    /// Was nach einer Beobachtung für das Projekt zu merken ist. Ein
    /// maximiertes Fenster behält Ort und Größe von davor, damit es nach dem
    /// Verkleinern dorthin zurückkehrt; ein minimiertes ändert nichts.
    pub fn remember(
        previous: Option<WindowGeometry>,
        observed: Observed,
    ) -> Option<WindowGeometry> {
        match observed {
            Observed::Normal(geometry) => Some(WindowGeometry {
                maximized: false,
                ..geometry
            }),
            Observed::Maximized(geometry) => Some(WindowGeometry {
                maximized: true,
                ..previous.unwrap_or(geometry)
            }),
            Observed::Minimized => previous,
        }
    }

    /// Wo das Fenster bei den aktuellen Bildschirmen erscheint. Lässt es sich
    /// auf keinem greifen (der Bildschirm von damals fehlt oder ist kleiner),
    /// kommt es mittig auf den ersten und wird höchstens so groß wie dieser.
    pub fn visible_on(self, screens: &[Screen]) -> WindowGeometry {
        let Some(first) = screens.first() else {
            return self;
        };
        if screens.iter().any(|screen| self.reachable_on(screen)) {
            return self;
        }
        let width = self.width.min(first.width);
        let height = self.height.min(first.height);
        WindowGeometry {
            x: first.x + ((first.width - width) / 2) as i32,
            y: first.y + ((first.height - height) / 2) as i32,
            width,
            height,
            maximized: self.maximized,
        }
    }

    /// Ob der obere Rand des Fensters weit genug auf dem Bildschirm liegt, um
    /// es mit der Maus zu greifen.
    fn reachable_on(&self, screen: &Screen) -> bool {
        let (x, y) = (i64::from(self.x), i64::from(self.y));
        let (left, top) = (i64::from(screen.x), i64::from(screen.y));
        let right = left + i64::from(screen.width);
        let bottom = top + i64::from(screen.height);
        let grip = (x + i64::from(self.width)).min(right) - x.max(left);
        grip >= MIN_GRIP.min(i64::from(self.width)) && y >= top - FRAME && y + TITLE_BAR <= bottom
    }
}
