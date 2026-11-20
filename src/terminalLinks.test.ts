import { expect, test } from "vitest";
import { findLinks } from "./terminalLinks";

/** Die gefundenen Stellen als Ausschnitte der Zeile, mit ihrem Ziel. */
function found(text: string) {
  return findLinks(text).map(({ start, end, ...link }) => ({
    ...link,
    text: text.slice(start, end),
  }));
}

test("eine Web-Adresse wird als Link erkannt", () => {
  expect(found("Siehe https://example.com/docs?id=1#teil für Details")).toEqual([
    {
      kind: "url",
      target: "https://example.com/docs?id=1#teil",
      text: "https://example.com/docs?id=1#teil",
    },
  ]);
});

test("Satzzeichen und Klammern hinter einer Web-Adresse gehören nicht dazu", () => {
  expect(found("(siehe http://localhost:1420/). Danach").map((link) => link.target)).toEqual([
    "http://localhost:1420/",
  ]);
  expect(found("Quelle: https://de.wikipedia.org/wiki/Bash_(Shell).")[0].target).toBe(
    "https://de.wikipedia.org/wiki/Bash_(Shell)",
  );
});

test("ein relativer Dateipfad wird erkannt", () => {
  expect(found("geändert: src/i18n/locales/de.json")).toEqual([
    { kind: "file", target: "src/i18n/locales/de.json", text: "src/i18n/locales/de.json" },
  ]);
  expect(found(String.raw`  .\src-tauri\src\lib.rs`)[0].target).toBe(
    String.raw`.\src-tauri\src\lib.rs`,
  );
});

test("ein absoluter Windows-Pfad wird erkannt", () => {
  expect(found(String.raw`Datei C:\Users\kevin\Kredr\README.md gelesen`)).toEqual([
    {
      kind: "file",
      target: String.raw`C:\Users\kevin\Kredr\README.md`,
      text: String.raw`C:\Users\kevin\Kredr\README.md`,
    },
  ]);
});

test("ein Dateiname ohne Ordner wird erkannt, ein gewöhnliches Wort nicht", () => {
  expect(found("Lies zuerst GLOSSARY.md und dann weiter.").map((link) => link.target)).toEqual([
    "GLOSSARY.md",
  ]);
  expect(found("Fertig. Alles in Ordnung")).toEqual([]);
});

test("Zeile und Spalte hinter einem Pfad gehören zum Link, nicht zum Pfad", () => {
  expect(found("src/App.tsx:42:7 - error TS2322")).toEqual([
    { kind: "file", target: "src/App.tsx", line: 42, column: 7, text: "src/App.tsx:42:7" },
  ]);
  expect(found("at src/main.tsx:3")).toEqual([
    { kind: "file", target: "src/main.tsx", line: 3, text: "src/main.tsx:3" },
  ]);
  expect(found("src/App.tsx(42,7): error")).toEqual([
    { kind: "file", target: "src/App.tsx", line: 42, column: 7, text: "src/App.tsx(42,7)" },
  ]);
});

test("ein Pfad am Satzende endet vor dem Punkt", () => {
  expect(found("Die Regeln stehen in docs/adr/0001-tauri-statt-electron.md.")[0].target).toBe(
    "docs/adr/0001-tauri-statt-electron.md",
  );
});

test("Umlaute im Pfad bleiben erhalten", () => {
  expect(found("docs/Übersicht/größe.md")[0].target).toBe("docs/Übersicht/größe.md");
});

test("der Pfad innerhalb einer Web-Adresse ist kein eigener Link", () => {
  expect(found("https://example.com/src/App.tsx und src/main.tsx")).toEqual([
    {
      kind: "url",
      target: "https://example.com/src/App.tsx",
      text: "https://example.com/src/App.tsx",
    },
    { kind: "file", target: "src/main.tsx", text: "src/main.tsx" },
  ]);
});
