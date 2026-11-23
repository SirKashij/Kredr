/**
 * Der Fensterinhalt und, nach und nach, die Regeln für Workspaces: reine
 * Funktionen ohne React und ohne Aufrufe an den Kern.
 */

import type { Statuses } from "./agentStatus";
import {
  addGroupBeside,
  closeTab,
  filePathOf,
  isTerminal,
  recordConversation,
  tabsOf,
  type Arrangement,
  type Tab,
} from "./arrangement";
import { folderKey, isOutsideProject } from "./filePath";

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

/**
 * Das Projekt, zu dem der Tab gehört. Ein Terminal gehört zu dem Projekt, in
 * dessen Ordner es gestartet wurde; ohne eigenen Startordner startet es im
 * ersten Projekt. Eine Datei mit relativem Pfad liegt im ersten Projekt.
 * Die Versionskontrolle gehört zu keinem Projekt.
 */
export function projectOfTab(projects: readonly string[], tab: Tab): string | null {
  const first = projects[0] ?? null;
  if (isTerminal(tab)) return tab.cwd === undefined ? first : projectOf(projects, tab.cwd);
  const file = filePathOf(tab);
  if (file === undefined) return null;
  return isOutsideProject(file) ? projectOf(projects, file) : first;
}

/** Was aus dem Entfernen eines Projekts aus dem Workspace wird. */
export interface Removal {
  /** Der Workspace ohne das Projekt; er bleibt bestehen, auch leer. */
  content: WindowContent;
  /** Die Aufteilung ohne die Tabs, die schließen. */
  arrangement: Arrangement;
  /** Die Tabs, die schließen, in der Reihenfolge ihrer Gruppen. */
  closing: Tab[];
}

/**
 * Entfernt das Projekt aus dem Workspace. Mit ihm schließen seine Terminals
 * und Dateien; alle übrigen Tabs bleiben, wie sie sind. Bleibt kein Projekt
 * übrig, schließen alle Tabs. `null`, wenn das Fenster keinen Workspace mit
 * diesem Projekt zeigt.
 */
export function removeProject(
  content: WindowContent,
  arrangement: Arrangement,
  folder: string,
): Removal | null {
  if (content.kind !== "workspace" || !containsProject(content, folder)) return null;
  const key = folderKey(folder);
  const projects = content.projects.filter((project) => folderKey(project) !== key);
  const belongs = (tab: Tab) => {
    const owner = projectOfTab(content.projects, tab);
    return owner !== null && folderKey(owner) === key;
  };
  const closing = tabsOf(arrangement).filter((tab) => projects.length === 0 || belongs(tab));
  return {
    content: { ...content, projects },
    arrangement: closing.reduce((current, tab) => closeTab(current, tab.id), arrangement),
    closing,
  };
}

/**
 * Die gespeicherte Aufteilung des Projekts `folder` mit den Agenten unter
 * `closing`, die ein Gespräch haben: So setzen sie es fort, wenn das Projekt
 * wieder allein geöffnet wird. Kennt die Aufteilung ein Gespräch schon, etwa
 * weil aus diesem Projekt der Workspace entstand, rückt es an jener Stelle
 * auf den neuen Stand; jedes Gespräch steht nur einmal darin (ADR 0004).
 */
export function keepConversations(
  stored: Arrangement,
  closing: readonly Tab[],
  folder: string,
): Arrangement {
  const known = new Map(
    tabsOf(stored).flatMap((tab) => (tab.conversation ? [[tab.conversation.id, tab.id]] : [])),
  );
  let kept = stored;
  const added: Tab[] = [];
  for (const tab of closing) {
    if (!tab.conversation) continue;
    const existing = known.get(tab.conversation.id);
    if (existing !== undefined) {
      kept = recordConversation(kept, existing, tab.conversation);
      continue;
    }
    const { cwd, ...rest } = tab;
    // Im Projektordner startet ein Terminal ohnehin.
    added.push(cwd === undefined || folderKey(cwd) === folderKey(folder) ? rest : tab);
  }
  return addGroupBeside(kept, added);
}

/**
 * Ob das Schließen dieser Tabs einen Agenten unterbräche, der arbeitet oder
 * auf Eingabe wartet; dann fragt Kredr vorher nach. Ein fertiger Agent
 * verliert nichts.
 */
export function removalInterrupts(closing: readonly Tab[], statuses: Statuses): boolean {
  return closing.some((tab) => {
    const state = statuses.get(tab.id)?.state;
    return state === "working" || state === "waiting";
  });
}
