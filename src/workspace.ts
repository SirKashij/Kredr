/**
 * Der Fensterinhalt und, nach und nach, die Regeln für Workspaces: reine
 * Funktionen ohne React und ohne Aufrufe an den Kern.
 */

/** Was ein Fenster zeigt; der Kern liefert denselben Typ. */
export type WindowContent =
  /** Noch kein Projekt: die Liste zuletzt geöffneter Projekte. */
  | { kind: "startPage" }
  /** Ein einzelnes Projekt ohne Workspace. */
  | { kind: "project"; path: string }
  /** Mehrere Projekte in Reihenfolge; die Liste darf auch leer sein. */
  | { kind: "workspace"; id: string; name: string; projects: string[] };

/** Der Inhalt eines Fensters ohne Projekt. */
export const startPage: WindowContent = { kind: "startPage" };

/** Die Projektordner, die das Fenster zeigt, in Reihenfolge. */
export function projectsOf(content: WindowContent): readonly string[] {
  switch (content.kind) {
    case "startPage":
      return [];
    case "project":
      return [content.path];
    case "workspace":
      return content.projects;
  }
}

/** Das erste Projekt des Fensters; nichts auf der Startseite und im leeren Workspace. */
export function firstProject(content: WindowContent): string | null {
  return projectsOf(content)[0] ?? null;
}
