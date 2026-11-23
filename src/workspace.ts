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
  mapTabs,
  recordConversation,
  showsFile,
  tabsOf,
  type Arrangement,
  type FolderList,
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

/**
 * Das aktive Projekt: das Projekt des aktiven Tabs, ohne eines (etwa bei
 * einem Terminal außerhalb aller Projekte) das erste. Der Tab
 * „Versionskontrolle“ gehört zu keinem Projekt; zeigt er sich, bleibt das
 * bisher aktive Projekt `previous`, solange es noch im Fenster ist.
 */
export function activeProject(
  projects: readonly string[],
  tab: Tab | undefined,
  previous: string | null,
): string | null {
  const first = projects[0] ?? null;
  if (tab?.content?.kind === "versionControl") {
    const key = previous === null ? null : folderKey(previous);
    return projects.find((project) => folderKey(project) === key) ?? first;
  }
  return (tab && projectOfTab(projects, tab)) ?? first;
}

/** Ein Abschnitt der Agenten-Ansicht im Workspace. */
export interface AgentSection {
  /** Das Projekt des Abschnitts; `null` für „Außerhalb der Projekte“. */
  project: string | null;
  /** Die Terminals des Abschnitts in der Reihenfolge der Aufteilung. */
  tabs: Tab[];
}

/**
 * Die Terminals unter `tabs`, nach Projekten gruppiert: ein Abschnitt je
 * Projekt in der Reihenfolge des Workspace, auch ohne Terminals, und zuletzt
 * „Außerhalb der Projekte“, wenn ein Terminal außerhalb aller Projekte
 * gestartet wurde. Dateien gehören in keinen Abschnitt.
 */
export function agentSections(projects: readonly string[], tabs: readonly Tab[]): AgentSection[] {
  const sections: AgentSection[] = projects.map((project) => ({ project, tabs: [] }));
  const outside: AgentSection = { project: null, tabs: [] };
  for (const tab of tabs.filter(isTerminal)) {
    const owner = projectOfTab(projects, tab);
    (sections.find((section) => section.project === owner) ?? outside).tabs.push(tab);
  }
  return outside.tabs.length > 0 ? [...sections, outside] : sections;
}

/** Die Einträge eines Projekts, etwa seine Suchtreffer. */
export interface ProjectGroup<T> {
  project: string;
  items: T[];
}

/**
 * Gruppiert Einträge nach ihrem Projekt: eine Gruppe je Projekt mit
 * Einträgen, in der Reihenfolge des Workspace. Innerhalb einer Gruppe bleibt
 * die Reihenfolge der Einträge; Einträge eines Projekts, das nicht mehr im
 * Workspace ist, fallen weg.
 */
export function groupByProject<T extends { project: string }>(
  projects: readonly string[],
  entries: readonly T[],
): ProjectGroup<T>[] {
  const groups = new Map(
    projects.map((project) => [folderKey(project), { project, items: [] as T[] }]),
  );
  for (const entry of entries) groups.get(folderKey(entry.project))?.items.push(entry);
  return [...groups.values()].filter((group) => group.items.length > 0);
}

/** Eine Datei für „Datei per Namen öffnen“. */
export interface WorkspaceFile {
  project: string;
  /** Relativ zum Projektordner und mit `/` getrennt. */
  path: string;
  /**
   * Der Pfad, unter dem die Datei öffnet und unter den zuletzt geöffneten
   * Dateien steht: im ersten Projekt relativ, sonst voll.
   */
  key: string;
}

/**
 * Die Dateien aller Projekte für „Datei per Namen öffnen“, in der Reihenfolge
 * des Workspace; `filesOf` liefert die Dateiliste eines Projekts.
 */
export function workspaceFiles(
  projects: readonly string[],
  filesOf: (project: string) => readonly string[],
): WorkspaceFile[] {
  return projects.flatMap((project, index) => {
    const root = project.replaceAll("\\", "/").replace(/\/+$/, "");
    // Voll auch dann, wenn das Projekt im ersten liegt: So bleibt jeder Schlüssel eindeutig.
    return filesOf(project).map((path) => ({
      project,
      path,
      key: index === 0 ? path : `${root}/${path}`,
    }));
  });
}

/** Der Schlüssel des Abschnitts in `collapsedSections`. */
function sectionKey(project: string | null): string {
  return project === null ? "" : folderKey(project);
}

/** Ob der Abschnitt des Projekts (`null`: „Außerhalb der Projekte“) zugeklappt ist. */
export function isSectionCollapsed(arrangement: Arrangement, project: string | null): boolean {
  return listsFolder(arrangement, "collapsedSections", project);
}

/**
 * Klappt den Abschnitt des Projekts zu oder auf. Das gehört zur Aufteilung
 * und wird mit ihr pro Workspace gespeichert.
 */
export function toggleSection(arrangement: Arrangement, project: string | null): Arrangement {
  return toggleFolder(arrangement, "collapsedSections", project);
}

/** Ob die Liste `list` der Aufteilung das Projekt nennt (`null`: „Außerhalb der Projekte“). */
export function listsFolder(
  arrangement: Arrangement,
  list: FolderList,
  project: string | null,
): boolean {
  return arrangement[list]?.includes(sectionKey(project)) ?? false;
}

/**
 * Nimmt das Projekt in die Liste `list` der Aufteilung auf oder wieder
 * heraus. Eine leere Liste fällt weg.
 */
export function toggleFolder(
  arrangement: Arrangement,
  list: FolderList,
  project: string | null,
): Arrangement {
  const key = sectionKey(project);
  const current = arrangement[list] ?? [];
  const next = current.includes(key) ? current.filter((other) => other !== key) : [...current, key];
  const { [list]: _, ...rest } = arrangement;
  return next.length > 0 ? { ...rest, [list]: next } : rest;
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

/**
 * Der Workspace unter neuem Namen; Kennung und Projekte bleiben, es entsteht
 * kein neuer Workspace. Leerraum am Rand zählt nicht. `null`, wenn sich
 * nichts ändert: bei leerem oder gleichem Namen und ohne Workspace.
 */
export function renameWorkspace(content: WindowContent, name: string): WindowContent | null {
  const trimmed = name.trim();
  if (content.kind !== "workspace" || trimmed === "" || trimmed === content.name) return null;
  return { ...content, name: trimmed };
}

/** Was aus dem Umsortieren der Projekte eines Workspace wird. */
export interface Move {
  content: WindowContent;
  arrangement: Arrangement;
}

/**
 * Setzt das Projekt im Workspace an die Stelle `index`, gezählt in der
 * Reihenfolge vor dem Verschieben: 0 vor das erste Projekt, die Anzahl der
 * Projekte hinter das letzte. `null`, wenn sich nichts ändert.
 */
export function moveProject(
  content: WindowContent,
  arrangement: Arrangement,
  folder: string,
  index: number,
): Move | null {
  if (content.kind !== "workspace") return null;
  const key = folderKey(folder);
  const from = content.projects.findIndex((project) => folderKey(project) === key);
  if (from < 0 || index === from || index === from + 1) return null;
  const projects = content.projects.filter((_, position) => position !== from);
  projects.splice(index > from ? index - 1 : index, 0, content.projects[from]);
  const previous = content.projects[0];
  const kept = previous === projects[0] ? arrangement : mapTabs(arrangement, anchorIn(previous));
  return { content: { ...content, projects }, arrangement: kept };
}

/**
 * Bindet einen Tab, der dem ersten Projekt folgt, fest an `project`: ein
 * Terminal ohne Startordner bekommt dessen Ordner, eine Datei mit relativem
 * Pfad ihren vollen Pfad. So bleibt er bei seinem Projekt, wenn ein anderes
 * an die erste Stelle rückt.
 */
function anchorIn(project: string): (tab: Tab) => Tab {
  const root = project.replaceAll("\\", "/").replace(/\/+$/, "");
  return (tab) => {
    if (isTerminal(tab)) return tab.cwd === undefined ? { ...tab, cwd: project } : tab;
    if (!showsFile(tab.content) || isOutsideProject(tab.content.path)) return tab;
    return { ...tab, content: { ...tab.content, path: `${root}/${tab.content.path}` } };
  };
}
