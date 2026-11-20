import { fileName } from "./filePath";
import type { FilePosition } from "./openFiles";

/** Die Stelle eines Fundes in seiner Zeile, in UTF-16-Einheiten ab dem Zeilenanfang. */
export interface MatchRange {
  start: number;
  end: number;
}

/** Eine Trefferzeile, wie sie das Kern-Modul Suche liefert. */
export interface LineMatches {
  /** Die Zeilennummer, ab 1. */
  line: number;
  /** Der Text der Zeile ohne Einrückung; eine sehr lange Zeile ist gekürzt. */
  text: string;
  /** Wo `text` in der Zeile beginnt. */
  textStart: number;
  matches: MatchRange[];
}

/** Die Treffer einer Datei; `path` ist relativ zum Projektordner und mit `/` getrennt. */
export interface FileMatches {
  path: string;
  lines: LineMatches[];
}

/** Die Trefferliste einer Textsuche. */
export interface SearchResults {
  /** Die Dateien mit Treffern, nach Pfad sortiert. */
  files: FileMatches[];
  /** Die Zahl aller Funde. */
  matchCount: number;
  /** Die Dateien, deren Trefferzeilen zugeklappt sind. */
  collapsed: ReadonlySet<string>;
}

export const emptyResults: SearchResults = { files: [], matchCount: 0, collapsed: new Set() };

/** Eine sichtbare Zeile der Trefferliste: eine Datei oder eine ihrer Trefferzeilen. */
export type Row =
  | {
      kind: "file";
      path: string;
      name: string;
      /** Der Ordner der Datei; leer im Projektordner. */
      folder: string;
      /** Die Zahl der Funde in der Datei. */
      count: number;
      collapsed: boolean;
    }
  | { kind: "line"; path: string; line: LineMatches };

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function matchCountOf(file: FileMatches): number {
  return file.lines.reduce((sum, line) => sum + line.matches.length, 0);
}

/** Nimmt weitere Dateien mit Treffern auf; sie kommen vom Kern in beliebiger Reihenfolge. */
export function addMatches(results: SearchResults, files: FileMatches[]): SearchResults {
  return {
    ...results,
    files: [...results.files, ...files].sort((a, b) => collator.compare(a.path, b.path)),
    matchCount: files.reduce((sum, file) => sum + matchCountOf(file), results.matchCount),
  };
}

/** Klappt die Trefferzeilen einer Datei zu oder wieder auf. */
export function toggleFile(results: SearchResults, path: string): SearchResults {
  const collapsed = new Set(results.collapsed);
  if (!collapsed.delete(path)) collapsed.add(path);
  return { ...results, collapsed };
}

/** Die sichtbaren Zeilen der Trefferliste von oben nach unten. */
export function rowsOf(results: SearchResults): Row[] {
  const rows: Row[] = [];
  for (const file of results.files) {
    const collapsed = results.collapsed.has(file.path);
    const name = fileName(file.path);
    rows.push({
      kind: "file",
      path: file.path,
      name,
      folder: file.path.slice(0, Math.max(0, file.path.length - name.length - 1)),
      count: matchCountOf(file),
      collapsed,
    });
    if (!collapsed)
      for (const line of file.lines) rows.push({ kind: "line", path: file.path, line });
  }
  return rows;
}

/** Zerlegt den Text einer Trefferzeile in Stücke mit und ohne Fund. */
export function textParts(line: LineMatches): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const push = (from: number, to: number, hit: boolean) => {
    if (to > from) parts.push({ text: line.text.slice(from, to), hit });
  };
  let position = 0;
  for (const match of line.matches) {
    // Funde zählen ab dem Zeilenanfang, der Text kann später beginnen und früher enden.
    const start = Math.min(line.text.length, Math.max(position, match.start - line.textStart));
    const end = Math.min(line.text.length, Math.max(start, match.end - line.textStart));
    push(position, start, false);
    push(start, end, true);
    position = end;
  }
  push(position, line.text.length, false);
  return parts;
}

/** Die Stelle des ersten Fundes der Zeile, wie die Dateiansicht sie erwartet (ab 1). */
export function positionOf(line: LineMatches): Required<FilePosition> {
  const { start, end } = line.matches[0];
  return { line: line.line, column: start + 1, endLine: line.line, endColumn: end + 1 };
}

/** Zerlegt die Eingabe für Ordner und Dateimuster: mehrere durch Komma getrennt. */
export function parsePatterns(input: string): string[] {
  return input
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
}
