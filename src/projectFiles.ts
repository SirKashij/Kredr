import { Channel, invoke } from "@tauri-apps/api/core";

/** Ein Eintrag eines Ordners, wie ihn das Kern-Modul Projektdateien liefert. */
export interface Entry {
  name: string;
  kind: "folder" | "file";
}

/** Was sich im Projektordner innerhalb eines Zeitfensters geändert hat. */
export interface ProjectChanges {
  /**
   * Angelegte, geänderte, umbenannte (alter und neuer Name) und gelöschte
   * Dateien und Ordner; relativ zum Projektordner und mit `/` getrennt.
   */
  paths: string[];
  /** Es ist mehr passiert, als einzeln gemeldet wurde; `paths` ist leer und alles neu zu lesen. */
  rescan: boolean;
}

type Listener = (changes: ProjectChanges) => void;

/**
 * Liest die Einträge eines Ordners im Projekt, in beliebiger Reihenfolge.
 * `folder` ist relativ zum Projektordner und für diesen selbst leer.
 */
export function listFolder(project: string, folder: string): Promise<Entry[]> {
  return invoke<Entry[]>("project_files_list_folder", { project, folder });
}

/** Je Projekt ein Abonnement im Kern, das sich alle Zuhörer des Fensters teilen. */
const streams = new Map<string, { listeners: Set<Listener>; id: Promise<number> }>();

/**
 * Abonniert den entprellten Ereignisstrom des Projekts. Explorer,
 * Dateiansicht und Versionskontrolle hängen am selben Strom. Der Rückgabewert
 * beendet das Abonnement.
 */
export function watchProjectFiles(project: string, listener: Listener): () => void {
  let stream = streams.get(project);
  if (!stream) {
    const listeners = new Set<Listener>();
    const onChange = new Channel<ProjectChanges>();
    onChange.onmessage = (changes) => listeners.forEach((notify) => notify(changes));
    stream = { listeners, id: invoke<number>("project_files_watch", { project, onChange }) };
    stream.id.catch((reason) => console.error(reason));
    streams.set(project, stream);
  }
  const { listeners, id } = stream;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || streams.get(project) !== stream) return;
    streams.delete(project);
    id.then((id) => invoke("project_files_unwatch", { id })).catch(() => {});
  };
}
