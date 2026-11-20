import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { I18nProvider } from "./i18n/i18n";
import { SettingsProvider, useSettings } from "./settings";
import { effectiveLanguage } from "./settingsStore";

/** Wendet an, was aus den Einstellungen für das ganze Fenster gilt: Sprache und Schrift. */
function Root() {
  const { settings } = useSettings();
  // WebView2 meldet in `navigator.languages` die Anzeigesprachen von Windows.
  const language = effectiveLanguage(settings, navigator.languages);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Schrift für alles, was Code zeigt (Dateiansicht); Terminals erhalten sie direkt.
  useEffect(() => {
    const { style } = document.documentElement;
    style.setProperty("--mono-font", settings.fontFamily);
    style.setProperty("--mono-size", `${settings.fontSize}px`);
  }, [settings.fontFamily, settings.fontSize]);

  return (
    <I18nProvider language={language}>
      <App />
    </I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsProvider>
      <Root />
    </SettingsProvider>
  </StrictMode>,
);
