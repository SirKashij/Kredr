import { expect, test } from "vitest";
import { languageFor, translate } from "./i18n";
import de from "./locales/de.json";
import en from "./locales/en.json";

test("Deutsch und Englisch haben dieselben Schlüssel", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
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
