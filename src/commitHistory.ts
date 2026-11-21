/**
 * Der Verlauf der Versionskontrolle: die Commits, wie sie das Kern-Modul
 * liefert, und was die Oberfläche daraus ableitet. Reine Daten und reine
 * Funktionen.
 */

import type { Language } from "./i18n/i18n";
import type { ProjectChanges } from "./projectFiles";
import type { FileStatus } from "./versionControlState";

/** Ein Commit des aktuellen Branches. */
export interface Commit {
  /** Die volle Kennung (Hash). */
  id: string;
  /** Die vollständige Nachricht, auch mehrzeilig. */
  message: string;
  author: string;
  /** Wann festgeschrieben wurde, in Sekunden seit 1970. */
  time: number;
  /** Ob der Commit auf einem Branch eines Remotes liegt. */
  pushed: boolean;
}

/** Eine Datei, die ein Commit geändert hat. */
export interface CommitFile {
  /** Relativ zum Projektordner und mit `/` getrennt. */
  path: string;
  /** Der frühere Pfad einer umbenannten Datei. */
  originalPath: string | null;
  status: FileStatus;
}

/** Die Datei eines Commits, deren Diff der Tab „Versionskontrolle“ zeigt. */
export interface ShownCommitFile {
  commit: Commit;
  file: CommitFile;
}

/** So viele Commits lädt der Verlauf auf einmal. */
export const PAGE_SIZE = 50;

/** Die erste Zeile der Nachricht; sie steht in der Zeile des Commits. */
export function summaryOf(message: string): string {
  return message.split(/\r?\n/, 1)[0];
}

/**
 * Hängt nachgeladene Commits an die Liste. `ended` sagt, dass es keine
 * älteren mehr gibt: Es kamen weniger als die `requested` verlangten.
 */
export function appendPage(
  commits: Commit[],
  page: Commit[],
  requested: number,
): { commits: Commit[]; ended: boolean } {
  const known = new Set(commits.map((commit) => commit.id));
  return {
    commits: [...commits, ...page.filter((commit) => !known.has(commit.id))],
    ended: page.length < requested,
  };
}

/** Wie viele Commits beim Aktualisieren neu gelesen werden, wenn `loaded` geladen sind. */
export function reloadCount(loaded: number): number {
  return Math.max(PAGE_SIZE, loaded);
}

/**
 * Ob gemeldete Änderungen im Projektordner den Verlauf ändern können: ein
 * Commit, ein Branch-Wechsel, Push, Pull oder Fetch schreiben in `.git` die
 * Verweise auf Commits. Die Auswahl (`.git/index`) gehört nicht dazu.
 */
export function historyMayHaveChanged(changes: ProjectChanges): boolean {
  return (
    changes.rescan ||
    changes.paths.some(
      (path) =>
        path === ".git/HEAD" ||
        path === ".git/packed-refs" ||
        path.startsWith(".git/refs/") ||
        path.startsWith(".git/reftable/"),
    )
  );
}

/**
 * Der Zeitpunkt eines Commits, wie er in seiner Zeile steht: in der letzten
 * Woche relativ zu `now` (Millisekunden), davor als Datum.
 */
export function commitTime(time: number, now: number, language: Language): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - time));
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  if (seconds < 60) return relative.format(0, "second");
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return relative.format(-Math.floor(seconds / 3600), "hour");
  if (seconds < 7 * 86400) return relative.format(-Math.floor(seconds / 86400), "day");
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(time * 1000);
}

/** Datum und Uhrzeit eines Commits, ausgeschrieben. */
export function commitDate(time: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(
    time * 1000,
  );
}

/** Ob `shown` die Datei `file` des Commits `commit` ist. */
export function sameCommitFile(
  shown: ShownCommitFile | null,
  commit: Commit,
  file: CommitFile,
): boolean {
  return shown !== null && shown.commit.id === commit.id && shown.file.path === file.path;
}
