import { createContext, useContext, type ReactNode } from "react";
import { translate, type Language, type Translate } from "./translate";

export {
  languageFor,
  plural,
  translate,
  type Language,
  type MessageKey,
  type Translate,
} from "./translate";

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
