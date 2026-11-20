import { Channel, invoke } from "@tauri-apps/api/core";
import type { FileMatches } from "./searchResults";

/** Wonach und wo gesucht wird; entspricht `TextQuery` im Kern-Modul Suche. */
export interface TextQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Ordner und Dateimuster, auf die sich die Suche beschränkt; leer heißt überall. */
  include: string[];
  /** Ordner und Dateimuster, die nicht durchsucht werden. */
  exclude: string[];
}

/** Wie eine Suche geendet hat. */
export interface SearchOutcome {
  cancelled: boolean;
  /** Die Suche endete an der Obergrenze der Funde; es gibt vermutlich mehr. */
  limitReached: boolean;
}

/** Warum der Kern eine Suche abgelehnt hat; entspricht `SearchError` im Modul Suche. */
export type SearchError = { kind: "invalidPattern" | "invalidGlob"; details: string };

/** Eine laufende Textsuche. */
export interface TextSearch {
  /** Erfüllt sich, wenn die Suche fertig, abgebrochen oder an der Obergrenze ist. */
  done: Promise<SearchOutcome>;
  /** Bricht die Suche ab; danach kommen keine Treffer mehr an. */
  cancel: () => void;
}

/** Der Kern zählt die Suchen eines Fensters aufsteigend ab 1. */
let lastId = 0;

/**
 * Durchsucht die Dateien des Projekts. `onMatches` erhält die Dateien mit
 * Treffern bündelweise und in beliebiger Reihenfolge, solange die Suche
 * läuft. Eine neue Suche bricht die vorige des Fensters ab.
 */
export function searchText(
  project: string,
  query: TextQuery,
  onMatches: (files: FileMatches[]) => void,
): TextSearch {
  const id = (lastId += 1);
  let cancelled = false;
  const channel = new Channel<FileMatches[]>();
  // Was nach dem Abbruch noch unterwegs war, verfällt.
  channel.onmessage = (files) => {
    if (!cancelled) onMatches(files);
  };
  const done = invoke<SearchOutcome>("search_text", { project, id, query, onMatches: channel });
  return {
    done: done.then((outcome) => (cancelled ? { ...outcome, cancelled } : outcome)),
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      invoke("search_cancel", { id }).catch(() => {});
    },
  };
}
