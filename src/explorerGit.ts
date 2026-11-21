/**
 * Die Git-Markierungen des Explorers: welche Zeile des Baums welche Farbe und
 * welches Kürzel trägt. Reine Funktionen über dem Zustand der
 * Versionskontrolle.
 */

import type { Row } from "./explorerTree";
import { parentOf } from "./filePath";
import { statusLetter, type FileStatus, type VersionControlState } from "./versionControlState";

/** Die Markierung einer Zeile; zu `status` gehört die CSS-Klasse `git-<status>`. */
export interface GitMark {
  status: FileStatus | "ignored";
  /** Das Kürzel einer Datei; Ordner und Ignoriertes tragen keines. */
  badge: string | null;
}

/** Die Markierungen eines Projekts, zum Nachschlagen je Zeile aufbereitet. */
export interface GitMarks {
  /** Der Status je geänderter Datei. */
  readonly files: ReadonlyMap<string, FileStatus>;
  /** Der Status, den ein Ordner von den Dateien unter ihm erbt. */
  readonly folders: ReadonlyMap<string, FileStatus>;
  /** Ignorierte Dateien und Ordner; ein Ordner steht für alles darin. */
  readonly ignored: ReadonlySet<string>;
}

/** Treffen mehrere Status auf eine Zeile, zeigt sie den, der hier zuerst steht. */
const weight: FileStatus[] = ["conflicted", "modified", "deleted", "renamed", "added", "untracked"];

function heavier(a: FileStatus | undefined, b: FileStatus): FileStatus {
  return a !== undefined && weight.indexOf(a) <= weight.indexOf(b) ? a : b;
}

/** Bereitet den Zustand auf. Ohne Repository gibt es keine Markierungen. */
export function gitMarks(state: VersionControlState | null): GitMarks {
  const files = new Map<string, FileStatus>();
  const folders = new Map<string, FileStatus>();
  if (state?.kind !== "repository") return { files, folders, ignored: new Set() };

  for (const { path, status } of state.files) {
    files.set(path, heavier(files.get(path), status));
    for (let folder = parentOf(path); folder !== ""; folder = parentOf(folder)) {
      const inherited = heavier(folders.get(folder), status);
      // Ist dieser Ordner schon so markiert, sind es auch alle über ihm.
      if (folders.get(folder) === inherited) break;
      folders.set(folder, inherited);
    }
  }
  return { files, folders, ignored: new Set(state.ignored) };
}

/** Die Markierung einer Zeile des Baums; `null`, wenn sie keine trägt. */
export function markOf(marks: GitMarks, row: Pick<Row, "path" | "kind">): GitMark | null {
  if (row.kind === "file") {
    const status = marks.files.get(row.path);
    if (status) return { status, badge: statusLetter(status) };
  } else {
    const status = marks.folders.get(row.path);
    if (status) return { status, badge: null };
  }
  if (marks.ignored.size === 0) return null;
  // Ignoriert ist, was selbst so gemeldet ist oder in einem solchen Ordner
  // liegt; der leere Pfad ist der Projektordner.
  for (let path = row.path; ; path = parentOf(path)) {
    if (marks.ignored.has(path)) return { status: "ignored", badge: null };
    if (path === "") return null;
  }
}
