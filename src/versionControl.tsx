import { Channel, invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { BranchRow } from "./branches";
import type { Commit, CommitFile, ShownCommitFile } from "./commitHistory";
import type { FileContent } from "./fileState";
import {
  followSelection,
  type ChangedFile,
  type Operation,
  type VersionControlError,
  type VersionControlState,
} from "./versionControlState";

/** Eine Fassung einer Datei im Diff, wie sie das Kern-Modul liefert. */
export type Version = Exclude<FileContent, { kind: "error" }>;

/** Die beiden Fassungen einer Datei, die ein Diff gegenüberstellt. */
export interface Diff {
  original: Version;
  modified: Version;
}

/** Liest die beiden Fassungen für den Diff einer Änderung; scheitert mit einem `VersionControlError`. */
export function loadDiff(project: string, file: ChangedFile): Promise<Diff> {
  return invoke<Diff>("version_control_diff", { project, file });
}

/** Liest Commits des aktuellen Branches, die neuesten zuerst; scheitert mit einem `VersionControlError`. */
export function loadCommits(project: string, skip: number, limit: number): Promise<Commit[]> {
  return invoke<Commit[]>("version_control_commits", { project, skip, limit });
}

/** Liest die Dateien, die ein Commit geändert hat. */
export function loadCommitFiles(project: string, commit: string): Promise<CommitFile[]> {
  return invoke<CommitFile[]>("version_control_commit_files", { project, commit });
}

/** Liest die beiden Fassungen für den Diff einer Datei eines Commits. */
export function loadCommitDiff(project: string, commit: string, file: CommitFile): Promise<Diff> {
  return invoke<Diff>("version_control_commit_diff", { project, commit, file });
}

/** Was die Versionskontrolle eines Fensters gerade weiß und zeigt. */
export interface VersionControlSnapshot {
  /** Der Ordner des Projekts; `null`, solange das Fenster keines hat. */
  project: string | null;
  /** Der Zustand des Projekts; `null`, bis der Kern ihn zum ersten Mal gemeldet hat. */
  state: VersionControlState | null;
  /** Die Änderung, deren Diff der Tab „Versionskontrolle“ zeigt. */
  selected: ChangedFile | null;
  /** Die Datei eines Commits aus dem Verlauf, deren Diff der Tab stattdessen zeigt. */
  commitFile: ShownCommitFile | null;
  /** Die eingegebene Commit-Nachricht. */
  message: string;
  /** Was gerade ausgeführt wird; solange sind alle Knöpfe gesperrt. */
  busy: Operation | null;
  /** Warum die letzte Operation scheiterte; `null` nach einer gelungenen. */
  failure: VersionControlError | null;
}

/** Ein Aufruf an den Kern; Tests antworten an seiner Stelle. */
export type CoreCall = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Die Versionskontrolle eines Fensters: die eine Stelle der Oberfläche, die
 * den Zustand des Kerns abonniert. Seitenleiste, Symbolleiste, Statusleiste,
 * der Tab „Versionskontrolle“ und der Explorer lesen ihn von hier.
 */
export class VersionControlStore {
  private current: VersionControlSnapshot = {
    project: null,
    state: null,
    selected: null,
    commitFile: null,
    message: "",
    busy: null,
    failure: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly call: CoreCall = invoke,
    project: string | null = null,
  ) {
    this.current = { ...this.current, project };
  }

  /** Der aktuelle Stand; er wird nie verändert, nur ersetzt. */
  snapshot = (): VersionControlSnapshot => this.current;

  /** Ruft `listener` nach jeder Änderung auf; liefert die Abmeldung. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Folgt dem Zustand des Projekts, bis der Rückgabewert aufgerufen wird. */
  watch(project: string): () => void {
    let stopped = false;
    this.replace({
      ...this.current,
      project,
      state: null,
      selected: null,
      commitFile: null,
      message: "",
      failure: null,
    });
    const onState = new Channel<VersionControlState>();
    onState.onmessage = (state) => {
      if (stopped) return;
      // Die gezeigte Änderung folgt dem Zustand: Nach einem Commit ist sie weg.
      this.replace({
        ...this.current,
        state,
        selected: followSelection(this.current.selected, state),
      });
    };
    const id = invoke<number>("version_control_watch", { project, onState });
    id.catch((reason) => console.error(reason));
    return () => {
      stopped = true;
      id.then((id) => invoke("version_control_unwatch", { id })).catch(() => {});
      // Folgt keine andere Beobachtung, zeigt nichts mehr den alten Stand.
      if (this.current.project === project) {
        this.replace({
          ...this.current,
          project: null,
          state: null,
          selected: null,
          commitFile: null,
          message: "",
          failure: null,
        });
      }
    };
  }

  /** Wählt die Änderung, deren Diff gezeigt wird. */
  select(file: ChangedFile) {
    this.replace({ ...this.current, selected: file, commitFile: null });
  }

  /** Zeigt statt einer Änderung den Diff einer Datei eines Commits aus dem Verlauf. */
  showCommitFile(shown: ShownCommitFile) {
    this.replace({ ...this.current, selected: null, commitFile: shown });
  }

  /** Zeigt weder Änderung noch Datei eines Commits mehr, weil ein anderes Repository es tut. */
  deselect() {
    if (this.current.selected === null && this.current.commitFile === null) return;
    this.replace({ ...this.current, selected: null, commitFile: null });
  }

  setMessage(message: string) {
    this.replace({ ...this.current, message });
  }

  /** Blendet die Meldung der letzten gescheiterten Operation aus. */
  dismissFailure() {
    this.replace({ ...this.current, failure: null });
  }

  /** Wählt die Änderungen zum Festschreiben aus; ohne Angabe alle. */
  stage(files?: ChangedFile[]): Promise<boolean> {
    return this.run("stage", "version_control_stage", { files: files ?? null });
  }

  /** Wählt die Änderungen wieder ab; ohne Angabe alle. */
  unstage(files?: ChangedFile[]): Promise<boolean> {
    return this.run("unstage", "version_control_unstage", { files: files ?? null });
  }

  /** Verwirft die Änderung; die Rückfrage stellt der Aufrufer vorher. */
  discard(file: ChangedFile): Promise<boolean> {
    return this.run("discard", "version_control_discard", { file });
  }

  /** Schreibt mit der eingegebenen Nachricht fest. */
  commit(): Promise<boolean> {
    const { message } = this.current;
    return this.run("commit", "version_control_commit", { message }, () => this.setMessage(""));
  }

  /** „Commit & Push“: ein Schritt im Kern. Scheitert nur der Push, bleibt der Commit. */
  commitAndPush(): Promise<boolean> {
    const { message } = this.current;
    return this.run("commitAndPush", "version_control_commit_and_push", { message }, (result) => {
      const { pushError } = result as { pushError: VersionControlError | null };
      this.replace({ ...this.current, message: "", failure: pushError });
    });
  }

  push(): Promise<boolean> {
    return this.run("push", "version_control_push", {});
  }

  pull(): Promise<boolean> {
    return this.run("pull", "version_control_pull", {});
  }

  /** „Erst holen, dann pushen“: der Ausweg nach einem abgelehnten Push. */
  pullAndPush(): Promise<boolean> {
    return this.run("pullAndPush", "version_control_pull_and_push", {});
  }

  /**
   * Führt die gewählte Zeile der Branch-Liste aus: wechselt zum Branch oder
   * legt den neuen an und wechselt dorthin. Gesperrt wie jede Operation:
   * `false` heißt, es lief bereits eine, und nichts ist geschehen. Scheitert
   * mit einem `VersionControlError`, den die Branch-Liste zeigt.
   */
  async changeBranch(row: BranchRow): Promise<boolean> {
    let failure: VersionControlError | null = null;
    const fail = (error: VersionControlError) => {
      failure = error;
    };
    const ran =
      row.kind === "create"
        ? await this.run(
            "changeBranch",
            "version_control_create_branch",
            { name: row.name },
            undefined,
            fail,
          )
        : await this.run(
            "changeBranch",
            "version_control_switch_branch",
            { branch: row.branch },
            undefined,
            fail,
          );
    if (failure) throw failure;
    return ran;
  }

  /**
   * Führt eine Operation im Kern aus. Läuft bereits eine, geschieht nichts
   * (Ergebnis `false`): Das schützt vor Doppelklicks und davor, dass sich
   * zwei Git-Aufrufe im selben Repository in die Quere kommen. Das Ergebnis
   * im Repository kommt über den abonnierten Zustand. Ein Scheitern steht
   * danach in `failure`, sofern `onFailed` es nicht anders haben will.
   */
  private async run(
    operation: Operation,
    command: string,
    args: Record<string, unknown>,
    onDone?: (result: unknown) => void,
    onFailed = (failure: VersionControlError) => this.replace({ ...this.current, failure }),
  ): Promise<boolean> {
    const { project, busy } = this.current;
    if (project === null || busy !== null) return false;
    this.replace({ ...this.current, busy: operation, failure: null });
    try {
      const result = await this.call(command, { project, ...args });
      onDone?.(result);
    } catch (reason) {
      onFailed(asError(reason));
    } finally {
      this.replace({ ...this.current, busy: null });
    }
    return true;
  }

  private replace(next: VersionControlSnapshot) {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}

/** Der Kern scheitert mit Grund und Originaltext; alles andere ist ein unerwarteter Fehler. */
function asError(reason: unknown): VersionControlError {
  if (typeof reason === "object" && reason !== null && "reason" in reason && "details" in reason) {
    return reason as VersionControlError;
  }
  return { reason: "failed", details: String(reason) };
}

/** Die Versionskontrolle eines Projekts des Fensters samt ihrem aktuellen Stand. */
export interface ProjectVersionControl {
  project: string;
  store: VersionControlStore;
  snapshot: VersionControlSnapshot;
}

/** Was die Versionskontrolle eines Fensters über alle seine Projekte weiß. */
export interface VersionControlsSnapshot {
  /** Je Projekt des Fensters, in dessen Reihenfolge, seine Versionskontrolle. */
  projects: readonly ProjectVersionControl[];
  /** Das Projekt, dessen Änderung oder Commit-Datei der Tab „Versionskontrolle“ zeigt. */
  shown: string | null;
  /** Ob der Diff beide Fassungen nebeneinander zeigt statt untereinander. */
  sideBySide: boolean;
  /** Das aktive Projekt; ihm folgt der Verlauf ohne eigene Wahl. */
  active: string | null;
  /** Das Repository, das für den Verlauf gewählt wurde; `null` heißt: dem aktiven Projekt folgen. */
  historyChoice: string | null;
}

/**
 * Die Versionskontrolle eines Fensters: eine {@link VersionControlStore} je
 * Projekt, also ein Zustand und eine Commit-Nachricht je Repository. Dazu
 * kommt, was für das ganze Fenster gilt: welcher Diff gezeigt wird und
 * welches Repository der Verlauf zeigt.
 */
export class VersionControls {
  private readonly followed = new Map<string, { store: VersionControlStore; stop: () => void }>();
  private order: readonly string[] = [];
  /** Steht für die Versionskontrolle, solange das Fenster kein Projekt hat. */
  private readonly idle: VersionControlStore;
  private current: VersionControlsSnapshot = {
    projects: [],
    shown: null,
    sideBySide: true,
    active: null,
    historyChoice: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly call: CoreCall = invoke) {
    this.idle = new VersionControlStore(call);
  }

  /** Der aktuelle Stand; er wird nie verändert, nur ersetzt. */
  snapshot = (): VersionControlsSnapshot => this.current;

  /** Ruft `listener` nach jeder Änderung auf, auch der eines Repositorys; liefert die Abmeldung. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Folgt genau diesen Projekten: Neue werden beobachtet, entfernte nicht
   * mehr. Ein bleibendes Projekt behält seinen Zustand und seine Nachricht.
   */
  follow(projects: readonly string[]) {
    for (const [project, { stop }] of this.followed) {
      if (projects.includes(project)) continue;
      stop();
      this.followed.delete(project);
    }
    for (const project of projects) {
      if (this.followed.has(project)) continue;
      const store = new VersionControlStore(this.call);
      const unsubscribe = store.subscribe(() => this.refresh());
      const unwatch = store.watch(project);
      this.followed.set(project, {
        store,
        stop: () => {
          unwatch();
          unsubscribe();
        },
      });
    }
    this.order = [...projects];
    const { shown, historyChoice } = this.current;
    this.refresh({
      shown: shown !== null && this.followed.has(shown) ? shown : null,
      historyChoice:
        historyChoice !== null && this.followed.has(historyChoice) ? historyChoice : null,
    });
  }

  /** Die Versionskontrolle des Projekts; fehlt, wenn das Fenster das Projekt nicht zeigt. */
  store(project: string): VersionControlStore | undefined {
    return this.followed.get(project)?.store;
  }

  /**
   * Die Versionskontrolle des ersten Projekts. Ihr folgen bis auf Weiteres
   * Statusleiste, Branch-Liste und Explorer eines einzelnen Projekts.
   */
  primary(): VersionControlStore {
    return this.current.projects[0]?.store ?? this.idle;
  }

  /** Zeigt den Diff einer Änderung des Projekts; jedes andere Repository zeigt dann keine. */
  select(project: string, file: ChangedFile) {
    this.show(project, (store) => store.select(file));
  }

  /** Zeigt den Diff einer Datei eines Commits des Projekts aus dem Verlauf. */
  showCommitFile(project: string, shown: ShownCommitFile) {
    this.show(project, (store) => store.showCommitFile(shown));
  }

  setSideBySide(sideBySide: boolean) {
    this.refresh({ sideBySide });
  }

  /** Das aktive Projekt; ohne eigene Wahl zeigt der Verlauf dessen Repository. */
  setActive(active: string | null) {
    if (active !== this.current.active) this.refresh({ active });
  }

  /** Wählt das Repository des Verlaufs; `null` folgt wieder dem aktiven Projekt. */
  chooseHistory(project: string | null) {
    this.refresh({ historyChoice: project });
  }

  private show(project: string, change: (store: VersionControlStore) => void) {
    const store = this.store(project);
    if (!store) return;
    for (const [other, followed] of this.followed) {
      if (other !== project) followed.store.deselect();
    }
    change(store);
    this.refresh({ shown: project });
  }

  private refresh(change: Partial<VersionControlsSnapshot> = {}) {
    const projects = this.order.flatMap((project) => {
      const followed = this.followed.get(project);
      return followed
        ? [{ project, store: followed.store, snapshot: followed.store.snapshot() }]
        : [];
    });
    this.current = { ...this.current, ...change, projects };
    for (const listener of this.listeners) listener();
  }
}

const VersionControlsContext = createContext<VersionControls | null>(null);
const VersionControlContext = createContext<VersionControlStore | null>(null);

/**
 * Stellt die Versionskontrolle des Fensters bereit. Darunter meint
 * {@link useVersionControl} die des ersten Projekts, bis ein
 * {@link RepositoryScope} ein anderes Repository wählt.
 */
export function VersionControlProvider({
  controls,
  children,
}: {
  controls: VersionControls;
  children: ReactNode;
}) {
  useSyncExternalStore(controls.subscribe, controls.snapshot);
  return (
    <VersionControlsContext.Provider value={controls}>
      <VersionControlContext.Provider value={controls.primary()}>
        {children}
      </VersionControlContext.Provider>
    </VersionControlsContext.Provider>
  );
}

/** Darunter meint {@link useVersionControl} die Versionskontrolle dieses Repositorys. */
export function RepositoryScope({
  store,
  children,
}: {
  store: VersionControlStore;
  children: ReactNode;
}) {
  return <VersionControlContext.Provider value={store}>{children}</VersionControlContext.Provider>;
}

/** Die Versionskontrolle des Fensters, um etwas auszulösen (Diff zeigen, Verlauf umstellen). */
export function useVersionControls(): VersionControls {
  const controls = useContext(VersionControlsContext);
  if (!controls) throw new Error("VersionControlProvider is missing");
  return controls;
}

/** Der Stand der Versionskontrolle aller Projekte des Fensters. */
export function useVersionControlsSnapshot(): VersionControlsSnapshot {
  const controls = useVersionControls();
  return useSyncExternalStore(controls.subscribe, controls.snapshot);
}

/** Die Versionskontrolle eines Repositorys, um etwas auszulösen (festschreiben, pushen). */
export function useVersionControlStore(): VersionControlStore {
  const store = useContext(VersionControlContext);
  if (!store) throw new Error("VersionControlProvider is missing");
  return store;
}

/**
 * Der Stand der Versionskontrolle eines Repositorys; zeichnet die Komponente
 * bei jeder Änderung neu. Auch der Explorer liest die geänderten Dateien hierüber.
 */
export function useVersionControl(): VersionControlSnapshot {
  const store = useVersionControlStore();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
