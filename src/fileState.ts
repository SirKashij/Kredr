/**
 * Der Zustand einer offenen Dateiansicht als reines Zustandsmodell: was sie
 * zeigt und wie sie auf Änderungen der Datei von außen (etwa durch einen
 * Agenten) reagiert. Den bearbeiteten Text selbst hält Monaco; das Modell
 * kennt nur den Stand auf der Festplatte.
 */

/** Was das Kern-Modul Projektdateien beim Lesen liefert, dazu ein gescheitertes Lesen. */
export type FileContent =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "tooLarge"; size: number }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export interface FileState {
  /**
   * `text`: der Inhalt wird angezeigt. `binary`, `tooLarge`, `missing` (gab es
   * schon beim Öffnen nicht) und `error` zeigen stattdessen einen Hinweis.
   */
  phase: "loading" | "text" | "binary" | "tooLarge" | "missing" | "error";
  /** Der Inhalt auf der Festplatte, soweit der Ansicht bekannt. */
  disk: string | null;
  /** Ob es ungespeicherte Änderungen gibt. */
  dirty: boolean;
  /** Die angezeigte Datei wurde gelöscht. */
  deleted: boolean;
  /** Die neue Fassung von außen, die auf ungespeicherte Änderungen traf. */
  conflict: string | null;
  /** Größe einer übergroßen Datei in Bytes. */
  size?: number;
  /** Meldung eines gescheiterten Lesens. */
  error?: string;
}

export const loadingFile: FileState = {
  phase: "loading",
  disk: null,
  dirty: false,
  deleted: false,
  conflict: null,
};

/** Der neue Zustand und, wenn die Ansicht ihn übernehmen soll, der Text dazu. */
export interface Step {
  state: FileState;
  /** Dieser Text ersetzt den angezeigten; die Scrollposition bleibt. */
  load?: string;
}

/** Die Datei wurde (erneut) gelesen: beim Öffnen und nach jeder gemeldeten Änderung. */
export function received(state: FileState, content: FileContent): Step {
  const showsText = state.phase === "text";
  switch (content.kind) {
    case "text": {
      const { text } = content;
      if (showsText && text === state.disk) {
        // Unser eigenes Speichern, oder die Änderung wurde zurückgenommen.
        if (!state.deleted && state.conflict === null) return { state };
        return { state: { ...state, deleted: false, conflict: null } };
      }
      if (showsText && state.dirty) return { state: { ...state, deleted: false, conflict: text } };
      return { state: { ...loadingFile, phase: "text", disk: text }, load: text };
    }
    case "missing":
      if (showsText) return { state: state.deleted ? state : { ...state, deleted: true } };
      return { state: { ...loadingFile, phase: "missing" } };
    case "binary":
    case "tooLarge":
      // Ungespeicherte Änderungen verdrängt ein Hinweis nicht.
      if (showsText && state.dirty) return { state };
      if (content.kind === "binary") return { state: { ...loadingFile, phase: "binary" } };
      return { state: { ...loadingFile, phase: "tooLarge", size: content.size } };
    case "error":
      // Eine kurz gesperrte Datei (ein Agent schreibt gerade) lässt die Ansicht stehen.
      if (state.phase !== "loading") return { state };
      return { state: { ...loadingFile, phase: "error", error: content.message } };
  }
}

/** Der Text wurde bearbeitet; `dirty` sagt, ob er vom gespeicherten Stand abweicht. */
export function edited(state: FileState, dirty: boolean): FileState {
  return state.dirty === dirty ? state : { ...state, dirty };
}

/**
 * `text` wurde gespeichert. `dirty` ist gesetzt, wenn seit dem Auslösen des
 * Speicherns schon weiter bearbeitet wurde.
 */
export function saved(state: FileState, text: string, dirty = false): FileState {
  return { ...state, disk: text, dirty, deleted: false, conflict: null };
}

/**
 * Entscheidet einen Konflikt: `mine` behält die eigene Fassung (weiterhin
 * ungespeichert; Speichern überschreibt die Datei), `theirs` lädt die neue.
 */
export function resolveConflict(state: FileState, keep: "mine" | "theirs"): Step {
  if (state.conflict === null) return { state };
  const disk = state.conflict;
  if (keep === "mine") return { state: { ...state, disk, conflict: null } };
  return { state: { ...state, disk, dirty: false, conflict: null }, load: disk };
}
