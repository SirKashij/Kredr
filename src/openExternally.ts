import { invoke } from "@tauri-apps/api/core";
import type { FileTarget } from "./terminalLinks";

/** Öffnet eine Web-Adresse im Standardbrowser. */
export function openUrl(url: string) {
  invoke("open_url", { url }).catch(() => {});
}

/**
 * Öffnet die Datei im Windows-Standardprogramm; Programme und Skripte
 * markiert der Kern stattdessen im Windows-Explorer.
 */
export function openFileExternally(file: FileTarget) {
  invoke("open_file", { path: file.path }).catch(() => {});
}
