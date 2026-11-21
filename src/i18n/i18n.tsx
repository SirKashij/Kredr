import { createContext, useContext, type ReactNode } from "react";
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

const I18nContext = createContext<Translate>((key, values) => translate("en", key, values));
const LanguageContext = createContext<Language>("en");

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const t: Translate = (key, values) => translate(language, key, values);
  return (
    <LanguageContext.Provider value={language}>
      <I18nContext.Provider value={t}>{children}</I18nContext.Provider>
    </LanguageContext.Provider>
  );
}

/** Die Sprache des Fensters, etwa für Datumsangaben. */
export function useLanguage(): Language {
  return useContext(LanguageContext);
}

/** Liefert die Übersetzungsfunktion für die Sprache des Fensters. */
export function useT(): Translate {
  return useContext(I18nContext);
}
