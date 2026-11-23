import { expect, test } from "vitest";
import {
  addMatches,
  emptyResults,
  parsePatterns,
  positionOf,
  rowsOf,
  textParts,
  toggleRow,
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

/** Das Projekt eines Fensters ohne Workspace. */
const P = "C:\\Projekte\\Kredr";
const web = "C:\\Projekte\\Web";
const core = "C:\\Projekte\\Kern";

/** Die sichtbaren Zeilen der Trefferliste als Text; im Workspace mit Projektzeilen. */
function shown(results: SearchResults, workspace?: string[]): string[] {
  return rowsOf(results, workspace ?? [P], workspace !== undefined).map((row) =>
    row.kind === "project"
      ? `${row.project} ${row.count}`
      : row.kind === "file"
        ? `${row.name} [${row.folder}] ${row.count}`
        : `  ${row.line.line}: ${row.line.text}`,
  );
}

/** Der Schlüssel der Datei- oder Projektzeile mit diesem Namen, zum Zuklappen. */
function keyOf(results: SearchResults, name: string, workspace?: string[]): string {
  const rows = rowsOf(results, workspace ?? [P], workspace !== undefined);
  const row = rows.find(
    (row) => (row.kind === "project" ? row.project : row.kind === "file" ? row.name : "") === name,
  );
  return row!.key;
}

test("im Workspace stehen die Treffer unter ihrem Projekt, mit seiner Zahl", () => {
  let results = addMatches(emptyResults, core, [file("lib.rs", line(1, "x x", "x"))]);
  results = addMatches(results, web, [
    file("index.ts", line(2, "x", "x")),
    file("app.ts", line(5, "x", "x")),
  ]);

  expect(shown(results, [web, core])).toEqual([
    `${web} 2`,
    "app.ts [] 1",
    "  5: x",
    "index.ts [] 1",
    "  2: x",
    `${core} 2`,
    "lib.rs [] 2",
    "  1: x x",
  ]);
});

test("gleiche Dateien zweier Projekte klappen getrennt, ein Projekt klappt ganz zu", () => {
  let results = addMatches(emptyResults, web, [file("README.md", line(1, "x", "x"))]);
  results = addMatches(results, core, [file("README.md", line(3, "x", "x"))]);
  const projects = [web, core];

  const withoutCore = toggleRow(results, keyOf(results, core, projects));
  expect(shown(withoutCore, projects)).toEqual([
    `${web} 1`,
    "README.md [] 1",
    "  1: x",
    `${core} 1`,
  ]);

  const fileOfWeb = keyOf(results, "README.md", projects);
  expect(shown(toggleRow(results, fileOfWeb), projects)).toEqual([
    `${web} 1`,
    "README.md [] 1",
    `${core} 1`,
    "README.md [] 1",
    "  3: x",
  ]);
});

test("eine Trefferzeile kennt ihr Projekt", () => {
  const results = addMatches(emptyResults, core, [file("src/lib.rs", line(1, "x", "x"))]);

  const row = rowsOf(results, [web, core], true).find((row) => row.kind === "line");

  expect(row).toMatchObject({ project: core, path: "src/lib.rs" });
});

test("Treffer erscheinen nach Datei gruppiert mit ihren Trefferzeilen", () => {
  const results = addMatches(emptyResults, P, [
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
  let results = addMatches(emptyResults, P, [file("a.txt", line(1, "x x", "x"))]);
  results = addMatches(results, P, [file("b.txt", line(4, "x", "x"), line(5, "x", "x"))]);

  expect(results.matchCount).toBe(4);
  expect(results.files.length).toBe(2);
});

test("später eintreffende Dateien reihen sich nach Pfad ein", () => {
  let results = addMatches(emptyResults, P, [file("src/b.ts", line(1, "x", "x"))]);
  results = addMatches(results, P, [
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
  const results = addMatches(emptyResults, P, [
    file("a.txt", line(1, "x", "x")),
    file("b.txt", line(2, "x", "x")),
  ]);

  const collapsed = toggleRow(results, keyOf(results, "a.txt"));
  expect(shown(collapsed)).toEqual(["a.txt [] 1", "b.txt [] 1", "  2: x"]);
  expect(shown(toggleRow(collapsed, keyOf(results, "a.txt")))).toEqual(shown(results));
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
