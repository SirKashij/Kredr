import { invoke } from "@tauri-apps/api/core";
import type { MessageKey } from "./i18n/i18n";
import type { Entry } from "./projectFiles";

/**
 * Warum der Kern eine Dateioperation abgelehnt hat; entspricht
 * `FileOperationError` im Modul Projektdateien.
 */
export type FileOperationError =
  { kind: "invalidName" | "alreadyExists" | "notFound" } | { kind: "failed"; details: string };

/** Pfade sind wie überall in der Oberfläche relativ zum Projektordner und mit `/` getrennt. */
export function createEntry(
  project: string,
  folder: string,
  name: string,
  kind: Entry["kind"],
): Promise<void> {
  const command = kind === "folder" ? "project_files_create_folder" : "project_files_create_file";
  return invoke(command, { project, folder, name });
}

export function renameEntry(project: string, path: string, newName: string): Promise<void> {
  return invoke("project_files_rename", { project, path, newName });
}

/** Verschiebt den Eintrag in den Windows-Papierkorb. */
export function trashEntry(project: string, path: string): Promise<void> {
  return invoke("project_files_trash", { project, path });
}

/** Markiert den Eintrag im Windows-Explorer; ein leerer Pfad meint den Projektordner. */
export function revealEntry(project: string, path: string): Promise<void> {
  return invoke("project_files_reveal", { project, path });
}

/** Legt den Text in die Zwischenablage. */
export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** Der Schlüssel und die Platzhalter der Meldung zu einer gescheiterten Dateioperation. */
export function errorMessage(
  error: unknown,
  name: string,
): { key: MessageKey; values: Record<string, string> } {
  const kind = (error as Partial<FileOperationError> | null)?.kind;
  switch (kind) {
    case "invalidName":
      return { key: "explorer.error.invalidName", values: { name } };
    case "alreadyExists":
      return { key: "explorer.error.alreadyExists", values: { name } };
    case "notFound":
      return { key: "explorer.error.notFound", values: { name } };
    default: {
      const details = kind === "failed" ? (error as { details: string }).details : String(error);
      return { key: "explorer.error.failed", values: { name, details } };
    }
  }
}

/** Der volle Windows-Pfad eines Eintrags im Projekt; ein leerer Pfad meint den Projektordner. */
export function absolutePath(project: string, path: string): string {
  if (path === "") return project;
  return `${project.replace(/[\\/]+$/, "")}\\${path.replaceAll("/", "\\")}`;
}

/** Der Pfad relativ zum Projektordner in Windows-Schreibweise, wie ihn VS Code kopiert. */
export function relativePath(path: string): string {
  return path.replaceAll("/", "\\");
}

/**
 * So viele Zeichen des Namens sind beim Umbenennen vorausgewählt: bei Dateien
 * der Teil vor der Endung, damit sie beim Tippen erhalten bleibt.
 */
export function renameSelectionLength(name: string, kind: Entry["kind"]): number {
  const dot = name.lastIndexOf(".");
  return kind === "file" && dot > 0 ? dot : name.length;
}
