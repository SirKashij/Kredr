import { invoke } from "@tauri-apps/api/core";

/** Ein Eintrag der Liste zuletzt geöffneter Projekte, wie der Kern ihn liefert. */
export interface RecentProject {
  /** Der Ordner des Projekts. */
  path: string;
  /** Ob der Ordner noch vorhanden ist. */
  exists: boolean;
}

/** Die zuletzt geöffneten Projekte, das jüngste zuerst. */
export function loadRecentProjects(): Promise<RecentProject[]> {
  return invoke<RecentProject[]>("recent_projects");
}

/** Entfernt das Projekt aus der Liste und liefert die Liste danach. */
export function forgetProject(folder: string): Promise<RecentProject[]> {
  return invoke<RecentProject[]>("forget_project", { path: folder });
}

/** Der Name eines Projekts ist der Name seines Ordners. */
export function projectName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? folder;
}
