import { parentOf } from "./filePath";
import type { Entry, ProjectChanges } from "./projectFiles";

/**
 * Der Zustand des Explorer-Baums. Ordner sind über ihren Pfad relativ zum
 * Projektordner benannt (mit `/` getrennt); der Projektordner selbst ist `""`.
 */
export interface ExplorerTree {
  /** Die geladenen Ordnerinhalte, sortiert. */
  readonly listings: ReadonlyMap<string, readonly Entry[]>;
  /** Die aufgeklappten Ordner; auch solche, die gerade unter einem zugeklappten liegen. */
  readonly expanded: ReadonlySet<string>;
}

/** Eine sichtbare Zeile des Baums. */
export interface Row {
  path: string;
  name: string;
  kind: Entry["kind"];
  /** Einrückungstiefe; Einträge des Projektordners haben 0. */
  depth: number;
  expanded: boolean;
  /** Gesetzt, wenn in dieser Zeile gerade ein Name eingegeben wird. */
  edit?: Edit["type"];
}

export const emptyTree: ExplorerTree = { listings: new Map(), expanded: new Set() };

/** Wo eine gezogene Wurzel landet. */
export interface RootDrop {
  /** Die Stelle unter den Wurzeln: 0 vor der ersten, ihre Anzahl hinter der letzten. */
  index: number;
  /** Die Zeile, über der die Einfügemarke steht; die Anzahl der Zeilen für ganz unten. */
  line: number;
}

/**
 * Wo eine gezogene Wurzel landet, wenn sie über der Zeile `pointed` losgelassen
 * wird, in deren oberer Hälfte bei `upperHalf`. Wurzeln sind die Zeilen der
 * Tiefe 0. In der oberen Hälfte einer Wurzel landet sie davor, sonst hinter
 * der Wurzel, zu der die Zeile gehört.
 */
export function rootDrop(rows: readonly Row[], pointed: number, upperHalf: boolean): RootDrop {
  const roots = rows.flatMap((row, index) => (row.depth === 0 ? [index] : []));
  const owner = roots.filter((index) => index <= pointed).length - 1;
  if (owner < 0) return { index: 0, line: roots[0] ?? 0 };
  if (roots[owner] === pointed && upperHalf) return { index: owner, line: pointed };
  return { index: owner + 1, line: roots[owner + 1] ?? rows.length };
}

/** Der Pfad eines Eintrags in einem Ordner. */
export function childPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

function isBelow(path: string, folder: string): boolean {
  return folder === "" ? path !== "" : path.startsWith(`${folder}/`);
}

// Dieselbe Sortierung wie der Explorer von VS Code: ohne Rücksicht auf
// Groß- und Kleinschreibung, Ziffernfolgen als Zahlen.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareEntries(a: Entry, b: Entry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
}

/** Klappt einen Ordner auf oder zu. Ein zugeklappter Ordner vergisst seinen Inhalt. */
export function toggleFolder(tree: ExplorerTree, folder: string): ExplorerTree {
  const expanded = new Set(tree.expanded);
  if (!expanded.delete(folder)) {
    expanded.add(folder);
    return { ...tree, expanded };
  }
  const listings = new Map(tree.listings);
  for (const path of tree.listings.keys()) {
    if (path === folder || isBelow(path, folder)) listings.delete(path);
  }
  return { listings, expanded };
}

/** Die sichtbaren Ordner, deren Inhalt noch fehlt. */
export function foldersToLoad(tree: ExplorerTree): string[] {
  const missing: string[] = [];
  const visit = (folder: string) => {
    const entries = tree.listings.get(folder);
    if (!entries) {
      missing.push(folder);
      return;
    }
    for (const entry of entries) {
      const path = childPath(folder, entry.name);
      if (entry.kind === "folder" && tree.expanded.has(path)) visit(path);
    }
  };
  visit("");
  return missing;
}

/**
 * Übernimmt den frisch gelesenen Inhalt eines Ordners. Unterordner, die es
 * nicht mehr gibt, verschwinden samt ihrem Zustand. Ein Inhalt für einen
 * Ordner, der inzwischen nicht mehr sichtbar ist, wird verworfen.
 */
export function receiveListing(
  tree: ExplorerTree,
  folder: string,
  entries: readonly Entry[],
): ExplorerTree {
  if (!tree.listings.has(folder) && !foldersToLoad(tree).includes(folder)) return tree;

  // Wie VS Code blendet der Explorer die Verwaltungsdaten von Git aus.
  const sorted = entries.filter((entry) => entry.name !== ".git").sort(compareEntries);
  const subfolders = new Set(
    sorted.filter((entry) => entry.kind === "folder").map((entry) => entry.name),
  );
  const offset = folder === "" ? 0 : folder.length + 1;
  const survives = (path: string) =>
    !isBelow(path, folder) || subfolders.has(path.slice(offset).split("/", 1)[0]);

  const listings = new Map([...tree.listings].filter(([path]) => survives(path)));
  listings.set(folder, sorted);
  return { listings, expanded: new Set([...tree.expanded].filter(survives)) };
}

/** Die geladenen Ordner, deren Inhalt nach diesen Änderungen neu zu lesen ist. */
export function foldersToReload(tree: ExplorerTree, changes: ProjectChanges): string[] {
  if (changes.rescan) return [...tree.listings.keys()].sort();
  const parents = new Set(changes.paths.map(parentOf));
  return [...parents].filter((folder) => tree.listings.has(folder)).sort();
}

/** Die sichtbaren Zeilen des Baums von oben nach unten. */
export function rowsOf(tree: ExplorerTree): Row[] {
  const rows: Row[] = [];
  const visit = (folder: string, depth: number) => {
    for (const entry of tree.listings.get(folder) ?? []) {
      const path = childPath(folder, entry.name);
      const expanded = entry.kind === "folder" && tree.expanded.has(path);
      rows.push({ path, name: entry.name, kind: entry.kind, depth, expanded });
      if (expanded) visit(path, depth + 1);
    }
  };
  visit("", 0);
  return rows;
}

/**
 * Eine laufende Namenseingabe im Baum: ein neuer Eintrag in einem Ordner oder
 * ein neuer Name für einen vorhandenen Eintrag.
 */
export type Edit =
  { type: "create"; folder: string; kind: Entry["kind"] } | { type: "rename"; path: string };

/** Der Ordner, in dem ein neuer Eintrag entsteht, wenn diese Zeile ausgewählt ist. */
export function folderFor(row: Pick<Row, "path" | "kind"> | null | undefined): string {
  if (!row) return "";
  return row.kind === "folder" ? row.path : parentOf(row.path);
}

/** Klappt den Ordner und alle Ordner über ihm auf. */
export function expandFolder(tree: ExplorerTree, folder: string): ExplorerTree {
  const expanded = new Set(tree.expanded);
  for (let path = folder; path !== ""; path = parentOf(path)) expanded.add(path);
  return expanded.size === tree.expanded.size ? tree : { ...tree, expanded };
}

/** Klappt alle Ordner über dem Pfad auf, damit seine Zeile sichtbar wird. */
export function revealPath(tree: ExplorerTree, path: string): ExplorerTree {
  return expandFolder(tree, parentOf(path));
}

/**
 * Die Zeilen samt der laufenden Namenseingabe. Ein neuer Eintrag bekommt eine
 * eigene Zeile ohne Namen in seinem Ordner: ein Ordner ganz oben, eine Datei
 * unter den Unterordnern. Beim Umbenennen wird die vorhandene Zeile markiert.
 */
export function rowsWithEdit(rows: readonly Row[], edit: Edit | null): Row[] {
  if (!edit) return [...rows];
  if (edit.type === "rename") {
    return rows.map((row) => (row.path === edit.path ? { ...row, edit: "rename" } : row));
  }
  const parent = rows.findIndex((row) => row.path === edit.folder && row.kind === "folder");
  // Ein Ordner, der nicht sichtbar ist, kann keine Eingabezeile zeigen.
  if (edit.folder !== "" && parent < 0) return [...rows];
  const depth = edit.folder === "" ? 0 : rows[parent].depth + 1;
  let position = parent + 1;
  while (position < rows.length && rows[position].depth >= depth) {
    const row = rows[position];
    if (row.depth === depth && (edit.kind === "folder" || row.kind === "file")) break;
    position += 1;
  }
  const added: Row = {
    path: childPath(edit.folder, ""),
    name: "",
    kind: edit.kind,
    depth,
    expanded: false,
    edit: "create",
  };
  return [...rows.slice(0, position), added, ...rows.slice(position)];
}

/**
 * Überträgt den Zustand eines umbenannten Eintrags auf seinen neuen Pfad:
 * Ein aufgeklappter Ordner bleibt samt Unterordnern aufgeklappt.
 */
export function renameInTree(tree: ExplorerTree, from: string, to: string): ExplorerTree {
  const moved = (path: string) =>
    path === from || isBelow(path, from) ? to + path.slice(from.length) : path;
  return {
    listings: new Map([...tree.listings].map(([path, entries]) => [moved(path), entries])),
    expanded: new Set([...tree.expanded].map(moved)),
  };
}
