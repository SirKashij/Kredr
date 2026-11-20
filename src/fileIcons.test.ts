import { expect, test } from "vitest";
import { fileIcon } from "./fileIcons";

test("bekannte Dateitypen tragen ihr eigenes Symbol", () => {
  expect(fileIcon("App.tsx")?.glyph).toBe("TS");
  expect(fileIcon("lib.rs")?.glyph).toBe("RS");
  expect(fileIcon("package.json")?.glyph).toBe("{}");
  expect(fileIcon("build.ps1")?.glyph).toBe(">_");
});

test("verschiedene Typen unterscheiden sich in Zeichen oder Farbe", () => {
  const icons = ["a.ts", "a.js", "a.rs", "a.py", "a.md", "a.json", "a.html", "a.css", "a.png"];
  const seen = new Set(icons.map((name) => JSON.stringify(fileIcon(name))));
  expect(seen.size).toBe(icons.length);
});

test("die Endung zählt ohne Rücksicht auf Groß- und Kleinschreibung", () => {
  expect(fileIcon("README.MD")).toEqual(fileIcon("readme.md"));
});

test("nur die letzte Endung zählt", () => {
  expect(fileIcon("vite.config.ts")).toEqual(fileIcon("a.ts"));
});

test("Dateien von Git sind am Namen erkennbar", () => {
  expect(fileIcon(".gitignore")).not.toBeNull();
  expect(fileIcon(".gitignore")).toEqual(fileIcon(".gitattributes"));
});

test("unbekannte Typen und Dateien ohne Endung haben kein eigenes Symbol", () => {
  expect(fileIcon("daten.xyz")).toBeNull();
  expect(fileIcon("LICENSE")).toBeNull();
});
