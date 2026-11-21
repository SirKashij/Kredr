//! Einstellungen: speichert und lädt die Einstellungen von Kredr und meldet
//! jede Änderung. Die Datei liegt im Benutzerdatenverzeichnis von Kredr, nie
//! im Projektordner. Eine fehlende, beschädigte oder veraltete Datei führt
//! zu Standardwerten, nie zu einem Fehler.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// Welche Shells es gibt, weiß der Terminal-Dienst.
pub use crate::terminal::Shell;

const FILE_NAME: &str = "settings.json";
/// Version des gespeicherten Formats.
const VERSION: u32 = 1;

const MIN_FONT_SIZE: u16 = 6;
const MAX_FONT_SIZE: u16 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    De,
    En,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// `None`: Die Oberfläche folgt der Windows-Sprache.
    pub language: Option<Language>,
    /// Schriftart für Terminals und Dateiansicht, als CSS-Schriftfamilie.
    pub font_family: String,
    /// Schriftgröße für Terminals und Dateiansicht in Pixeln.
    pub font_size: u16,
    /// Die Shell, mit der ein neues Terminal startet.
    pub default_shell: Shell,
    /// Der Befehl, mit dem „Neuer Agent“ Claude Code startet.
    pub agent_command: String,
    /// Ob Kredr eine Windows-Benachrichtigung zeigt, wenn ein Agent auf
    /// Eingabe wartet und sein Fenster nicht im Vordergrund ist. Das
    /// Taskleisten-Symbol meldet sich unabhängig davon.
    pub notifications: bool,
    /// Ob der Tab eines Agenten und seine Karte in der Agenten-Ansicht den
    /// Auftrag zeigen.
    pub show_assignment: bool,
    /// Ob Agenten beim Öffnen eines Projekts mit ihrem Gespräch
    /// zurückkommen. Aus: Ihre Tabs kommen als gewöhnliche Terminals zurück.
    pub resume_agents: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            language: None,
            font_family: "\"Cascadia Mono\", \"Cascadia Code\", Consolas, monospace".into(),
            font_size: 13,
            default_shell: Shell::default(),
            agent_command: crate::agent::DEFAULT_START_COMMAND.into(),
            notifications: true,
            show_assignment: true,
            resume_agents: true,
        }
    }
}

impl Settings {
    /// Liest jede Einstellung einzeln: Was fehlt oder unbrauchbar ist, erhält
    /// seinen Standardwert, ohne dass die übrigen Einstellungen verloren gehen.
    fn from_file(content: &str) -> Settings {
        let Ok(file) = serde_json::from_str::<Value>(content) else {
            return Settings::default();
        };
        fn field<T: DeserializeOwned>(file: &Value, name: &str) -> Option<T> {
            T::deserialize(file.get(name)?).ok()
        }
        let defaults = Settings::default();
        Settings {
            language: field(&file, "language").unwrap_or(defaults.language),
            font_family: field(&file, "fontFamily").unwrap_or(defaults.font_family),
            font_size: field(&file, "fontSize").unwrap_or(defaults.font_size),
            default_shell: field(&file, "defaultShell").unwrap_or(defaults.default_shell),
            agent_command: field(&file, "agentCommand").unwrap_or(defaults.agent_command),
            notifications: field(&file, "notifications").unwrap_or(defaults.notifications),
            show_assignment: field(&file, "showAssignment").unwrap_or(defaults.show_assignment),
            resume_agents: field(&file, "resumeAgents").unwrap_or(defaults.resume_agents),
        }
        .corrected()
    }

    /// Ersetzt unbrauchbare Werte: leere Texte durch den Standard, die
    /// Schriftgröße durch die nächste erlaubte.
    fn corrected(self) -> Settings {
        let defaults = Settings::default();
        let text = |value: String, default: String| match value.trim() {
            "" => default,
            trimmed => trimmed.to_owned(),
        };
        Settings {
            font_family: text(self.font_family, defaults.font_family),
            font_size: self.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE),
            agent_command: text(self.agent_command, defaults.agent_command),
            ..self
        }
    }
}

#[derive(Serialize)]
struct SettingsFile<'a> {
    version: u32,
    #[serde(flatten)]
    settings: &'a Settings,
}

/// Die Einstellungen von Kredr. Es gibt sie einmal im Prozess; alle Fenster
/// teilen sie sich.
pub struct SettingsStore {
    file: PathBuf,
    current: Mutex<Settings>,
    on_change: Box<dyn Fn(&Settings) + Send + Sync>,
}

impl SettingsStore {
    /// Lädt die Einstellungen aus `dir`, dem Benutzerdatenverzeichnis von
    /// Kredr. `on_change` wird nach jeder Änderung mit den neuen
    /// Einstellungen aufgerufen, in der Reihenfolge der Änderungen.
    pub fn open(
        dir: impl AsRef<Path>,
        on_change: impl Fn(&Settings) + Send + Sync + 'static,
    ) -> SettingsStore {
        let file = dir.as_ref().join(FILE_NAME);
        let current = std::fs::read_to_string(&file)
            .map(|content| Settings::from_file(&content))
            .unwrap_or_default();
        SettingsStore {
            file,
            current: Mutex::new(current),
            on_change: Box::new(on_change),
        }
    }

    /// Die aktuellen Einstellungen.
    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Speichert neue Einstellungen und meldet die Änderung. Unbrauchbare
    /// Werte werden berichtigt; zurück kommt, was nun gilt.
    pub fn set(&self, settings: Settings) -> io::Result<Settings> {
        let settings = settings.corrected();
        let mut current = self.lock();
        if *current == settings {
            return Ok(settings);
        }
        self.save(&settings)?;
        *current = settings.clone();
        (self.on_change)(&settings);
        Ok(settings)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        // Die Einstellungen sind auch nach einem Absturz mitten in einer
        // Änderung ein gültiger Wert.
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, settings: &Settings) -> io::Result<()> {
        let content = serde_json::to_string_pretty(&SettingsFile {
            version: VERSION,
            settings,
        })?;
        crate::paths::write_whole(&self.file, content)
    }
}
