import { invoke } from "@tauri-apps/api/core";
import { emptyIndex, indexFiles, type FileIndex } from "./fileNameSearch";
import { pathKey } from "./filePath";
import { watchProjectFiles, type ProjectChanges } from "./projectFiles";
import { workspaceFiles, type WorkspaceFile } from "./workspace";

/** Woher die Dateiliste kommt; in Tests ein Projektordner im Speicher. */
export interface FileListSource {
  /** Alle nicht ignorierten Dateien des Projekts, relativ zum Projektordner. */
  list(project: string): Promise<string[]>;
  watch(project: string, listener: (changes: ProjectChanges) => void): () => void;
}

const core: FileListSource = {
  list: (project) => invoke<string[]>("project_files_list_all", { project }),
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

/** Die Dateien aller Projekte eines Fensters, für die Suche vorbereitet. */
export interface WorkspaceFileSnapshot {
  /** In der Reihenfolge des Workspace. */
  files: WorkspaceFile[];
  /** Dieselben Dateien; die Schlüssel sind die von `files`. */
  index: FileIndex;
}

const emptySnapshot: WorkspaceFileSnapshot = { files: [], index: emptyIndex };

/**
 * Die Dateilisten aller Projekte eines Fensters für „Datei per Namen
 * öffnen“: je Projekt eine `ProjectFileList`, die wie dort liest. Kommt ein
 * Projekt hinzu, beginnt seine Liste; fällt eines weg, endet seine.
 */
export class WorkspaceFileList {
  private projects: string[] = [];
  /** Je Projekt, erkannt an seinem Pfadschlüssel, die Liste und wie sie endet. */
  private readonly lists = new Map<string, { list: ProjectFileList; close: () => void }>();
  private readonly listeners = new Set<() => void>();
  /** Je Liste, wie das Zusehen endet, solange jemand zusieht. */
  private readonly watching = new Map<ProjectFileList, () => void>();
  private current = emptySnapshot;
  /** Aus welchen Projekten und Ständen ihrer Listen `current` entstand. */
  private builtFrom: { projects: readonly string[]; indexes: readonly FileIndex[] } = {
    projects: [],
    indexes: [],
  };

  constructor(private readonly source: FileListSource = core) {}

  /** Folgt genau diesen Projekten in dieser Reihenfolge. */
  follow(projects: readonly string[]) {
    const wanted = new Set(projects.map(pathKey));
    for (const [key, { list, close }] of this.lists) {
      if (wanted.has(key)) continue;
      this.lists.delete(key);
      this.watching.get(list)?.();
      this.watching.delete(list);
      close();
    }
    for (const project of projects) {
      const key = pathKey(project);
      if (this.lists.has(key)) continue;
      const list = new ProjectFileList(this.source);
      this.lists.set(key, { list, close: list.open(project) });
      if (this.listeners.size > 0) this.watch(list);
    }
    this.projects = [...projects];
    this.listeners.forEach((notify) => notify());
  }

  /** Der zuletzt gelesene Stand; derselbe, solange sich nichts ändert. */
  get snapshot(): WorkspaceFileSnapshot {
    const { projects } = this;
    const indexes = projects.map((project) => this.lists.get(pathKey(project))!.list.index);
    // `follow` setzt jedes Mal eine neue Projektliste.
    const unchanged =
      projects === this.builtFrom.projects &&
      indexes.every((index, position) => index === this.builtFrom.indexes[position]);
    if (unchanged) return this.current;
    const files = workspaceFiles(projects, (project) => indexes[projects.indexOf(project)].paths);
    this.builtFrom = { projects, indexes };
    this.current = {
      files,
      index: indexFiles(
        files.map((file) => file.path),
        files.map((file) => file.key),
      ),
    };
    return this.current;
  }

  /** Sieht allen Dateilisten zu: `listener` läuft nach jedem neuen Stand. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) for (const { list } of this.lists.values()) this.watch(list);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.watching.forEach((stop) => stop());
      this.watching.clear();
    };
  };

  private watch(list: ProjectFileList) {
    this.watching.set(
      list,
      list.subscribe(() => this.listeners.forEach((notify) => notify())),
    );
  }
}
