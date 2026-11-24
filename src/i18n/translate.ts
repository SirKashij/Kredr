/**
 * Die Texte der Oberfläche in jeder Sprache, ohne React. Reine Module holen
 * Übersetzung und Mehrzahl von hier; `i18n.tsx` gibt sie an Komponenten weiter.
 */

import de from "./locales/de.json";
import en from "./locales/en.json";

export type Language = "de" | "en";
export type MessageKey = keyof typeof de;
export type Translate = (key: MessageKey, values?: Record<string, string>) => string;

const messages: Record<Language, Record<MessageKey, string>> = { de, en };

/** Wählt die erste unterstützte Sprache aus der Vorzugsliste des Systems, sonst Englisch. */
export function languageFor(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const language = tag.toLowerCase().split("-")[0];
    if (language === "de" || language === "en") return language;
  }
  return "en";
}

export function translate(
  language: Language,
  key: MessageKey,
  values: Record<string, string> = {},
): string {
  return messages[language][key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in values ? values[name] : placeholder,
  );
}

/**
 * Der Text zu einer Anzahl: `one` für genau eins, sonst `other`. Beide nennen
 * die Anzahl über den Platzhalter `{count}`.
 */
export function plural(t: Translate, count: number, one: MessageKey, other: MessageKey): string {
  return t(count === 1 ? one : other, { count: String(count) });
}
