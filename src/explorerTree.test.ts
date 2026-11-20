import { expect, test } from "vitest";
import {
  emptyTree,
  expandFolder,
  folderFor,
  foldersToLoad,
  foldersToReload,
  receiveListing,
  renameInTree,
  rowsOf,
  rowsWithEdit,
  toggleFolder,
  type Edit,
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

/** Die Zeilen samt Namenseingabe; die Eingabezeile ist mit `>` markiert. */
function shownWithEdit(tree: ExplorerTree, edit: Edit): string[] {
  return rowsWithEdit(rowsOf(tree), edit).map(
    (row) => "  ".repeat(row.depth) + (row.edit ? `>${row.name}` : row.name),
  );
}

/** Projekt mit aufgeklapptem `src` (Unterordner `ui`, Datei `main.ts`) und `README.md`. */
function sampleProject(): ExplorerTree {
  const tree = projectWith([folder("src"), folder("tests"), file("README.md")]);
  return expandWith(tree, "src", [folder("ui"), file("main.ts")]);
}

test("ein neuer Eintrag entsteht im ausgewählten Ordner, neben einer ausgewählten Datei oder im Projektordner", () => {
  expect(folderFor({ path: "src/ui", kind: "folder" })).toBe("src/ui");
  expect(folderFor({ path: "src/main.ts", kind: "file" })).toBe("src");
  expect(folderFor({ path: "README.md", kind: "file" })).toBe("");
  expect(folderFor(null)).toBe("");
});

test("die Eingabezeile für eine neue Datei steht unter den Unterordnern ihres Ordners", () => {
  const edit: Edit = { type: "create", folder: "src", kind: "file" };

  expect(shownWithEdit(sampleProject(), edit)).toEqual([
    "src",
    "  ui",
    "  >",
    "  main.ts",
    "tests",
    "README.md",
  ]);
});

test("die Eingabezeile für einen neuen Ordner steht ganz oben in ihrem Ordner", () => {
  const edit: Edit = { type: "create", folder: "src", kind: "folder" };

  expect(shownWithEdit(sampleProject(), edit)).toEqual([
    "src",
    "  >",
    "  ui",
    "  main.ts",
    "tests",
    "README.md",
  ]);
});

test("im Projektordner steht die Eingabezeile für eine Datei hinter allen Ordnern samt Inhalt", () => {
  const edit: Edit = { type: "create", folder: "", kind: "file" };

  expect(shownWithEdit(sampleProject(), edit)).toEqual([
    "src",
    "  ui",
    "  main.ts",
    "tests",
    ">",
    "README.md",
  ]);
});

test("in einem leeren oder noch nicht gelesenen Ordner steht die Eingabezeile direkt unter ihm", () => {
  const tree = toggleFolder(sampleProject(), "tests");

  expect(shownWithEdit(tree, { type: "create", folder: "tests", kind: "file" })).toEqual([
    "src",
    "  ui",
    "  main.ts",
    "tests",
    "  >",
    "README.md",
  ]);
  expect(shownWithEdit(emptyTree, { type: "create", folder: "", kind: "folder" })).toEqual([">"]);
});

test("die Eingabezeile eines neuen Eintrags ist von jeder vorhandenen Zeile unterscheidbar", () => {
  const rows = rowsWithEdit(rowsOf(sampleProject()), {
    type: "create",
    folder: "src",
    kind: "file",
  });

  expect(new Set(rows.map((row) => row.path)).size).toBe(rows.length);
  expect(rows.find((row) => row.edit)).toMatchObject({ kind: "file", edit: "create", depth: 1 });
});

test("beim Umbenennen wird die vorhandene Zeile zur Eingabezeile", () => {
  expect(shownWithEdit(sampleProject(), { type: "rename", path: "src/main.ts" })).toEqual([
    "src",
    "  ui",
    "  >main.ts",
    "tests",
    "README.md",
  ]);
});

test("ohne Namenseingabe bleiben die Zeilen, wie sie sind", () => {
  const rows = rowsOf(sampleProject());

  expect(rowsWithEdit(rows, null)).toEqual(rows);
});

test("zum Anlegen klappt der Zielordner samt den Ordnern über ihm auf", () => {
  const tree = expandFolder(projectWith([folder("src")]), "src/ui/deep");

  expect([...tree.expanded].sort()).toEqual(["src", "src/ui", "src/ui/deep"]);
  expect(foldersToLoad(tree)).toEqual(["src"]);
  expect(expandFolder(tree, "")).toBe(tree);
});

test("ein umbenannter Ordner bleibt samt seinen Unterordnern aufgeklappt", () => {
  let tree = expandWith(sampleProject(), "src/ui", [file("App.tsx")]);

  tree = renameInTree(tree, "src", "source");
  // Danach meldet der Ereignisstrom die Änderung, und der Projektordner wird neu gelesen.
  tree = receiveListing(tree, "", [folder("source"), folder("docs"), file("README.md")]);

  expect(shown(tree)).toEqual(["docs", "source", "  ui", "    App.tsx", "  main.ts", "README.md"]);
});

test("Umbenennen lässt Ordner mit ähnlich beginnendem Namen unberührt", () => {
  let tree = projectWith([folder("src"), folder("src-tauri")]);
  tree = toggleFolder(toggleFolder(tree, "src"), "src-tauri");

  tree = renameInTree(tree, "src", "app");

  expect([...tree.expanded].sort()).toEqual(["app", "src-tauri"]);
});
