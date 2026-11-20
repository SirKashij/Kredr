import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { App } from "./App";
import { I18nProvider, languageFor } from "./i18n/i18n";

// WebView2 meldet hier die Anzeigesprachen von Windows.
const language = languageFor(navigator.languages);
document.documentElement.lang = language;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider language={language}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
