import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT, type Language, type MessageKey } from "./i18n/i18n";
import { useSettings } from "./settings";
import {
  availableShells,
  effectiveLanguage,
  fontSizeRange,
  parseFontSize,
  shellLabels,
  type Shell,
} from "./settingsStore";

const languageLabels: Record<Language, MessageKey> = {
  de: "settings.language.de",
  en: "settings.language.en",
};

/**
 * Die Einstellungsseite. Sie liegt über dem Hauptbereich; die Terminals
 * darunter laufen weiter. Jede Änderung wirkt sofort, einen Knopf zum
 * Speichern gibt es nicht.
 *
 * Eine weitere Einstellung ist eine weitere `SettingRow`.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { settings, change } = useSettings();
  const page = useRef<HTMLElement>(null);
  const [shells, setShells] = useState<Shell[]>(["powershell"]);

  useEffect(() => {
    page.current!.focus();
    availableShells()
      .then(setShells)
      .catch(() => {});
  }, []);

  // Eine gewählte Shell bleibt sichtbar, auch wenn sie nicht mehr gefunden wird.
  const offeredShells = shells.includes(settings.defaultShell)
    ? shells
    : [...shells, settings.defaultShell];

  return (
    <section
      className="settings"
      ref={page}
      tabIndex={-1}
      aria-label={t("activity.settings")}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className="settings-head">
        <h1>{t("activity.settings")}</h1>
        <button title={t("settings.closeTooltip")} aria-label={t("tab.close")} onClick={onClose}>
          <svg className="icon" viewBox="0 0 16 16">
            <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </header>
      <div className="settings-body">
        <SettingRow label={t("settings.language")} hint={t("settings.language.hint")}>
          <select
            value={effectiveLanguage(settings, navigator.languages)}
            onChange={(event) => change({ language: event.target.value as Language })}
          >
            {(Object.keys(languageLabels) as Language[]).map((language) => (
              <option key={language} value={language}>
                {t(languageLabels[language])}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.fontFamily")} hint={t("settings.fontFamily.hint")}>
          <DraftInput
            value={settings.fontFamily}
            parse={(text) => text}
            onCommit={(fontFamily) => change({ fontFamily })}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.fontSize")}
          hint={t("settings.fontSize.hint", {
            min: String(fontSizeRange.min),
            max: String(fontSizeRange.max),
          })}
        >
          <DraftInput
            type="number"
            min={fontSizeRange.min}
            max={fontSizeRange.max}
            value={String(settings.fontSize)}
            parse={parseFontSize}
            onCommit={(fontSize) => change({ fontSize })}
          />
        </SettingRow>
        <SettingRow label={t("settings.defaultShell")} hint={t("settings.defaultShell.hint")}>
          <select
            value={settings.defaultShell}
            onChange={(event) => change({ defaultShell: event.target.value as Shell })}
          >
            {offeredShells.map((shell) => (
              <option key={shell} value={shell}>
                {t(shellLabels[shell])}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.agentCommand")} hint={t("settings.agentCommand.hint")}>
          <DraftInput
            value={settings.agentCommand}
            parse={(text) => text}
            onCommit={(agentCommand) => change({ agentCommand })}
          />
        </SettingRow>
        <SettingRow label={t("settings.notifications")} hint={t("settings.notifications.hint")}>
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={(event) => change({ notifications: event.target.checked })}
          />
        </SettingRow>
        <SettingRow label={t("settings.showAssignment")} hint={t("settings.showAssignment.hint")}>
          <input
            type="checkbox"
            checked={settings.showAssignment}
            onChange={(event) => change({ showAssignment: event.target.checked })}
          />
        </SettingRow>
        <SettingRow label={t("settings.resumeAgents")} hint={t("settings.resumeAgents.hint")}>
          <input
            type="checkbox"
            checked={settings.resumeAgents}
            onChange={(event) => change({ resumeAgents: event.target.checked })}
          />
        </SettingRow>
      </div>
    </section>
  );
}

/** Eine Einstellung: Name, Erklärung und ihr Bedienelement. */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <label className="setting">
      <span className="setting-label">{label}</span>
      <span className="setting-hint">{hint}</span>
      {children}
    </label>
  );
}

/**
 * Ein Eingabefeld, das beim Tippen sofort speichert, sobald die Eingabe
 * zulässig ist (`parse` liefert nicht `null`). Solange das Feld den Fokus
 * hat, zeigt es die Eingabe und nicht den gespeicherten Wert: Der Kern
 * berichtigt unfertige Eingaben, und das würde beim Tippen stören.
 */
function DraftInput<T>({
  value,
  parse,
  onCommit,
  ...input
}: {
  value: string;
  parse: (text: string) => T | null;
  onCommit: (value: T) => void;
  type?: "number";
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      {...input}
      spellCheck={false}
      value={draft ?? value}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = parse(event.target.value);
        if (parsed !== null) onCommit(parsed);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
