import { expect, test } from "vitest";
import {
  emptyTree,
  foldersToLoad,
  foldersToReload,
  receiveListing,
  revealPath,
  rowsOf,
  toggleFolder,
  type ExplorerTree,
} from "./explorerTree";
import type { Entry } from "./projectFiles";

const folder = (name: string): Entry => ({ name, kind: "folder" });
const file = (name: string): Entry => ({ name, kind: "file" });

/** Die sichtbaren Zeilen als eingerückte Namen. */
function shown(tree: ExplorerTree): string[] {
  return rowsOf(tree).map((row) => "  ".repeat(row.depth) + row.name);
}

/** Ein Baum mit geladenem Projektordner. */
function projectWith(entries: Entry[]): ExplorerTree {
  return receiveListing(emptyTree, "", entries);
}

/** Klappt den Ordner auf und liefert seinen Inhalt nach. */
function expandWith(tree: ExplorerTree, path: string, entries: Entry[]): ExplorerTree {
  return receiveListing(toggleFolder(tree, path), path, entries);
}

test("ein leerer Baum lädt zuerst den Projektordner", () => {
  expect(foldersToLoad(emptyTree)).toEqual([""]);
  expect(rowsOf(emptyTree)).toEqual([]);
});

test("Ordner stehen vor Dateien, sortiert wie in VS Code", () => {
  const tree = projectWith([
    file("b.txt"),
    folder("src"),
    file("A.txt"),
    file("datei10.txt"),
    file("datei2.txt"),
    file(".gitignore"),
    folder("Docs"),
  ]);

  expect(shown(tree)).toEqual([
    "Docs",
    "src",
    ".gitignore",
    "A.txt",
    "b.txt",
    "datei2.txt",
    "datei10.txt",
  ]);
});

test("der Ordner .git erscheint wie in VS Code nicht", () => {
  const tree = projectWith([folder(".git"), folder(".github"), file(".gitignore")]);

  expect(shown(tree)).toEqual([".github", ".gitignore"]);
});

test("der Inhalt eines Ordners wird erst beim Aufklappen geladen", () => {
  const project = projectWith([folder("src"), file("README.md")]);
  expect(foldersToLoad(project)).toEqual([]);

  const expanding = toggleFolder(project, "src");
  expect(foldersToLoad(expanding)).toEqual(["src"]);

  const expanded = receiveListing(expanding, "src", [file("main.ts"), folder("ui")]);
  expect(foldersToLoad(expanded)).toEqual([]);
  expect(shown(expanded)).toEqual(["src", "  ui", "  main.ts", "README.md"]);
  expect(rowsOf(expanded)[1]).toEqual({
    path: "src/ui",
    name: "ui",
    kind: "folder",
    depth: 1,
    expanded: false,
  });
});

test("Zuklappen blendet den Inhalt aus", () => {
  const project = projectWith([folder("src"), file("README.md")]);
  const expanded = expandWith(project, "src", [file("main.ts")]);

  const collapsed = toggleFolder(expanded, "src");

  expect(shown(collapsed)).toEqual(["src", "README.md"]);
  expect(rowsOf(collapsed)[0].expanded).toBe(false);
});

test("erneutes Aufklappen lädt frisch und stellt aufgeklappte Unterordner wieder her", () => {
  let tree = projectWith([folder("src")]);
  tree = expandWith(tree, "src", [folder("ui")]);
  tree = expandWith(tree, "src/ui", [file("App.tsx")]);
  tree = toggleFolder(tree, "src");

  tree = toggleFolder(tree, "src");
  expect(foldersToLoad(tree)).toEqual(["src"]);
  tree = receiveListing(tree, "src", [folder("ui")]);
  expect(foldersToLoad(tree)).toEqual(["src/ui"]);
  tree = receiveListing(tree, "src/ui", [file("App.tsx"), file("neu.ts")]);

  expect(shown(tree)).toEqual(["src", "  ui", "    App.tsx", "    neu.ts"]);
});

test("ein Inhalt, der für einen zugeklappten Ordner eintrifft, wird verworfen", () => {
  const project = projectWith([folder("src")]);
  const collapsedAgain = toggleFolder(toggleFolder(project, "src"), "src");

  const tree = receiveListing(collapsedAgain, "src", [file("main.ts")]);

  expect(tree).toBe(collapsedAgain);
});

test("eine Änderung lädt die geladenen Ordner neu, in denen sie liegt", () => {
  let tree = projectWith([folder("src"), folder("node_modules")]);
  tree = expandWith(tree, "src", [folder("ui")]);

  expect(foldersToReload(tree, { paths: ["src/neu.ts"], rescan: false })).toEqual(["src"]);
  expect(foldersToReload(tree, { paths: ["neu.txt", "src/a.ts"], rescan: false })).toEqual([
    "",
    "src",
  ]);
});

test("Änderungen in nicht geladenen Ordnern lösen nichts aus", () => {
  let tree = projectWith([folder("src"), folder("node_modules")]);
  tree = expandWith(tree, "src", [folder("ui")]);

  const changes = { paths: ["node_modules/react/index.js", "src/ui/App.tsx"], rescan: false };

  expect(foldersToReload(tree, changes)).toEqual([]);
});

test("viele Änderungen im selben Ordner laden ihn einmal neu", () => {
  const tree = expandWith(projectWith([folder("src")]), "src", []);
  const paths = Array.from({ length: 500 }, (_, index) => `src/datei-${index}.ts`);

  expect(foldersToReload(tree, { paths, rescan: false })).toEqual(["src"]);
});

test("verlangt der Ereignisstrom alles neu zu lesen, werden alle geladenen Ordner neu geladen", () => {
  let tree = projectWith([folder("src")]);
  tree = expandWith(tree, "src", [folder("ui")]);
  tree = expandWith(tree, "src/ui", []);

  expect(foldersToReload(tree, { paths: [], rescan: true })).toEqual(["", "src", "src/ui"]);
});

test("eine von außen angelegte Datei erscheint nach dem Neuladen an ihrem Platz", () => {
  const tree = expandWith(projectWith([folder("src")]), "src", [file("a.ts"), file("c.ts")]);

  const reloaded = receiveListing(tree, "src", [file("a.ts"), file("c.ts"), file("b.ts")]);

  expect(shown(reloaded)).toEqual(["src", "  a.ts", "  b.ts", "  c.ts"]);
});

test("ein von außen gelöschter Ordner verschwindet samt Inhalt", () => {
  let tree = projectWith([folder("src"), file("README.md")]);
  tree = expandWith(tree, "src", [folder("ui")]);
  tree = expandWith(tree, "src/ui", [file("App.tsx")]);

  tree = receiveListing(tree, "", [file("README.md")]);

  expect(shown(tree)).toEqual(["README.md"]);
  expect(foldersToLoad(tree)).toEqual([]);

  // Entsteht ein Ordner gleichen Namens neu, ist er zugeklappt.
  tree = receiveListing(tree, "", [folder("src"), file("README.md")]);
  expect(shown(tree)).toEqual(["src", "README.md"]);
  expect(foldersToLoad(tree)).toEqual([]);
});

test("ein Ordner mit gleichem Namensanfang bleibt beim Löschen seines Nachbarn aufgeklappt", () => {
  let tree = projectWith([folder("src"), folder("src-tauri")]);
  tree = expandWith(tree, "src", [file("a.ts")]);
  tree = expandWith(tree, "src-tauri", [file("Cargo.toml")]);

  tree = receiveListing(tree, "", [folder("src-tauri")]);

  expect(shown(tree)).toEqual(["src-tauri", "  Cargo.toml"]);
});

test("eine Datei aufzudecken klappt alle Ordner über ihr auf", () => {
  const tree = projectWith([folder("src"), file("README.md")]);

  const revealed = revealPath(tree, "src/ui/App.tsx");

  // Die Inhalte der aufgeklappten Ordner werden der Reihe nach geladen.
  expect(foldersToLoad(revealed)).toEqual(["src"]);
  const withSrc = receiveListing(revealed, "src", [folder("ui")]);
  expect(foldersToLoad(withSrc)).toEqual(["src/ui"]);
  const loaded = receiveListing(withSrc, "src/ui", [file("App.tsx")]);
  expect(shown(loaded)).toEqual(["src", "  ui", "    App.tsx", "README.md"]);
});

test("eine sichtbare Datei aufzudecken ändert den Baum nicht", () => {
  const tree = expandWith(projectWith([folder("src")]), "src", [file("a.ts")]);

  expect(revealPath(tree, "src/a.ts")).toBe(tree);
  expect(revealPath(tree, "README.md")).toBe(tree);
});
