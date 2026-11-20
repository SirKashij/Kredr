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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Shell {
    #[default]
    Powershell,
    GitBash,
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
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            language: None,
            font_family: "\"Cascadia Mono\", \"Cascadia Code\", Consolas, monospace".into(),
            font_size: 13,
            default_shell: Shell::default(),
            agent_command: crate::agent::DEFAULT_START_COMMAND.into(),
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

    /// Schreibt erst daneben und benennt dann um, damit ein Absturz beim
    /// Schreiben keine halbe Datei hinterlässt.
    fn save(&self, settings: &Settings) -> io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let content = serde_json::to_string_pretty(&SettingsFile {
            version: VERSION,
            settings,
        })?;
        let draft = self.file.with_extension("json.tmp");
        std::fs::write(&draft, content)?;
        std::fs::rename(&draft, &self.file)
    }
}

/// Die Shells, die auf diesem Rechner zur Wahl stehen. Git Bash wird nur
/// angeboten, wenn es gefunden wird.
pub fn available_shells() -> Vec<Shell> {
    let mut shells = vec![Shell::Powershell];
    if git_bash_installed() {
        shells.push(Shell::GitBash);
    }
    shells
}

/// Sucht Git Bash an den üblichen Installationsorten von Git für Windows und
/// neben einem `git.exe` im Suchpfad.
fn git_bash_installed() -> bool {
    let env_dir = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let installs = [
        env_dir("ProgramFiles").map(|dir| dir.join("Git")),
        env_dir("ProgramFiles(x86)").map(|dir| dir.join("Git")),
        env_dir("LocalAppData").map(|dir| dir.join("Programs").join("Git")),
    ];
    // `git.exe` liegt in `<Git>\cmd`.
    let from_path = std::env::var_os("PATH").into_iter().flat_map(|path| {
        std::env::split_paths(&path)
            .filter(|dir| dir.join("git.exe").is_file())
            .filter_map(|dir| dir.parent().map(Path::to_path_buf))
            .collect::<Vec<_>>()
    });
    installs
        .into_iter()
        .flatten()
        .chain(from_path)
        .any(|git| git.join("bin").join("bash.exe").is_file())
}
