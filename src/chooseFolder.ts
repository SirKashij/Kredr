import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Lässt die Person einen Ordner wählen; `null`, wenn sie abbricht. Hat die
 * Entwicklungsfassung eine Antwort vorbereitet (`KREDR_TEST_FOLDERS`), gilt
 * diese, und der Windows-Dialog erscheint nicht.
 */
export async function chooseFolder(title: string): Promise<string | null> {
  const prepared = await invoke<string | null>("dialog_answer");
  if (prepared !== null) return prepared;
  return open({ directory: true, title });
}
