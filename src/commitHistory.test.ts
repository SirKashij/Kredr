import { expect, test } from "vitest";
import {
  PAGE_SIZE,
  appendPage,
  commitTime,
  historyMayHaveChanged,
  reloadCount,
  sameCommitFile,
  summaryOf,
  type Commit,
  type CommitFile,
} from "./commitHistory";

function commit(id: string, message = `Commit ${id}`): Commit {
  return { id, message, author: "Agent", time: 1_700_000_000, pushed: true };
}

function file(path: string): CommitFile {
  return { path, originalPath: null, status: "modified" };
}

test("die Zeile eines Commits zeigt die erste Zeile seiner Nachricht", () => {
  expect(summaryOf("Verlauf: Commit-Liste\n\nErster Absatz.\nZweite Zeile.")).toBe(
    "Verlauf: Commit-Liste",
  );
  expect(summaryOf("Einzeilig")).toBe("Einzeilig");
  expect(summaryOf("Windows-Zeilenende\r\nRest")).toBe("Windows-Zeilenende");
});

test("nachgeladene Commits hängen sich an die Liste an", () => {
  const { commits, ended } = appendPage([commit("a"), commit("b")], [commit("c"), commit("d")], 2);

  expect(commits.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  expect(ended).toBe(false);
});

test("kommen weniger Commits als verlangt, ist die Liste zu Ende", () => {
  expect(appendPage([commit("a")], [commit("b")], 2).ended).toBe(true);
  expect(appendPage([commit("a")], [], 2)).toEqual({ commits: [commit("a")], ended: true });
});

test("ein Commit steht nie doppelt in der Liste, auch wenn sie sich inzwischen verschoben hat", () => {
  // Zwischen zwei Seiten kam ein neuer Commit hinzu: „b“ rutscht auf die nächste Seite.
  const { commits } = appendPage([commit("a"), commit("b")], [commit("b"), commit("c")], 2);

  expect(commits.map((c) => c.id)).toEqual(["a", "b", "c"]);
});

test("beim Aktualisieren bleibt geladen, was schon nachgeladen war", () => {
  expect(reloadCount(0)).toBe(PAGE_SIZE);
  expect(reloadCount(PAGE_SIZE - 1)).toBe(PAGE_SIZE);
  expect(reloadCount(3 * PAGE_SIZE)).toBe(3 * PAGE_SIZE);
});

test("Commit, Branch-Wechsel, Push, Pull und Fetch können den Verlauf ändern", () => {
  const changed = (...paths: string[]) => historyMayHaveChanged({ paths, rescan: false });

  expect(changed(".git/HEAD")).toBe(true);
  expect(changed(".git/refs/heads/main")).toBe(true);
  expect(changed(".git/refs/remotes/origin/main")).toBe(true);
  expect(changed(".git/packed-refs")).toBe(true);
  expect(changed("src/a.ts", ".git/refs/heads/feature/x.lock")).toBe(true);
  expect(historyMayHaveChanged({ paths: [], rescan: true })).toBe(true);
});

test("Dateien des Projekts und die Auswahl ändern den Verlauf nicht", () => {
  const changed = (...paths: string[]) => historyMayHaveChanged({ paths, rescan: false });

  expect(changed("src/a.ts", "README.md")).toBe(false);
  expect(changed(".git/index", ".git/index.lock")).toBe(false);
  expect(changed(".git/objects/ab/cdef")).toBe(false);
  expect(changed(".github/refs/x", ".gitignore")).toBe(false);
  expect(changed()).toBe(false);
});

test("der Zeitpunkt eines frischen Commits steht relativ zu jetzt", () => {
  const now = new Date("2026-03-10T12:00:00Z").getTime();
  const ago = (seconds: number) => commitTime(now / 1000 - seconds, now, "de");

  expect(ago(10)).toBe("jetzt");
  expect(ago(20 * 60)).toBe("vor 20 Min.");
  expect(ago(3 * 3600)).toBe("vor 3 Std.");
  expect(ago(26 * 3600)).toBe("gestern");
  expect(ago(3 * 86400)).toBe("vor 3 Tagen");
  expect(commitTime(now / 1000 - 20 * 60, now, "en")).toBe("20 min. ago");
});

test("ältere Commits tragen ihr Datum", () => {
  const now = new Date("2026-03-10T12:00:00Z").getTime();
  const time = new Date("2025-11-21T12:00:00Z").getTime() / 1000;

  expect(commitTime(time, now, "de")).toBe("21.11.2025");
  expect(commitTime(time, now, "en")).toBe("Nov 21, 2025");
});

test("eine Uhr, die dem Commit hinterherläuft, ergibt keinen Zeitpunkt in der Zukunft", () => {
  const now = new Date("2026-03-10T12:00:00Z").getTime();

  expect(commitTime(now / 1000 + 90, now, "de")).toBe("jetzt");
});

test("dieselbe Datei desselben Commits ist dieselbe Zeile", () => {
  const shown = { commit: commit("a"), file: file("src/a.ts") };

  expect(sameCommitFile(shown, commit("a"), file("src/a.ts"))).toBe(true);
  expect(sameCommitFile(shown, commit("b"), file("src/a.ts"))).toBe(false);
  expect(sameCommitFile(shown, commit("a"), file("src/b.ts"))).toBe(false);
  expect(sameCommitFile(null, commit("a"), file("src/a.ts"))).toBe(false);
});
