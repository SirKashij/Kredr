/**
 * Der Fensterinhalt und, nach und nach, die Regeln für Workspaces: reine
 * Funktionen ohne React und ohne Aufrufe an den Kern.
 */

import { folderKey } from "./filePath";

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

/** Ob der Ordner schon zum Fensterinhalt gehört. */
export function containsProject(content: WindowContent, folder: string): boolean {
  const key = folderKey(folder);
  return projectsOf(content).some((project) => folderKey(project) === key);
}

/**
 * Das Projekt, in dessen Ordner der Pfad liegt; bei verschachtelten
 * Projekten das innerste. `null`, wenn der Pfad außerhalb aller Projekte liegt.
 */
export function projectOf(projects: readonly string[], path: string): string | null {
  const key = folderKey(path);
  let found: string | null = null;
  for (const project of projects) {
    const root = folderKey(project);
    const inside = key === root || key.startsWith(`${root}\\`);
    if (inside && (found === null || root.length > folderKey(found).length)) found = project;
  }
  return found;
}

/** Was aus dem Hinzufügen eines Projekts wird. */
export type AddResult =
  { kind: "added"; content: WindowContent } | { kind: "refused"; reason: "alreadyContained" };

/**
 * Fügt dem Fenster ein Projekt hinzu, hinten an. Aus einem Projektfenster
 * wird dabei ein Workspace mit `untitled` als Kennung und Name; ein schon
 * enthaltenes Projekt wird abgelehnt.
 */
export function addProject(
  content: WindowContent,
  folder: string,
  untitled: { id: string; name: string },
): AddResult {
  if (containsProject(content, folder)) return { kind: "refused", reason: "alreadyContained" };
  switch (content.kind) {
    case "startPage":
      return { kind: "added", content: { kind: "project", path: folder } };
    case "project":
      return {
        kind: "added",
        content: { kind: "workspace", ...untitled, projects: [content.path, folder] },
      };
    case "workspace":
      return { kind: "added", content: { ...content, projects: [...content.projects, folder] } };
  }
}
