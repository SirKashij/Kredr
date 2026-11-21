import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { languageFor, type Language, type MessageKey } from "./i18n/i18n";

export type Shell = "powershell" | "gitBash";

/** Jede Shell, die Kredr kennt, mit dem Text der Sprachdatei, der sie benennt. */
export const shellLabels: Record<Shell, MessageKey> = {
  powershell: "terminal.powershell",
  gitBash: "terminal.gitBash",
};

/** Ob der Wert eine Shell benennt, die Kredr kennt (etwa aus einer gespeicherten Aufteilung). */
export function isShell(value: unknown): value is Shell {
  return typeof value === "string" && value in shellLabels;
}

/** Die Einstellungen von Kredr, wie der Kern sie speichert. */
export interface Settings {
  /** `null`: Die Oberfläche folgt der Windows-Sprache. */
  language: Language | null;
  /** Schriftart für Terminals und Dateiansicht, als CSS-Schriftfamilie. */
  fontFamily: string;
  /** Schriftgröße für Terminals und Dateiansicht in Pixeln. */
  fontSize: number;
  /** Die Shell, mit der ein neues Terminal startet. */
  defaultShell: Shell;
  /** Der Befehl, mit dem „Neuer Agent“ Claude Code startet. */
  agentCommand: string;
  /** Ob Kredr sich meldet, wenn ein Agent wartet und das Fenster nicht im Vordergrund ist. */
  notifications: boolean;
  /** Ob der Tab eines Agenten und seine Karte in der Agenten-Ansicht den Auftrag zeigen. */
  showAssignment: boolean;
  /** Ob Agenten beim Öffnen eines Projekts mit ihrem Gespräch zurückkommen. */
  resumeAgents: boolean;
}

/** Gilt nur, bis die Einstellungen aus dem Kern geladen sind. */
export const defaultSettings: Settings = {
  language: null,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  defaultShell: "powershell",
  agentCommand: "claude",
  notifications: true,
  showAssignment: true,
  resumeAgents: true,
};

export const fontSizeRange = { min: 6, max: 32 };

/** Die Sprache der Oberfläche: die gewählte, sonst die erste unterstützte Windows-Sprache. */
export function effectiveLanguage(settings: Settings, preferred: readonly string[]): Language {
  return settings.language ?? languageFor(preferred);
}

/** Liest eine eingegebene Schriftgröße; `null`, solange die Eingabe keine zulässige ist. */
export function parseFontSize(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const size = Number(text);
  return size >= fontSizeRange.min && size <= fontSizeRange.max ? size : null;
}

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

/** Speichert die Einstellungen im Kern; zurück kommt, was nun gilt. */
export function saveSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("settings_set", { value: settings });
}

/** Die Shells, die auf diesem Rechner zur Wahl stehen. */
export function availableShells(): Promise<Shell[]> {
  return invoke<Shell[]>("available_shells");
}

/**
 * Ruft `listener` nach jeder Änderung der Einstellungen auf, gleich aus
 * welchem Fenster sie kam. Die Rückgabe beendet das Zuhören.
 */
export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const listening = listen<Settings>("settings-changed", (event) => listener(event.payload));
  return () => {
    listening.then((stop) => stop());
  };
}

/**
 * Reiht die Änderungen eines Fensters auf: Jede baut auf dem Stand auf, den
 * der Kern zuletzt bestätigt hat, damit zwei schnelle Änderungen an
 * verschiedenen Einstellungen einander nicht überschreiben.
 */
export class SettingsChanges {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private latest: Settings,
    private readonly save: (settings: Settings) => Promise<Settings> = saveSettings,
  ) {}

  /** Merkt sich den Stand, den der Kern gemeldet hat. */
  received(settings: Settings) {
    this.latest = settings;
  }

  /** Ändert einzelne Einstellungen. Scheitert das Speichern, bleibt alles beim Alten. */
  change(patch: Partial<Settings>): Promise<void> {
    this.pending = this.pending.then(async () => {
      try {
        this.latest = await this.save({ ...this.latest, ...patch });
      } catch {
        // Der Kern hat nichts geändert; die Oberfläche zeigt weiter den alten Stand.
      }
    });
    return this.pending;
  }
}
