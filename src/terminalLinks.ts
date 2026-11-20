/** Eine Datei, auf die ein Pfad im Terminal zeigt, wahlweise mit Stelle. */
export interface FileTarget {
  path: string;
  /** Zeile ab 1, wenn hinter dem Pfad eine stand (`datei.ts:12`). */
  line?: number;
  /** Spalte ab 1, wenn hinter der Zeile eine stand (`datei.ts:12:5`). */
  column?: number;
}

/** Eine anklickbare Stelle in einer Zeile des Terminals. */
export interface FoundLink {
  /** Erstes Zeichen der Stelle. */
  start: number;
  /** Das Zeichen hinter der Stelle. */
  end: number;
  /** `file` heißt nur: sieht aus wie ein Pfad. Ob es die Datei gibt, weiß der Kern. */
  kind: "url" | "file";
  /** Die Web-Adresse bzw. der Pfad ohne angehängte Zeile und Spalte. */
  target: string;
  line?: number;
  column?: number;
}

const urlPattern = /https?:\/\/[^\s"'<>`]+/gi;
/** Zeichen, aus denen ein Pfad besteht; Pfade mit Leerzeichen werden nicht erkannt. */
const pathPattern = /(?:[A-Za-z]:(?=[\\/]))?[\p{L}\p{N}_.@~+\-\\/]+/gu;
/** Zeile und Spalte hinter einem Pfad: `:12`, `:12:5`, `(12)` oder `(12,5)`. */
const positionPattern = /^(?::(\d+)(?::(\d+))?(?![\w\\/])|\((\d+)(?:,\s*(\d+))?\))/;
const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Schneidet ab, was hinter einer Web-Adresse zum umgebenden Satz gehört. */
function trimUrl(url: string): string {
  for (;;) {
    const last = url.at(-1)!;
    const unmatchedCloser = last in closers && count(url, last) > count(url, closers[last]);
    if (!".,;:!?".includes(last) && !unmatchedCloser) return url;
    url = url.slice(0, -1);
  }
}

/** Ob der Text ein Pfad sein kann: mit Ordner oder mit Dateiendung. */
function looksLikePath(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return /[\\/]/.test(text) || /[^.]\.[A-Za-z]\w*$/.test(text);
}

/**
 * Findet in einer Zeile des Terminals Web-Adressen und alles, was wie ein
 * Dateipfad aussieht, in der Reihenfolge ihres Auftretens.
 */
export function findLinks(text: string): FoundLink[] {
  const links: FoundLink[] = [];
  let withoutUrls = text;
  for (const match of text.matchAll(urlPattern)) {
    const target = trimUrl(match[0]);
    const start = match.index;
    links.push({ start, end: start + target.length, kind: "url", target });
    // Der Pfad einer Web-Adresse ist kein Dateipfad.
    withoutUrls =
      withoutUrls.slice(0, start) +
      " ".repeat(target.length) +
      withoutUrls.slice(start + target.length);
  }

  for (const match of withoutUrls.matchAll(pathPattern)) {
    // Ein Punkt am Ende beendet den Satz, nicht den Pfad.
    const target = match[0].replace(/\.+$/, "");
    if (!looksLikePath(target)) continue;
    const start = match.index;
    const link: FoundLink = { start, end: start + target.length, kind: "file", target };
    const position = positionPattern.exec(withoutUrls.slice(link.end));
    if (position) {
      link.end += position[0].length;
      link.line = Number(position[1] ?? position[3]);
      const column = position[2] ?? position[4];
      if (column) link.column = Number(column);
    }
    links.push(link);
  }
  return links.sort((a, b) => a.start - b.start);
}
