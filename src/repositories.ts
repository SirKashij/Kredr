/**
 * Die Versionskontrolle im Workspace: welche Projekte Repositories sind,
 * welches der Verlauf zeigt und welche Abschnitte ausgeblendet oder
 * zugeklappt sind. Reine Funktionen ohne React und ohne Aufrufe an den Kern.
 */

import type { Arrangement } from "./arrangement";
import { folderKey } from "./filePath";
import type { VersionControlState } from "./versionControlState";
import { listsFolder, toggleFolder } from "./workspace";

/**
 * Die Einträge, deren Projekt ein Git-Repository ist, in der Reihenfolge
 * des Workspace. Projekte ohne Git fehlen, ebenso Projekte, für die der Kern
 * noch keinen Zustand gemeldet hat.
 */
export function repositoriesOf<Entry extends { snapshot: { state: VersionControlState | null } }>(
  entries: readonly Entry[],
): Entry[] {
  return entries.filter((entry) => entry.snapshot.state?.kind === "repository");
}

/**
 * Das Repository, dessen Verlauf gezeigt wird: das gewählte, ohne eigene
 * Wahl das des aktiven Projekts und, hat dieses kein Git, das erste.
 * `null` ohne Repository.
 */
export function historyRepository(
  repositories: readonly string[],
  chosen: string | null,
  active: string | null,
): string | null {
  const find = (project: string | null) => {
    if (project === null) return undefined;
    const key = folderKey(project);
    return repositories.find((repository) => folderKey(repository) === key);
  };
  return find(chosen) ?? find(active) ?? repositories[0] ?? null;
}

/** Ob das Repository im Workspace ausgeblendet ist; es steht dann nur in „Repositories“. */
export function isRepositoryHidden(arrangement: Arrangement, project: string): boolean {
  return listsFolder(arrangement, "hiddenRepositories", project);
}

/** Blendet das Repository aus oder wieder ein; gespeichert wird das mit der Aufteilung. */
export function toggleRepositoryHidden(arrangement: Arrangement, project: string): Arrangement {
  return toggleFolder(arrangement, "hiddenRepositories", project);
}

/** Ob der Abschnitt des Repositorys zugeklappt ist. */
export function isRepositoryCollapsed(arrangement: Arrangement, project: string): boolean {
  return listsFolder(arrangement, "collapsedRepositories", project);
}

/** Klappt den Abschnitt des Repositorys zu oder auf; gespeichert wird das mit der Aufteilung. */
export function toggleRepositoryCollapsed(arrangement: Arrangement, project: string): Arrangement {
  return toggleFolder(arrangement, "collapsedRepositories", project);
}

/**
 * Macht den Abschnitt des Repositorys sichtbar: blendet ihn ein und klappt
 * ihn auf. Ist er das schon, bleibt die Aufteilung dieselbe.
 */
export function revealRepository(arrangement: Arrangement, project: string): Arrangement {
  let revealed = arrangement;
  if (isRepositoryHidden(revealed, project)) revealed = toggleRepositoryHidden(revealed, project);
  if (isRepositoryCollapsed(revealed, project)) {
    revealed = toggleRepositoryCollapsed(revealed, project);
  }
  return revealed;
}
