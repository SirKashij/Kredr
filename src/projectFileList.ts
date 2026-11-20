import { invoke } from "@tauri-apps/api/core";
import { emptyIndex, indexFiles, type FileIndex } from "./fileSearch";
import { watchProjectFiles, type ProjectChanges } from "./projectFiles";

/** Woher die Dateiliste kommt; in Tests ein Projektordner im Speicher. */
export interface FileListSource {
  /** Alle nicht ignorierten Dateien des Projekts, relativ zum Projektordner. */
  list(project: string): Promise<string[]>;
  watch(project: string, listener: (changes: ProjectChanges) => void): () => void;
}

const core: FileListSource = {
  list: (project) => invoke<string[]>("project_file_list", { project }),
  watch: watchProjectFiles,
};

/**
 * Die Dateiliste des Projekts eines Fensters für „Datei per Namen öffnen“.
 * Sie liegt fertig im Speicher, damit das Eingabefeld sofort Treffer zeigt.
 * Ändert sich etwas im Projektordner, liest sie neu: sofort, solange jemand
 * zusieht, sonst erst beim nächsten Hinsehen. So kostet ein Agent, der
 * laufend Dateien schreibt, nichts, solange niemand eine Datei sucht.
 */
export class ProjectFileList {
  private project: string | null = null;
  private current = emptyIndex;
  private listeners = new Set<() => void>();
  /** Der Projektordner hat sich seit dem letzten Lesen geändert. */
  private stale = false;
  private loading = false;

  constructor(private source: FileListSource = core) {}

  /** Der zuletzt gelesene Stand. */
  get index(): FileIndex {
    return this.current;
  }

  /** Beginnt mit dem Projekt des Fensters; der Rückgabewert beendet es. */
  open(project: string): () => void {
    this.project = project;
    this.stale = true;
    this.load();
    const unwatch = this.source.watch(project, (changes) => {
      // Im Ordner `.git` ändert sich ständig etwas; er gehört nicht zur Dateiliste.
      if (!changes.rescan && changes.paths.every((path) => path.startsWith(".git/"))) return;
      this.stale = true;
      if (this.listeners.size > 0) this.load();
    });
    return () => {
      unwatch();
      if (this.project !== project) return;
      this.project = null;
      this.current = emptyIndex;
    };
  }

  /** Sieht der Dateiliste zu: `listener` läuft nach jedem neuen Stand. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.load();
    return () => this.listeners.delete(listener);
  };

  private load() {
    const project = this.project;
    if (!project || !this.stale || this.loading) return;
    this.stale = false;
    this.loading = true;
    this.source
      .list(project)
      .then((paths) => {
        if (this.project !== project) return;
        this.current = indexFiles(paths);
        this.listeners.forEach((notify) => notify());
      })
      .catch((reason) => console.error(reason))
      .finally(() => {
        this.loading = false;
        // Was sich währenddessen geändert hat, hat dieses Lesen womöglich
        // verpasst; ein inzwischen anderes Projekt wartet noch auf seine Liste.
        if (this.listeners.size > 0 || this.project !== project) this.load();
      });
  }
}
