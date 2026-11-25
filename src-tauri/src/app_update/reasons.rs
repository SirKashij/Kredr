//! Die Anlässe der Rückfrage vor der Aktualisierung: was beim Beenden aller
//! Fenster verloren ginge oder abbräche, gezählt. Den Text dazu schreibt das
//! fragende Fenster in seiner Sprache (`updateQuestion`).

use serde::{Deserialize, Serialize};

/// Die Anlässe eines Fensters oder aller Fenster zusammen. Was ein Fenster
/// nicht nennt, zählt als keiner.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateReasons {
    /// Dateien mit ungespeicherten Änderungen.
    pub unsaved_files: u32,
    /// Terminals mit einem laufenden Prozess, ohne Agenten, die fortgesetzt werden.
    pub running_processes: u32,
    /// Agenten, die arbeiten und deren Gespräch danach fortgesetzt wird.
    pub working_agents: u32,
    /// Agenten „im Hintergrund“, deren Gespräch danach fortgesetzt wird.
    pub background_agents: u32,
    /// Fenster, die ihre Anlässe nicht nennen konnten. Sie könnten
    /// Ungespeichertes haben, deshalb fragt Kredr lieber nach.
    pub silent_windows: u32,
}

impl UpdateReasons {
    /// Ein Fenster, das nicht geantwortet hat.
    pub const SILENT_WINDOW: Self = Self {
        unsaved_files: 0,
        running_processes: 0,
        working_agents: 0,
        background_agents: 0,
        silent_windows: 1,
    };

    /// Die Anlässe mehrerer Fenster zusammengezählt.
    pub fn sum<'a>(windows: impl IntoIterator<Item = &'a UpdateReasons>) -> Self {
        windows.into_iter().fold(Self::default(), |sum, window| {
            let mut kinds = sum.kinds();
            for (kind, more) in kinds.iter_mut().zip(window.kinds()) {
                *kind = kind.saturating_add(more);
            }
            Self::from_kinds(kinds)
        })
    }

    /// Ob es überhaupt einen Anlass gibt.
    pub fn any(&self) -> bool {
        self.kinds().iter().any(|&count| count > 0)
    }

    /// Ob es einen Anlass gibt, den `before` nicht hatte: eine Art mit mehr
    /// Fällen als zuvor. Weniger Fälle sind kein neuer Anlass.
    pub fn has_new_since(&self, before: &UpdateReasons) -> bool {
        self.kinds()
            .iter()
            .zip(before.kinds())
            .any(|(&now, then)| now > then)
    }

    fn kinds(&self) -> [u32; 5] {
        [
            self.unsaved_files,
            self.running_processes,
            self.working_agents,
            self.background_agents,
            self.silent_windows,
        ]
    }

    fn from_kinds(
        [unsaved_files, running_processes, working_agents, background_agents, silent_windows]: [u32;
            5],
    ) -> Self {
        Self {
            unsaved_files,
            running_processes,
            working_agents,
            background_agents,
            silent_windows,
        }
    }
}
