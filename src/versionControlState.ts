/**
 * Der Zustand der Versionskontrolle, wie ihn das Kern-Modul meldet, und was
 * die Oberfläche daraus ableitet. Reine Daten und reine Funktionen.
 */

import type { MessageKey } from "./i18n/i18n";

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

/**
 * Eine Änderung an einer Datei. Eine Datei erscheint zweimal, wenn ein Teil
 * ihrer Änderungen ausgewählt ist und ein weiterer nicht.
 */
export interface ChangedFile {
  /** Relativ zum Projektordner und mit `/` getrennt. */
  path: string;
  /** Der frühere Pfad einer umbenannten Datei. */
  originalPath: string | null;
  status: FileStatus;
  /** Ob die Änderung zum Festschreiben ausgewählt (gestagt) ist. */
  staged: boolean;
}

/** Der Zustand des Repositorys, in dem das Projekt liegt. */
export interface RepositoryState {
  kind: "repository";
  /** Der aktuelle Branch; `null`, wenn kein Branch ausgecheckt ist. */
  branch: string | null;
  /** Der aktuelle Commit; `null`, solange es noch keinen gibt. */
  commit: string | null;
  files: ChangedFile[];
  /** Das Gegenstück des Branches auf GitHub; `null`, solange er noch nie gepusht wurde. */
  upstream: string | null;
  /** Wie viele Commits noch nicht gepusht sind. */
  ahead: number;
  /** Wie viele Commits GitHub voraus ist, nach dem Stand der letzten Abfrage. */
  behind: number;
}

export type ErrorReason =
  | "gitMissing"
  | "notARepository"
  | "timedOut"
  | "failed"
  | "authenticationRequired"
  | "pushRejected"
  | "unreachable"
  | "noRemote"
  | "conflict";

/** Warum die Versionskontrolle etwas nicht liefern konnte. */
export interface VersionControlError {
  reason: ErrorReason;
  /** Der Originaltext von Git, unübersetzt. */
  details: string;
}

/** Der Zustand oder der Grund, warum es keinen gibt. */
export type VersionControlState = RepositoryState | ({ kind: "unavailable" } & VersionControlError);

/** Wie viele Dateien geändert sind; jede zählt einmal, auch wenn sie zweimal erscheint. */
export function changedFileCount(state: VersionControlState | null): number {
  if (state?.kind !== "repository") return 0;
  return new Set(state.files.map((file) => file.path)).size;
}

/** Was die Statusleiste als Branch nennt: seinen Namen, ohne Branch den gekürzten Commit. */
export function branchLabel(state: VersionControlState | null): string | null {
  if (state?.kind !== "repository") return null;
  return state.branch ?? state.commit?.slice(0, 7) ?? null;
}

/** Die Änderungen getrennt nach ausgewählt und nicht ausgewählt, je nach Pfad sortiert. */
export function changeSections(state: RepositoryState): {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
} {
  const sorted = [...state.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    staged: sorted.filter((file) => file.staged),
    unstaged: sorted.filter((file) => !file.staged),
  };
}

const letters: Record<FileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

/** Das Kürzel eines Status, wie es VS Code zeigt. */
export function statusLetter(status: FileStatus): string {
  return letters[status];
}

/** Der Text der Sprachdatei, der einen Status benennt. */
export const statusLabels: Record<FileStatus, MessageKey> = {
  modified: "versionControl.status.modified",
  added: "versionControl.status.added",
  deleted: "versionControl.status.deleted",
  renamed: "versionControl.status.renamed",
  untracked: "versionControl.status.untracked",
  conflicted: "versionControl.status.conflicted",
};

/** Die verständliche Meldung zu einem Grund; der Originaltext steht in `details`. */
export const errorMessages: Record<ErrorReason, MessageKey> = {
  gitMissing: "versionControl.gitMissing",
  notARepository: "versionControl.noRepository",
  timedOut: "versionControl.error.timedOut",
  failed: "versionControl.error.failed",
  authenticationRequired: "versionControl.error.authenticationRequired",
  pushRejected: "versionControl.error.pushRejected",
  unreachable: "versionControl.error.unreachable",
  noRemote: "versionControl.error.noRemote",
  conflict: "versionControl.error.conflict",
};

/** Ob beide dieselbe Zeile der Liste meinen. */
export function sameChange(a: ChangedFile | null, b: ChangedFile | null): boolean {
  return a !== null && b !== null && a.path === b.path && a.staged === b.staged;
}

/**
 * Welche Änderung nach einem neuen Zustand gezeigt wird, wenn bisher
 * `selected` gezeigt wurde: dieselbe Zeile, sonst dieselbe Datei im anderen
 * Abschnitt (sie wurde gerade aus- oder abgewählt), sonst keine.
 */
export function followSelection(
  selected: ChangedFile | null,
  state: VersionControlState,
): ChangedFile | null {
  if (!selected || state.kind !== "repository") return null;
  return (
    state.files.find((file) => sameChange(file, selected)) ??
    state.files.find((file) => file.path === selected.path) ??
    null
  );
}

/** Was die Versionskontrolle eines Fensters gerade ausführt; immer nur eines. */
export type Operation =
  "stage" | "unstage" | "discard" | "commit" | "commitAndPush" | "push" | "pull" | "pullAndPush";

/** Der Text der Sprachdatei, der eine laufende Operation benennt. */
export const operationLabels: Record<Operation, MessageKey> = {
  stage: "versionControl.busy.stage",
  unstage: "versionControl.busy.unstage",
  discard: "versionControl.busy.discard",
  commit: "versionControl.busy.commit",
  commitAndPush: "versionControl.busy.commitAndPush",
  push: "versionControl.busy.push",
  pull: "versionControl.busy.pull",
  pullAndPush: "versionControl.busy.pullAndPush",
};

/** Ob sich festschreiben lässt: Es gibt Änderungen, eine Nachricht, und nichts läuft. */
export function canCommit(
  state: VersionControlState | null,
  message: string,
  busy: Operation | null,
): boolean {
  return (
    busy === null && state?.kind === "repository" && state.files.length > 0 && message.trim() !== ""
  );
}

/** Ob ein Commit alle Änderungen festschreibt, weil keine ausdrücklich ausgewählt ist (wie VS Code). */
export function commitsEverything(state: RepositoryState): boolean {
  return !state.files.some((file) => file.staged);
}

/** Ob sich pushen lässt; ein Branch ohne Gegenstück wird dabei auf GitHub angelegt. */
export function canPush(state: VersionControlState | null, busy: Operation | null): boolean {
  return busy === null && state?.kind === "repository" && state.branch !== null;
}

/** Ob sich pullen lässt; dafür braucht der Branch ein Gegenstück. */
export function canPull(state: VersionControlState | null, busy: Operation | null): boolean {
  return busy === null && state?.kind === "repository" && state.upstream !== null;
}

/** Vorsprung und Rückstand gegenüber GitHub; `null` ohne Gegenstück. */
export function syncCounts(
  state: VersionControlState | null,
): { ahead: number; behind: number } | null {
  if (state?.kind !== "repository" || state.upstream === null) return null;
  return { ahead: state.ahead, behind: state.behind };
}

/** Ob nach diesem Fehler „Erst holen, dann pushen“ der Ausweg ist. */
export function offersPullAndPush(error: VersionControlError | null): boolean {
  return error?.reason === "pushRejected";
}
