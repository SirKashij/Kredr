/**
 * Der Fensterinhalt und die Aufteilung eines Fensters an einer Stelle: Nur
 * hier ändern sie sich. Der Store lädt die gespeicherte Aufteilung, wenn das
 * Fenster ein Projekt oder einen Workspace zeigt, speichert sie laufend und
 * führt die Aktionen am Fensterinhalt aus. Er stellt keine Dialoge; was er
 * tat, sagt jede Aktion in ihrer Antwort.
 *
 * Auf die Reihenfolge kommt es an: Was an der Aufteilung aussteht, wird
 * gespeichert, bevor der Kern den Fensterinhalt ändert. Davon hängt ab, dass
 * jedes Gespräch genau einmal fortgesetzt wird (ADR 0004).
 */

import { invoke } from "@tauri-apps/api/core";
import {
  emptyArrangement,
  filePathOf,
  openTab,
  restoreArrangement,
  tabsOf,
  type Arrangement,
  type RestoreOptions,
  type Tab,
} from "./arrangement";
import {
  addProject,
  firstProject,
  keepConversations,
  moveProject,
  projectsOf,
  removeProject,
  renameWorkspace,
  startPage,
  type WindowContent,
} from "./workspace";

/** Was der Kern auf „Projekt hinzufügen“ antwortet. */
export type AddProjectReply = { kind: "added"; content: WindowContent } | { kind: "openElsewhere" };
/** Was der Kern auf „Workspace öffnen“ antwortet. */
export type OpenWorkspaceReply =
  { kind: "opened"; content: WindowContent } | { kind: "openElsewhere" };

/**
 * Die Befehle des Kerns, die der Store braucht. In der App ruft jeder
 * `invoke` auf (`tauriWindowCore`), im Test ist es ein Kern im Speicher.
 */
export interface WindowCore {
  /** Öffnet den Ordner als Projekt; `null`, wenn er in einem anderen Fenster offen ist. */
  openProject(folder: string): Promise<WindowContent | null>;
  openWorkspace(id: string): Promise<OpenWorkspaceReply>;
  /** Gibt dem Fenster den Workspace `content`, der ein Projekt mehr hat. */
  addProject(content: WindowContent): Promise<AddProjectReply>;
  /** Entfernt das Projekt und speichert den Workspace mit `arrangement`. */
  removeProject(project: string, arrangement: Arrangement): Promise<WindowContent>;
  reorderProjects(projects: readonly string[]): Promise<WindowContent>;
  renameWorkspace(name: string): Promise<WindowContent>;
  closeWorkspace(): Promise<void>;
  /** Die gespeicherte Aufteilung dessen, was das Fenster zeigt, im gespeicherten Format. */
  loadArrangement(): Promise<unknown>;
  /** Speichert die Aufteilung dessen, was das Fenster zeigt, mit der Fenstergeometrie. */
  saveArrangement(arrangement: Arrangement): Promise<void>;
  /** Die gespeicherte Aufteilung des Projekts, gleich welches Fenster es zeigt. */
  loadProjectArrangement(project: string): Promise<unknown>;
  saveProjectArrangement(project: string, arrangement: Arrangement): Promise<void>;
  /** Welche der Pfade (relativ zum Projekt oder voll) es gibt, in derselben Reihenfolge. */
  filesExist(project: string, paths: readonly string[]): Promise<boolean[]>;
  /** Die Ordner unter den Pfaden; Dateien und fehlende Pfade fallen weg. */
  foldersAmong(paths: readonly string[]): Promise<string[]>;
}

/** Der Kern der App: jeder Eintrag ein Befehl über `invoke`. */
export const tauriWindowCore: WindowCore = {
  openProject: (path) => invoke("open_project", { path }),
  openWorkspace: (id) => invoke("open_workspace", { id }),
  addProject: (content) => invoke("add_project", { content }),
  removeProject: (project, arrangement) => invoke("remove_project", { project, arrangement }),
  reorderProjects: (projects) => invoke("reorder_projects", { projects }),
  renameWorkspace: (name) => invoke("rename_workspace", { name }),
  closeWorkspace: () => invoke("close_workspace"),
  loadArrangement: () => invoke("arrangement_load"),
  saveArrangement: (arrangement) => invoke("arrangement_save", { arrangement }),
  loadProjectArrangement: (project) => invoke("project_arrangement_load", { project }),
  saveProjectArrangement: (project, arrangement) =>
    invoke("project_arrangement_save", { project, arrangement }),
  filesExist: (project, paths) => invoke("project_files_exist", { project, paths }),
  foldersAmong: (paths) => invoke("folders_among", { paths }),
};

/** Fragt, welche der Pfade es gibt; die Antwort in derselben Reihenfolge. */
type ExistenceCheck = (paths: string[]) => Promise<boolean[]>;

/**
 * Stellt die gespeicherte Aufteilung wieder her und lässt dabei aus, was es
 * laut `exist` nicht mehr gibt: Dateiansichten ohne Datei, Startordner ohne Ordner.
 */
export async function restoreStored(
  stored: unknown,
  exist: ExistenceCheck,
  options?: RestoreOptions,
): Promise<Arrangement> {
  const paths = [
    ...new Set(
      tabsOf(restoreArrangement(stored)).flatMap((tab) => [tab.cwd, filePathOf(tab)] as const),
    ),
  ].filter((path) => path !== undefined);
  if (paths.length === 0) return restoreArrangement(stored, undefined, options);
  const found = await exist(paths);
  const present = new Set(paths.filter((_, index) => found[index]));
  return restoreArrangement(stored, (path) => present.has(path), options);
}

/**
 * Speichert die Aufteilung laufend, damit sie auch einen Absturz übersteht:
 * kurz nach jeder Änderung, viele Änderungen hintereinander (Ziehen einer
 * Trennlinie, Verschieben des Fensters) als eine.
 */
export class ArrangementSaver {
  private latest: Arrangement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly save: (arrangement: Arrangement) => Promise<void>,
    private readonly delay = 500,
  ) {}

  /** Die Aufteilung hat sich geändert. */
  changed(arrangement: Arrangement) {
    this.latest = arrangement;
    this.schedule();
  }

  /** Größe oder Position des Fensters hat sich geändert; sie wird mit der Aufteilung gespeichert. */
  windowChanged() {
    if (this.latest) this.schedule();
  }

  /** Speichert sofort, was noch aussteht. */
  async flush(): Promise<void> {
    if (this.timer === null || !this.latest) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.save(this.latest);
    } catch (reason) {
      // Die Arbeit geht weiter; die nächste Änderung speichert erneut.
      console.error(reason);
    }
  }

  /** Verwirft, was aussteht, und speichert nichts mehr bis zur nächsten Änderung. */
  forget() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
  }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }
}

/** Der neue Pfad einer offenen Datei. */
export type Renaming = readonly [from: string, to: string];

/** Was das Fenster zeigt; wird nie verändert, nur ersetzt. */
export interface WindowSnapshot {
  content: WindowContent;
  arrangement: Arrangement;
  /** Ob die gespeicherte Aufteilung geladen ist; erst dann wird gezeigt und gespeichert. */
  restored: boolean;
}

/** Wonach der Store fragt, bevor Tabs schließen. */
export type ClosingQuestion =
  /** „Projekt aus Workspace entfernen“ schlösse diese Tabs. */
  | { kind: "removeProject"; project: string; closing: readonly Tab[] }
  /** „Workspace schließen“ schlösse alle Tabs. */
  | { kind: "closeWorkspace" };

/** Was der Store zum Entstehen braucht. */
export interface WindowStoreOptions {
  core: WindowCore;
  settings: () => RestoreOptions;
  /** Gibt neu entstandenen Terminals die Standard-Shell; beim Laden angewandt. */
  settle: (arrangement: Arrangement) => Arrangement;
  /** Der Name eines neuen Workspace. */
  untitledName: () => string;
  /** Setzt die Agenten der geladenen Aufteilung fort; genau einmal je Laden. */
  resume: (stored: Arrangement, project: string) => void;
  /** „Diese Tabs würden schließen, darf ich?“; `true` heißt ja. */
  mayClose: (question: ClosingQuestion) => Promise<boolean>;
  /**
   * Offene Dateien bekommen einen neuen Pfad (vorher, nachher). Wird
   * aufgerufen, bevor die Aufteilung die neuen Pfade zeigt, damit keine
   * Datei dazwischen als geschlossen gilt.
   */
  renameFiles: (renamed: readonly Renaming[]) => void;
}

/** Was „Projekt öffnen“ und „Workspace öffnen“ ergeben. */
export type OpenOutcome =
  | { kind: "opened" }
  /** Ein Projekt ist schon in einem anderen Fenster offen; jenes ist jetzt vorn. */
  | { kind: "openElsewhere" }
  | { kind: "failed"; details: string };

/** Was „Projekt hinzufügen“ ergibt. */
export type AddOutcome =
  | { kind: "added" }
  /** Aus dem Projekt `from` wurde der Workspace `name`, der die laufende Aufteilung übernahm. */
  | { kind: "becameWorkspace"; from: string; name: string }
  | { kind: "alreadyContained" }
  /** Das Projekt ist schon in einem anderen Fenster offen; jenes ist jetzt vorn. */
  | { kind: "openElsewhere" }
  | { kind: "failed"; details: string };

/** Was „Workspace umbenennen“ ergibt. */
export type RenameOutcome =
  { kind: "renamed" } | { kind: "unchanged" } | { kind: "failed"; details: string };

/** Was „Projekt umsortieren“ ergibt. */
export type MoveOutcome =
  /** `renamed`: offene Dateien, deren Pfad sich änderte (vorher, nachher). */
  | { kind: "moved"; renamed: Renaming[] }
  | { kind: "unchanged" }
  | { kind: "failed"; details: string };

/** Was „Projekt entfernen“ und „Workspace schließen“ ergeben. */
export type CloseOutcome<Done extends string> =
  | { kind: Done }
  | { kind: "unchanged" }
  /** Die Person hat die Rückfrage verneint. */
  | { kind: "declined" }
  | { kind: "failed"; details: string };

/** Ein laufendes Laden der gespeicherten Aufteilung. */
interface Loading {
  stale: boolean;
  done: boolean;
}

/**
 * Hält Fensterinhalt und Aufteilung eines Fensters. Jede Änderung ergibt
 * einen neuen Stand und benachrichtigt die Abonnenten.
 */
export class WindowStore {
  private state: WindowSnapshot = {
    content: startPage,
    arrangement: emptyArrangement,
    restored: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly saver: ArrangementSaver;
  /** Das Projekt oder der Workspace, dessen gespeicherte Aufteilung geladen ist. */
  private loadedFor: string | null = null;
  /** Wofür zuletzt geladen wurde: Eigentümer der Aufteilung und ob es ein Projekt gab. */
  private loadKey = "";
  private loading: Loading | null = null;

  constructor(private readonly options: WindowStoreOptions) {
    this.saver = new ArrangementSaver((arrangement) => options.core.saveArrangement(arrangement));
  }

  /** Der aktuelle Stand. */
  snapshot = (): WindowSnapshot => this.state;

  /** Ruft `listener` nach jeder Änderung auf; liefert die Abmeldung. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Wendet eine Operation auf die Aufteilung an. */
  change = (op: (arrangement: Arrangement) => Arrangement) => {
    const arrangement = op(this.state.arrangement);
    if (arrangement !== this.state.arrangement) this.replace({ arrangement });
  };

  /** Das Fenster zeigt `content`, etwa nachdem ein weiterer Start von Kredr es gefüllt hat. */
  show(content: WindowContent) {
    this.replace({ content });
  }

  /** Was das Fenster beim Start zeigt; gilt nur, solange es noch die Startseite zeigt. */
  showInitial(content: WindowContent) {
    if (this.state.content.kind === "startPage") this.show(content);
  }

  /** Größe oder Position des Fensters hat sich geändert. */
  windowChanged() {
    this.saver.windowChanged();
  }

  /** Speichert sofort, was an der Aufteilung aussteht. */
  flush(): Promise<void> {
    return this.saver.flush();
  }

  /** Öffnet den Ordner als Projekt in diesem Fenster. */
  async open(folder: string): Promise<OpenOutcome> {
    try {
      const opened = await this.options.core.openProject(folder);
      if (!opened) return { kind: "openElsewhere" };
      this.show(opened);
      return { kind: "opened" };
    } catch (reason) {
      return failed(reason);
    }
  }

  /** Öffnet den gespeicherten Workspace in diesem Fenster. */
  async openWorkspace(id: string): Promise<OpenOutcome> {
    try {
      const reply = await this.options.core.openWorkspace(id);
      if (reply.kind === "openElsewhere") return reply;
      this.show(reply.content);
      return { kind: "opened" };
    } catch (reason) {
      return failed(reason);
    }
  }

  /**
   * „Projekt zum Workspace hinzufügen…“: hinten an. Aus einem Projektfenster
   * wird dabei der Workspace „Unbenannt“, der die laufende Aufteilung übernimmt.
   */
  async add(folder: string): Promise<AddOutcome> {
    const { core, untitledName } = this.options;
    const content = this.state.content;
    const result = addProject(content, folder, { id: crypto.randomUUID(), name: untitledName() });
    if (result.kind === "refused") return { kind: "alreadyContained" };
    // Was an der Aufteilung noch aussteht, gehört zum Projekt, bevor der Workspace sie übernimmt.
    await this.flush();
    try {
      const reply = await core.addProject(result.content);
      if (reply.kind === "openElsewhere") return reply;
      const next = reply.content;
      const becameWorkspace = content.kind === "project" && next.kind === "workspace";
      // Der neue Workspace übernimmt die laufende Aufteilung, statt seine zu laden.
      if (becameWorkspace) this.loadedFor = next.id;
      this.show(next);
      return becameWorkspace
        ? { kind: "becameWorkspace", from: content.path, name: next.name }
        : { kind: "added" };
    } catch (reason) {
      return failed(reason);
    }
  }

  /**
   * Aus dem Windows-Explorer gezogen: Die Ordner unter `paths` kommen
   * nacheinander hinzu, Dateien nicht. Auf der Startseite nichts.
   */
  async addFolders(
    paths: readonly string[],
  ): Promise<Array<{ folder: string; outcome: AddOutcome }>> {
    if (this.state.content.kind === "startPage") return [];
    let folders: string[];
    try {
      folders = await this.options.core.foldersAmong(paths);
    } catch (reason) {
      console.error(reason);
      return [];
    }
    const outcomes = [];
    for (const folder of folders) outcomes.push({ folder, outcome: await this.add(folder) });
    return outcomes;
  }

  /** Gibt dem Workspace den neuen Namen; ein leerer oder gleicher Name ändert nichts. */
  async rename(name: string): Promise<RenameOutcome> {
    if (!renameWorkspace(this.state.content, name)) return { kind: "unchanged" };
    // Was noch aussteht, darf den neuen Namen nicht mit dem alten überschreiben.
    await this.flush();
    try {
      this.show(await this.options.core.renameWorkspace(name));
      return { kind: "renamed" };
    } catch (reason) {
      return failed(reason);
    }
  }

  /**
   * Setzt das Projekt an die Stelle `index` unter den Projekten. Rückt dabei
   * ein anderes Projekt an die erste Stelle, bleiben die Tabs des bisherigen
   * ersten Projekts bei diesem, offene Dateien samt ungespeicherten Änderungen.
   */
  async move(folder: string, index: number): Promise<MoveOutcome> {
    const planned = moveProject(this.state.content, this.state.arrangement, folder, index);
    if (!planned) return { kind: "unchanged" };
    await this.flush();
    try {
      const next = await this.options.core.reorderProjects(projectsOf(planned.content));
      // Während der Antwort kann sich die Aufteilung geändert haben; verschoben wird der neue Stand.
      const before = this.state.arrangement;
      const moved = moveProject(this.state.content, before, folder, index);
      const renamed: Renaming[] = [];
      if (moved) {
        const after = tabsOf(moved.arrangement).map(filePathOf);
        tabsOf(before).forEach((tab, position) => {
          const from = filePathOf(tab);
          const to = after[position];
          if (from !== undefined && to !== undefined && from !== to) renamed.push([from, to]);
        });
        this.options.renameFiles(renamed);
      }
      this.replace({ content: next, arrangement: moved?.arrangement ?? before });
      return { kind: "moved", renamed };
    } catch (reason) {
      return failed(reason);
    }
  }

  /**
   * „Projekt aus Workspace entfernen“: Terminals und Tabs des Projekts
   * schließen, nachdem die Person es erlaubt hat. Die Gespräche seiner
   * Agenten kommen in die eigene Aufteilung des Projekts und gehen beim
   * nächsten Öffnen dort weiter.
   */
  async remove(folder: string): Promise<CloseOutcome<"removed">> {
    const { core, mayClose } = this.options;
    const removal = removeProject(this.state.content, this.state.arrangement, folder);
    if (!removal) return { kind: "unchanged" };
    const allowed = await mayClose({
      kind: "removeProject",
      project: folder,
      closing: removal.closing,
    });
    if (!allowed) return { kind: "declined" };
    // Während der Rückfrage können sich Fensterinhalt und Aufteilung geändert haben.
    const before = this.state.content;
    const confirmed = removeProject(before, this.state.arrangement, folder);
    if (!confirmed) return { kind: "unchanged" };
    try {
      const raw = await core.loadProjectArrangement(folder);
      const stored = restoreArrangement(raw, undefined, { resumeAgents: true });
      const withConversations = keepConversations(stored, confirmed.closing, folder);
      if (withConversations !== stored) {
        await core.saveProjectArrangement(folder, withConversations);
      }
      // Was noch aussteht, darf den Workspace ohne das Projekt nicht überschreiben.
      await this.flush();
      const next = await core.removeProject(folder, confirmed.arrangement);
      const current = this.state.arrangement;
      this.replace({
        content: next,
        arrangement: removeProject(before, current, folder)?.arrangement ?? current,
      });
      return { kind: "removed" };
    } catch (reason) {
      return failed(reason);
    }
  }

  /**
   * „Workspace schließen“: Das Fenster zeigt danach die Startseite, wenn die
   * Person es erlaubt hat. Die Aufteilung ist gespeichert; beim nächsten
   * Öffnen kommt der Workspace mit seinen Agenten zurück.
   */
  async closeWorkspace(): Promise<CloseOutcome<"closed">> {
    if (this.state.content.kind !== "workspace") return { kind: "unchanged" };
    if (!(await this.options.mayClose({ kind: "closeWorkspace" }))) return { kind: "declined" };
    await this.flush();
    try {
      await this.options.core.closeWorkspace();
    } catch (reason) {
      return failed(reason);
    }
    // Ab hier speichert das Fenster nichts mehr; die Tabs schließen, ihre Terminals enden.
    this.saver.forget();
    this.loadedFor = null;
    this.replace({ content: startPage, arrangement: emptyArrangement, restored: false });
    return { kind: "closed" };
  }

  /** Ersetzt Teile des Stands, speichert und lädt, was dazu nötig ist, und meldet die Änderung. */
  private replace(change: Partial<WindowSnapshot>) {
    const previous = this.state;
    this.state = { ...previous, ...change };
    if (this.state.restored && this.state.arrangement !== previous.arrangement) {
      this.saver.changed(this.state.arrangement);
    }
    if (this.state.content !== previous.content) this.loadIfNeeded();
    for (const listener of this.listeners) listener();
  }

  /**
   * Ein Projekt öffnet sich mit seiner gespeicherten Aufteilung; ohne sie
   * beginnt es mit einem Terminal. Geladen wird einmal je Projekt bzw.
   * Workspace: Ein Workspace, der aus dem Projektfenster entsteht, übernimmt
   * die laufende Aufteilung, und wird sein erstes Projekt entfernt, lädt er
   * nichts neu.
   */
  private loadIfNeeded() {
    const { content } = this.state;
    const project = firstProject(content);
    const owner = content.kind === "workspace" ? content.id : project;
    const key = `${owner}\n${project !== null}`;
    if (key !== this.loadKey) {
      this.loadKey = key;
      // Ein abgebrochenes Laden zählt nicht; das nächste lädt erneut.
      if (this.loading && !this.loading.done) {
        this.loading.stale = true;
        this.loadedFor = null;
      }
      this.loading = null;
    }
    if (!project || this.loadedFor === owner) return;
    this.loadedFor = owner;
    const loading: Loading = { stale: false, done: false };
    this.loading = loading;
    void this.load(project).then((stored) => {
      if (loading.stale) return;
      loading.done = true;
      this.restore(stored, project);
    });
  }

  /** Lädt die gespeicherte Aufteilung; ist der Speicher nicht erreichbar, die leere. */
  private async load(project: string): Promise<Arrangement> {
    const { core, settings } = this.options;
    try {
      const stored = await core.loadArrangement();
      return await restoreStored(stored, (paths) => core.filesExist(project, paths), settings());
    } catch (reason) {
      // Ein Projekt öffnet sich auch, wenn sein Speicher nicht erreichbar ist.
      console.error(reason);
      return restoreArrangement(null);
    }
  }

  /**
   * Übernimmt die geladene Aufteilung. Ist schon ein Terminal entstanden,
   * bleibt sie ungenutzt. Gemerkte Agenten starten sofort und gleichzeitig,
   * auch in verdeckten Tabs, und setzen ihr Gespräch fort.
   */
  private restore(stored: Arrangement, project: string) {
    const current = this.state.arrangement;
    const adopted = !current.root;
    const arrangement = adopted
      ? this.options.settle(stored.root ? stored : openTab(current))
      : current;
    this.replace({ arrangement, restored: true });
    // Auch ohne Änderung gilt die geladene Aufteilung ab jetzt als gespeichert.
    this.saver.changed(arrangement);
    if (adopted) this.options.resume(stored, project);
  }
}

function failed(reason: unknown): { kind: "failed"; details: string } {
  return { kind: "failed", details: String(reason) };
}
