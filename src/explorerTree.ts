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
}

export const emptyTree: ExplorerTree = { listings: new Map(), expanded: new Set() };

/** Der Pfad eines Eintrags in einem Ordner. */
export function childPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
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

/** Klappt alle Ordner über dem Pfad auf, damit seine Zeile sichtbar wird. */
export function revealPath(tree: ExplorerTree, path: string): ExplorerTree {
  const expanded = new Set(tree.expanded);
  for (let folder = parentOf(path); folder !== ""; folder = parentOf(folder)) expanded.add(folder);
  return expanded.size === tree.expanded.size ? tree : { ...tree, expanded };
}
