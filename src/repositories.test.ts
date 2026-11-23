import { expect, test } from "vitest";
import { emptyArrangement, restoreArrangement } from "./arrangement";
import {
  historyRepository,
  isRepositoryCollapsed,
  isRepositoryHidden,
  repositoriesOf,
  revealRepository,
  toggleRepositoryCollapsed,
  toggleRepositoryHidden,
} from "./repositories";
import type { VersionControlState } from "./versionControlState";

const web = "C:\\Projekte\\Web";
const core = "C:\\Projekte\\Kern";
const notes = "C:\\Projekte\\Notizen";

const repository: VersionControlState = {
  kind: "repository",
  branch: "main",
  commit: "abc",
  files: [],
  upstream: null,
  ahead: 0,
  behind: 0,
};
const noRepository: VersionControlState = {
  kind: "unavailable",
  reason: "notARepository",
  details: "",
};

test("Repositories sind die Projekte mit Git, in der Reihenfolge des Workspace", () => {
  const states = new Map<string, VersionControlState | null>([
    [web, repository],
    [notes, noRepository],
    [core, repository],
  ]);
  const entries = [web, notes, core].map((project) => ({
    project,
    snapshot: { state: states.get(project)! },
  }));

  expect(repositoriesOf(entries).map((entry) => entry.project)).toEqual([web, core]);
  // Solange der Kern nichts gemeldet hat, ist ein Projekt noch kein Repository.
  expect(repositoriesOf([{ project: web, snapshot: { state: null } }])).toEqual([]);
});

test("der Verlauf zeigt das gewählte Repository, sonst das des aktiven Projekts, sonst das erste", () => {
  expect(historyRepository([web, core], core, web)).toBe(core);
  expect(historyRepository([web, core], null, core)).toBe(core);
  // Das aktive Projekt hat kein Git.
  expect(historyRepository([web, core], null, notes)).toBe(web);
  // Das gewählte Repository ist nicht mehr da.
  expect(historyRepository([web, core], notes, core)).toBe(core);
  // Groß- und Kleinschreibung zählt unter Windows nicht.
  expect(historyRepository([web, core], null, "c:\\projekte\\kern")).toBe(core);
  expect(historyRepository([], null, web)).toBeNull();
});

test("ein Repository lässt sich aus- und wieder einblenden", () => {
  const hidden = toggleRepositoryHidden(emptyArrangement, web);

  expect(isRepositoryHidden(hidden, web)).toBe(true);
  expect(isRepositoryHidden(hidden, "c:\\projekte\\web")).toBe(true);
  expect(isRepositoryHidden(hidden, core)).toBe(false);
  expect(toggleRepositoryHidden(hidden, web)).toEqual(emptyArrangement);
});

test("der Abschnitt eines Repositorys klappt zu und auf, unabhängig von der Agenten-Ansicht", () => {
  const collapsed = toggleRepositoryCollapsed(emptyArrangement, web);

  expect(isRepositoryCollapsed(collapsed, web)).toBe(true);
  expect(isRepositoryHidden(collapsed, web)).toBe(false);
  expect(collapsed.collapsedSections).toBeUndefined();
  expect(toggleRepositoryCollapsed(collapsed, web)).toEqual(emptyArrangement);
});

test("der Sprung zu einem Repository blendet seinen Abschnitt ein und klappt ihn auf", () => {
  const folded = toggleRepositoryCollapsed(toggleRepositoryHidden(emptyArrangement, web), core);
  const both = toggleRepositoryCollapsed(folded, web);

  const revealed = revealRepository(both, web);
  expect(isRepositoryHidden(revealed, web)).toBe(false);
  expect(isRepositoryCollapsed(revealed, web)).toBe(false);
  expect(isRepositoryCollapsed(revealed, core)).toBe(true);
  // Ist er schon sichtbar und offen, bleibt alles, wie es ist.
  expect(revealRepository(emptyArrangement, web)).toBe(emptyArrangement);
});

test("ausgeblendete und zugeklappte Repositories überstehen das Speichern", () => {
  const folded = toggleRepositoryCollapsed(toggleRepositoryHidden(emptyArrangement, web), core);
  const stored: unknown = JSON.parse(JSON.stringify(folded));

  const restored = restoreArrangement(stored);
  expect(isRepositoryHidden(restored, web)).toBe(true);
  expect(isRepositoryCollapsed(restored, core)).toBe(true);
  // Unlesbare Einträge fallen still weg.
  expect(restoreArrangement({ ...folded, hiddenRepositories: [1] })).toEqual(
    toggleRepositoryCollapsed(emptyArrangement, core),
  );
});
