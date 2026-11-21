import { expect, test } from "vitest";
import { languageFor, translate } from "./i18n";
import de from "./locales/de.json";
import en from "./locales/en.json";
import glossary from "../../GLOSSARY.md?raw";

test("Deutsch und Englisch haben dieselben Schlüssel", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
});

/** Die Wörter, die `GLOSSARY.md` unter „_Vermeiden_“ führt. */
const avoidedTerms = glossary
  .split("\n")
  .filter((line) => line.startsWith("_Vermeiden_:"))
  .flatMap((line) => line.slice("_Vermeiden_:".length).split(","))
  .map((term) => term.trim())
  .filter(Boolean);

/**
 * Ein Muster für einen vermiedenen Begriff, das auch gebeugte Formen
 * trifft („erster Prompt“ auch als „ersten Prompts“). Kurze Wörter wie
 * „KI“ gelten nur genau so, sonst träfe „KI“ auch „Kind“.
 */
function termPattern(term: string): RegExp {
  const words = term.split(/\s+/).map((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (word.length < 5) return escaped;
    const stem = escaped.replace(/(en|er|es|em|e|n|s)$/, "");
    return `${stem}\\p{L}{0,3}`;
  });
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
}

/** Die vermiedenen Begriffe, die in `text` vorkommen. */
function avoidedIn(text: string): string[] {
  return avoidedTerms.filter((term) => termPattern(term).test(text));
}

test("die Prüfung auf vermiedene Begriffe trifft auch gebeugte Formen", () => {
  expect(avoidedIn("Der Tab zeigt den ersten Prompt seit dem Start.")).toEqual(["erster Prompt"]);
  expect(avoidedIn("Jedes Kind kennt den Agenten.")).toEqual([]);
});

test("die deutschen Texte meiden die Begriffe, die das Glossar ausschließt", () => {
  const found = Object.entries(de).flatMap(([key, text]) =>
    avoidedIn(text).map((term) => `${key}: „${term}“`),
  );

  expect(found).toEqual([]);
});

test("jeder Schlüssel wird in der Oberfläche benutzt", () => {
  const sources = Object.entries(
    import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  )
    .filter(([path]) => !path.includes(".test."))
    .map(([, text]) => text)
    .join("\n");

  const unused = Object.keys(de).filter((key) => !sources.includes(`"${key}"`));

  expect(unused).toEqual([]);
});

test("kein Text ist leer", () => {
  for (const [language, messages] of Object.entries({ de, en })) {
    for (const [key, text] of Object.entries(messages)) {
      expect(text.trim(), `${language}: ${key}`).not.toBe("");
    }
  }
});

test("die Sprache folgt der ersten unterstützten Windows-Sprache", () => {
  expect(languageFor(["de-DE", "en-US"])).toBe("de");
  expect(languageFor(["fr-FR", "en-GB", "de"])).toBe("en");
});

test("ohne unterstützte Sprache gilt Englisch", () => {
  expect(languageFor(["fr-FR"])).toBe("en");
  expect(languageFor([])).toBe("en");
});

test("Platzhalter werden ersetzt", () => {
  expect(translate("de", "window.title", { project: "Kredr" })).toBe("Kredr — Kredr");
  expect(translate("en", "terminal.startFailed", { details: "boom" })).toBe(
    "The terminal could not be started: boom",
  );
});
