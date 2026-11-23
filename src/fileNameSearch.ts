/**
 * Die unscharfe Suche von „Datei per Namen öffnen“: ein reines Modell ohne
 * Oberfläche. Sie läuft bei jedem Tastendruck über die ganze Dateiliste des
 * Projekts und muss deshalb auch bei zehntausenden Dateien in Millisekunden
 * fertig sein.
 */

/** Die Dateiliste des Projekts, für die Suche vorbereitet. */
export interface FileIndex {
  /** Pfade relativ zum Projektordner, mit `/` getrennt. */
  paths: string[];
  /** Dieselben Pfade kleingeschrieben, damit nicht jeder Tastendruck sie neu umwandelt. */
  lower: string[];
  /**
   * Woran die Suche jede Datei nennt und unter den zuletzt geöffneten
   * erkennt; ohne Workspace der Pfad selbst.
   */
  keys: string[];
}

export const emptyIndex: FileIndex = { paths: [], lower: [], keys: [] };

export function indexFiles(paths: string[], keys: string[] = paths): FileIndex {
  return { paths, lower: paths.map((path) => path.toLowerCase()), keys };
}

/** So viele Treffer zeigt die Liste höchstens. */
export const RESULT_LIMIT = 50;

/** Jeder getroffene Buchstabe. */
const MATCH = 1;
/** Der Buchstabe gehört zum Dateinamen, nicht zu einem Ordner. */
const IN_NAME = 2;
/**
 * Der Buchstabe beginnt ein Wort (nach `/`, `-`, `_`, `.`, Leerzeichen oder als
 * Binnenmajuskel) oder folgt unmittelbar auf den vorigen Treffer. Beides zählt
 * gleich und nicht doppelt: So schlägt „set“ in `settings.ts` das verstreute
 * `someText.ts`, und „fs“ findet `fileState.ts` vor `offset.ts`.
 */
const ANCHORED = 8;

const NONE = -1;

/** Arbeitsspeicher der Bewertung, über alle Aufrufe wiederverwendet. */
let previous = new Int32Array(256);
let current = new Int32Array(256);

function isSeparator(code: number): boolean {
  // „/“, „\“, „-“, „_“, „.“, Leerzeichen
  return code === 47 || code === 92 || code === 45 || code === 95 || code === 46 || code === 32;
}

/** Ob an der Stelle `at` ein Wort beginnt. */
function startsWord(path: string, lower: string, at: number): boolean {
  if (at === 0 || isSeparator(path.charCodeAt(at - 1))) return true;
  // Binnenmajuskel: ein Großbuchstabe nach einem Kleinbuchstaben.
  return (
    path.charCodeAt(at) !== lower.charCodeAt(at) &&
    path.charCodeAt(at - 1) === lower.charCodeAt(at - 1)
  );
}

/**
 * Die Güte, mit der `query` (kleingeschrieben) auf den Pfad passt, oder `NONE`,
 * wenn seine Buchstaben nicht in dieser Reihenfolge vorkommen. Gesucht ist die
 * beste aller möglichen Zuordnungen, nicht die erstbeste.
 */
function score(query: string, path: string, lower: string): number {
  const length = lower.length;
  // Schnelle Absage: Die meisten Pfade enthalten die Buchstaben gar nicht.
  let from = 0;
  for (let i = 0; i < query.length; i++) {
    from = lower.indexOf(query[i], from) + 1;
    if (from === 0) return NONE;
  }
  if (length > previous.length) {
    previous = new Int32Array(length * 2);
    current = new Int32Array(length * 2);
  }
  const nameStart = lower.lastIndexOf("/") + 1;

  // `current[j]`: beste Güte, wenn der Buchstabe `i` der Eingabe an der Stelle `j` sitzt.
  const first = query.charCodeAt(0);
  for (let j = 0; j < length; j++) {
    if (lower.charCodeAt(j) !== first) current[j] = NONE;
    else {
      const worth = j >= nameStart ? MATCH + IN_NAME : MATCH;
      current[j] = startsWord(path, lower, j) ? worth + ANCHORED : worth;
    }
  }
  for (let i = 1; i < query.length; i++) {
    [previous, current] = [current, previous];
    const code = query.charCodeAt(i);
    // Der beste Stand des vorigen Buchstabens irgendwo weiter links, mit Lücke.
    let apart = NONE;
    current[0] = NONE;
    for (let j = 1; j < length; j++) {
      const adjacent = previous[j - 1];
      let best = NONE;
      if (lower.charCodeAt(j) === code) {
        if (adjacent !== NONE) best = adjacent + ANCHORED;
        // Eine Lücke lohnt nur, wenn links davon mehr steht als direkt daneben.
        if (apart > adjacent) {
          const gapped = startsWord(path, lower, j) ? apart + ANCHORED : apart;
          if (gapped > best) best = gapped;
        }
        if (best !== NONE) best += j >= nameStart ? MATCH + IN_NAME : MATCH;
      }
      current[j] = best;
      if (adjacent > apart) apart = adjacent;
    }
  }
  let best = NONE;
  for (let j = 0; j < length; j++) if (current[j] > best) best = current[j];
  return best;
}

interface Hit {
  index: number;
  score: number;
  /** Platz unter den zuletzt geöffneten Dateien (0 = jüngste), sonst `NONE`. */
  recency: number;
  length: number;
}

/** Ob `a` in der Trefferliste vor `b` steht. */
function ranksBefore(a: Hit, b: Hit): boolean {
  const aRecent = a.recency !== NONE;
  if (aRecent !== (b.recency !== NONE)) return aRecent;
  if (a.score !== b.score) return a.score > b.score;
  if (aRecent) return a.recency < b.recency;
  if (a.length !== b.length) return a.length < b.length;
  return a.index < b.index;
}

/**
 * Die Trefferliste zu einer Eingabe: die Schlüssel der Pfade, auf die die
 * Eingabe unscharf passt, nach Güte sortiert. Zuletzt geöffnete Dateien (`recent`, die jüngste
 * zuerst) stehen oben. Eine leere Eingabe trifft alle Dateien.
 */
export function searchFiles(
  index: FileIndex,
  query: string,
  recent: readonly string[] = [],
  limit = RESULT_LIMIT,
): string[] {
  const wanted = query.replace(/\s+/g, "").replaceAll("\\", "/").toLowerCase();
  const recency = new Map(recent.map((path, place) => [path, place] as const));
  const { paths, lower, keys } = index;
  /** Die bisher besten Treffer, der beste zuerst; nie mehr als `limit`. */
  const top: Hit[] = [];

  for (let i = 0; i < paths.length; i++) {
    const value = wanted ? score(wanted, paths[i], lower[i]) : 0;
    if (value === NONE) continue;
    const hit: Hit = {
      index: i,
      score: value,
      recency: recency.size > 0 ? (recency.get(keys[i]) ?? NONE) : NONE,
      length: paths[i].length,
    };
    if (top.length === limit && !ranksBefore(hit, top[limit - 1])) continue;
    // Binär einsortieren; die Liste bleibt klein.
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranksBefore(hit, top[middle])) high = middle;
      else low = middle + 1;
    }
    top.splice(low, 0, hit);
    if (top.length > limit) top.pop();
  }
  return top.map((hit) => keys[hit.index]);
}

/** So viele zuletzt geöffnete Dateien merkt sich ein Fenster. */
export const RECENT_LIMIT = 50;

/** Setzt `path` an die Spitze der zuletzt geöffneten Dateien. */
export function recordOpened(recent: readonly string[], path: string, limit = RECENT_LIMIT) {
  return [path, ...recent.filter((other) => other !== path)].slice(0, limit);
}
