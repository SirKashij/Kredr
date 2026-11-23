import { invoke } from "@tauri-apps/api/core";

/** Ein Projekt der Zuletzt-Liste, wie der Kern es liefert. */
export interface RecentProject {
  /** Der Ordner des Projekts. */
  path: string;
  /** Ob der Ordner noch vorhanden ist. */
  exists: boolean;
}

/** Ein Eintrag der Zuletzt-Liste: ein Projekt oder ein Workspace. */
export type RecentEntry =
  | ({ kind: "project" } & RecentProject)
  | { kind: "workspace"; id: string; name: string; projects: RecentProject[] };

/** Die zuletzt genutzten Projekte und Workspaces gemischt, das jüngste zuerst. */
export function loadRecentEntries(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recent_entries");
}

/** Entfernt das Projekt aus der Liste und liefert die Liste danach. */
export function forgetProject(folder: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("forget_project", { path: folder });
}

/** Entfernt den Workspace aus der Liste und liefert die Liste danach. */
export function forgetWorkspace(id: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("forget_workspace", { id });
}

/** Der Name eines Projekts ist der Name seines Ordners. */
export function projectName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? folder;
}
