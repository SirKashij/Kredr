import { expect, test } from "vitest";
import {
  branchLabel,
  changedFileCount,
  changeSections,
  followSelection,
  statusLetter,
  type ChangedFile,
  type FileStatus,
  type RepositoryState,
  type VersionControlState,
} from "./versionControlState";

function change(path: string, status: FileStatus = "modified", staged = false): ChangedFile {
  return { path, originalPath: null, status, staged };
}

function repository(files: ChangedFile[], branch: string | null = "main"): RepositoryState {
  return { kind: "repository", branch, commit: "0123456789abcdef0123456789abcdef01234567", files };
}

const noRepository: VersionControlState = {
  kind: "unavailable",
  reason: "notARepository",
  details: "fatal: not a git repository",
};

test("die Zahl an der Symbolleiste zählt jede geänderte Datei einmal", () => {
  const state = repository([
    change("a.ts", "modified", true),
    change("a.ts"),
    change("b.ts", "untracked"),
  ]);

  expect(changedFileCount(state)).toBe(2);
});

test("ohne Repository und vor dem ersten Zustand gibt es keine Zahl", () => {
  expect(changedFileCount(noRepository)).toBe(0);
  expect(changedFileCount(null)).toBe(0);
});

test("die Statusleiste nennt den Branch", () => {
  expect(branchLabel(repository([], "feature/diff"))).toBe("feature/diff");
});

test("ohne Branch nennt die Statusleiste den gekürzten Commit", () => {
  expect(branchLabel(repository([], null))).toBe("0123456");
});

test("ohne Repository nennt die Statusleiste nichts", () => {
  expect(branchLabel(noRepository)).toBeNull();
  expect(branchLabel(null)).toBeNull();
  expect(branchLabel({ kind: "repository", branch: null, commit: null, files: [] })).toBeNull();
});

test("ausgewählte und nicht ausgewählte Änderungen stehen getrennt, je nach Pfad sortiert", () => {
  const state = repository([
    change("src/b.ts", "modified", true),
    change("src/b.ts"),
    change("src/a.ts", "deleted"),
    change("README.md", "added", true),
    change("neu.txt", "untracked"),
  ]);

  const { staged, unstaged } = changeSections(state);

  expect(staged.map((file) => file.path)).toEqual(["README.md", "src/b.ts"]);
  expect(unstaged.map((file) => file.path)).toEqual(["neu.txt", "src/a.ts", "src/b.ts"]);
});

test("jeder Status hat sein Kürzel wie in VS Code", () => {
  const letters = (
    ["modified", "added", "deleted", "renamed", "untracked", "conflicted"] as const
  ).map(statusLetter);

  expect(letters).toEqual(["M", "A", "D", "R", "U", "!"]);
});

test("die gezeigte Änderung bleibt gewählt, solange es sie gibt", () => {
  const selected = change("a.ts");
  const next = change("a.ts", "deleted");

  expect(followSelection(selected, repository([change("b.ts"), next]))).toBe(next);
});

test("wird die gezeigte Änderung ausgewählt, folgt die Anzeige der Datei", () => {
  const staged = change("a.ts", "modified", true);

  expect(followSelection(change("a.ts"), repository([staged]))).toBe(staged);
});

test("ist die gezeigte Datei nicht mehr geändert, ist nichts mehr gewählt", () => {
  expect(followSelection(change("a.ts"), repository([change("b.ts")]))).toBeNull();
  expect(followSelection(change("a.ts"), noRepository)).toBeNull();
  expect(followSelection(null, repository([change("b.ts")]))).toBeNull();
});
