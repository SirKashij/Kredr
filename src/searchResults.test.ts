import { expect, test } from "vitest";
import {
  addMatches,
  emptyResults,
  parsePatterns,
  positionOf,
  rowsOf,
  textParts,
  toggleFile,
  type FileMatches,
  type LineMatches,
  type SearchResults,
} from "./searchResults";

/** Eine Trefferzeile, deren Funde alle Vorkommen von `hit` im Text sind. */
function line(number: number, text: string, hit: string, textStart = 0): LineMatches {
  const matches = [];
  for (let at = text.indexOf(hit); at >= 0; at = text.indexOf(hit, at + hit.length)) {
    matches.push({ start: textStart + at, end: textStart + at + hit.length });
  }
  return { line: number, text, textStart, matches };
}

function file(path: string, ...lines: LineMatches[]): FileMatches {
  return { path, lines };
}

/** Die sichtbaren Zeilen der Trefferliste als Text. */
function shown(results: SearchResults): string[] {
  return rowsOf(results).map((row) =>
    row.kind === "file"
      ? `${row.name} [${row.folder}] ${row.count}`
      : `  ${row.line.line}: ${row.line.text}`,
  );
}

test("Treffer erscheinen nach Datei gruppiert mit ihren Trefferzeilen", () => {
  const results = addMatches(emptyResults, [
    file("src/ui/App.tsx", line(3, "const a = b;", "a"), line(9, "a + a", "a")),
    file("README.md", line(1, "a", "a")),
  ]);

  expect(shown(results)).toEqual([
    "README.md [] 1",
    "  1: a",
    "App.tsx [src/ui] 3",
    "  3: const a = b;",
    "  9: a + a",
  ]);
});

test("die Gesamtzahl zählt Funde und Dateien", () => {
  let results = addMatches(emptyResults, [file("a.txt", line(1, "x x", "x"))]);
  results = addMatches(results, [file("b.txt", line(4, "x", "x"), line(5, "x", "x"))]);

  expect(results.matchCount).toBe(4);
  expect(results.files.length).toBe(2);
});

test("später eintreffende Dateien reihen sich nach Pfad ein", () => {
  let results = addMatches(emptyResults, [file("src/b.ts", line(1, "x", "x"))]);
  results = addMatches(results, [
    file("src/a.ts", line(1, "x", "x")),
    file("Zebra.md", line(1, "x", "x")),
    file("docs/a.md", line(1, "x", "x")),
  ]);

  expect(results.files.map((file) => file.path)).toEqual([
    "docs/a.md",
    "src/a.ts",
    "src/b.ts",
    "Zebra.md",
  ]);
});

test("eine zugeklappte Datei zeigt ihre Trefferzeilen nicht", () => {
  const results = addMatches(emptyResults, [
    file("a.txt", line(1, "x", "x")),
    file("b.txt", line(2, "x", "x")),
  ]);

  const collapsed = toggleFile(results, "a.txt");
  expect(shown(collapsed)).toEqual(["a.txt [] 1", "b.txt [] 1", "  2: x"]);
  expect(shown(toggleFile(collapsed, "a.txt"))).toEqual(shown(results));
});

test("der Fund ist im Text der Trefferzeile hervorgehoben", () => {
  expect(textParts(line(1, "const name = name;", "name"))).toEqual([
    { text: "const ", hit: false },
    { text: "name", hit: true },
    { text: " = ", hit: false },
    { text: "name", hit: true },
    { text: ";", hit: false },
  ]);
});

test("in einer gekürzten Trefferzeile sitzt die Hervorhebung an der richtigen Stelle", () => {
  // Der Text beginnt erst bei Stelle 100 der Zeile.
  expect(textParts(line(1, "vor fund nach", "fund", 100))).toEqual([
    { text: "vor ", hit: false },
    { text: "fund", hit: true },
    { text: " nach", hit: false },
  ]);
});

test("ein Fund jenseits des gezeigten Texts wird nicht hervorgehoben", () => {
  const cut: LineMatches = {
    line: 1,
    text: "abc",
    textStart: 0,
    matches: [
      { start: 1, end: 9 },
      { start: 20, end: 22 },
    ],
  };

  expect(textParts(cut)).toEqual([
    { text: "a", hit: false },
    { text: "bc", hit: true },
  ]);
});

test("ein Klick führt zum ersten Fund der Zeile, gezählt ab 1", () => {
  expect(positionOf(line(7, "name = name", "name", 4))).toEqual({
    line: 7,
    column: 5,
    endLine: 7,
    endColumn: 9,
  });
});

test("Ordner und Dateimuster stehen durch Komma getrennt", () => {
  expect(parsePatterns(" src/ui, *.ts ,,docs ")).toEqual(["src/ui", "*.ts", "docs"]);
  expect(parsePatterns("  ")).toEqual([]);
});
