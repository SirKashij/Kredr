/**
 * Monaco für Kredr: der Editor-Kern mit Syntaxfarben, ohne Sprachdienste.
 *
 * Dieses Modul ist groß und wird deshalb nie direkt eingebunden, sondern nur
 * über `loadMonaco()` aus `monacoLoader.ts` nachgeladen.
 *
 * Eingebunden sind bewusst nur einzelne Bausteine statt `monaco-editor` als
 * Ganzes: Die Sprachdienste für TypeScript, JSON, CSS und HTML
 * (Autovervollständigung, Fehlerprüfung, eigene Worker) sowie Vorschläge,
 * Hover und Ähnliches kommen so gar nicht erst ins Programm.
 */
// Die Symbolschrift von Monaco; als Datei eingebunden, weil das Paket nur Skripte freigibt.
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget";
// Der Diff-Editor für den Tab „Versionskontrolle“.
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution";
import "monaco-editor/editor/common/standaloneStrings";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo";
import "monaco-editor/editor/contrib/dnd/browser/dnd";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/indentation/browser/indentation";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
// Suchen in der Datei (Strg+F).
import "monaco-editor/features/find/register";

// Syntaxfarben. Jede Sprache lädt ihre Regeln erst, wenn eine Datei sie braucht.
import "monaco-editor/languages/definitions/bat/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/csharp/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/dockerfile/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/less/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/powershell/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";

import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { jsonConfiguration, jsonLanguage, tomlConfiguration, tomlLanguage } from "./monacoGrammars";

// Der einzige Worker: allgemeine Hilfsarbeiten des Editors (etwa das Berechnen
// eines Diffs). Monaco startet ihn erst, wenn es ihn braucht.
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// JSON und TOML bringt Monaco nur mit Sprachdienst bzw. gar nicht mit;
// für die Farben genügen eigene Regeln.
monaco.languages.register({
  id: "json",
  extensions: [".json", ".jsonc", ".jsonl", ".code-workspace", ".webmanifest", ".map"],
  filenames: [".prettierrc", ".eslintrc", ".babelrc"],
  aliases: ["JSON", "json"],
});
monaco.languages.setMonarchTokensProvider("json", jsonLanguage);
monaco.languages.setLanguageConfiguration("json", jsonConfiguration);
monaco.languages.register({
  id: "toml",
  extensions: [".toml"],
  filenames: ["Cargo.lock", "uv.lock", "poetry.lock"],
  aliases: ["TOML", "toml"],
});
monaco.languages.setMonarchTokensProvider("toml", tomlLanguage);
monaco.languages.setLanguageConfiguration("toml", tomlConfiguration);

/** Das Farbschema aller Monaco-Ansichten: das dunkle VS-Code-Thema auf dem Hintergrund von Kredr. */
export const THEME = "kredr-dark";

monaco.editor.defineTheme(THEME, {
  base: "vs-dark",
  inherit: true,
  rules: [
    // Wie im VS-Code-Thema „Dark+“.
    { token: "type", foreground: "4ec9b0" },
    { token: "key", foreground: "9cdcfe" },
    { token: "string.escape", foreground: "d7ba7d" },
  ],
  colors: {
    "editor.background": "#1f1f1f",
    "editorGutter.background": "#1f1f1f",
    "editorLineNumber.foreground": "#6e7681",
    "editorLineNumber.activeForeground": "#cccccc",
    "editorWidget.background": "#202020",
    "editorWidget.border": "#313131",
    "input.background": "#313131",
    focusBorder: "#0078d4",
  },
});
monaco.editor.setTheme(THEME);

/**
 * Die Einstellungen jeder Monaco-Ansicht in Kredr (Dateiansicht, später Diff):
 * alles aus, was über Syntaxfarben hinausgeht.
 */
export const baseOptions: monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions = {
  theme: THEME,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderWhitespace: "selection",
  smoothScrolling: false,
  fixedOverflowWidgets: true,
  // Keine Sprachdienste: weder Vorschläge noch Hinweise noch Prüfungen.
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  wordBasedSuggestions: "off",
  snippetSuggestions: "none",
  parameterHints: { enabled: false },
  hover: { enabled: "off" },
  codeLens: false,
  inlayHints: { enabled: "off" },
  lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
  links: false,
  colorDecorators: false,
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
};

export { monaco };
