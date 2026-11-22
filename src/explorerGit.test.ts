import { expect, test } from "vitest";
import { gitMarks, markOf } from "./explorerGit";
import type { ChangedFile, FileStatus, VersionControlState } from "./versionControlState";

function change(path: string, status: FileStatus, staged = false): ChangedFile {
  return { path, originalPath: null, status, staged };
}

function repository(files: ChangedFile[], ignored: string[] = []): VersionControlState {
  return {
    kind: "repository",
    branch: "main",
    commit: null,
    files,
    ignored,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}

const file = (path: string) => ({ path, kind: "file" as const });
const folder = (path: string) => ({ path, kind: "folder" as const });

test("geänderte und neue Dateien tragen Status und Kürzel wie in VS Code", () => {
  const marks = gitMarks(
    repository([
      change("a.ts", "modified"),
      change("b.ts", "untracked"),
      change("c.ts", "added", true),
      change("d.ts", "renamed", true),
      change("e.ts", "conflicted"),
    ]),
  );

  expect(markOf(marks, file("a.ts"))).toEqual({ status: "modified", badge: "M" });
  expect(markOf(marks, file("b.ts"))).toEqual({ status: "untracked", badge: "U" });
  expect(markOf(marks, file("c.ts"))).toEqual({ status: "added", badge: "A" });
  expect(markOf(marks, file("d.ts"))).toEqual({ status: "renamed", badge: "R" });
  expect(markOf(marks, file("e.ts"))).toEqual({ status: "conflicted", badge: "!" });
});

test("eine unveränderte Datei trägt keine Markierung", () => {
  const marks = gitMarks(repository([change("src/a.ts", "modified")]));

  expect(markOf(marks, file("src/b.ts"))).toBeNull();
  expect(markOf(marks, folder("docs"))).toBeNull();
});

test("ein Ordner erbt die Markierung seiner Dateien auf jeder Ebene, ohne Kürzel", () => {
  const marks = gitMarks(repository([change("src/ui/neu.ts", "untracked")]));

  expect(markOf(marks, folder("src"))).toEqual({ status: "untracked", badge: null });
  expect(markOf(marks, folder("src/ui"))).toEqual({ status: "untracked", badge: null });
  // Nur ein gleicher Anfang des Namens ist kein Ordner darüber.
  expect(markOf(marks, folder("src/u"))).toBeNull();
});

test("liegen verschiedene Änderungen in einem Ordner, zeigt er die gewichtigste", () => {
  const marks = gitMarks(
    repository([
      change("src/neu.ts", "untracked"),
      change("src/alt.ts", "modified"),
      change("src/weg.ts", "deleted"),
      change("lib/neu.ts", "untracked"),
      change("lib/streit.ts", "conflicted"),
    ]),
  );

  expect(markOf(marks, folder("src"))?.status).toBe("modified");
  expect(markOf(marks, folder("lib"))?.status).toBe("conflicted");
});

test("eine Datei mit ausgewähltem und nicht ausgewähltem Teil trägt eine Markierung", () => {
  const marks = gitMarks(
    repository([change("neu.ts", "added", true), change("neu.ts", "modified", false)]),
  );

  expect(markOf(marks, file("neu.ts"))).toEqual({ status: "modified", badge: "M" });
});

test("ignorierte Dateien und alles in ignorierten Ordnern sind ignoriert, ohne Kürzel", () => {
  const marks = gitMarks(repository([], ["node_modules", "lauf.log"]));
  const ignored = { status: "ignored", badge: null };

  expect(markOf(marks, file("lauf.log"))).toEqual(ignored);
  expect(markOf(marks, folder("node_modules"))).toEqual(ignored);
  expect(markOf(marks, folder("node_modules/react"))).toEqual(ignored);
  expect(markOf(marks, file("node_modules/react/index.js"))).toEqual(ignored);
  expect(markOf(marks, folder("node_modules_alt"))).toBeNull();
});

test("ein Ordner mit ignorierten Dateien erbt davon nichts", () => {
  const marks = gitMarks(repository([], ["src/lauf.log"]));

  expect(markOf(marks, folder("src"))).toBeNull();
});

test("eine Änderung zählt mehr als ignoriert", () => {
  // Eine Git bekannte Datei in einem ignorierten Ordner.
  const marks = gitMarks(repository([change("build/fest.txt", "modified")], ["build"]));

  expect(markOf(marks, file("build/fest.txt"))?.status).toBe("modified");
  expect(markOf(marks, folder("build"))?.status).toBe("modified");
  expect(markOf(marks, file("build/rest.bin"))?.status).toBe("ignored");
});

test("ist der Projektordner selbst ignoriert, ist es jede Zeile", () => {
  const marks = gitMarks(repository([], [""]));

  expect(markOf(marks, file("a.ts"))?.status).toBe("ignored");
  expect(markOf(marks, folder("src/ui"))?.status).toBe("ignored");
});

test("ohne Repository und vor dem ersten Zustand gibt es keine Markierungen", () => {
  const unavailable = gitMarks({ kind: "unavailable", reason: "notARepository", details: "" });

  expect(markOf(unavailable, file("a.ts"))).toBeNull();
  expect(markOf(gitMarks(null), folder("src"))).toBeNull();
});

test("die Projektwurzel trägt wie ein Ordner den Punkt, wenn darunter etwas geändert ist", () => {
  const changed = gitMarks(
    repository([change("src/a.ts", "untracked"), change("b.ts", "modified")]),
  );

  expect(markOf(changed, folder(""))).toEqual({ status: "modified", badge: null });
  expect(markOf(gitMarks(repository([])), folder(""))).toBeNull();
});
