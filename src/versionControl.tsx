import { Channel, invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { ShownCommitFile } from "./commitHistory";
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
  /** Ob der Diff beide Fassungen nebeneinander zeigt statt untereinander. */
  sideBySide: boolean;
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
    sideBySide: true,
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

  setSideBySide(sideBySide: boolean) {
    this.replace({ ...this.current, sideBySide });
  }

  setMessage(message: string) {
    this.replace({ ...this.current, message });
  }

  /** Blendet die Meldung der letzten gescheiterten Operation aus. */
  dismissFailure() {
    this.replace({ ...this.current, failure: null });
  }

  /** Wählt die Änderungen zum Festschreiben aus; ohne Angabe alle. */
  stage(files?: ChangedFile[]): Promise<void> {
    return this.run("stage", "version_control_stage", { files: files ?? null });
  }

  /** Wählt die Änderungen wieder ab; ohne Angabe alle. */
  unstage(files?: ChangedFile[]): Promise<void> {
    return this.run("unstage", "version_control_unstage", { files: files ?? null });
  }

  /** Verwirft die Änderung; die Rückfrage stellt der Aufrufer vorher. */
  discard(file: ChangedFile): Promise<void> {
    return this.run("discard", "version_control_discard", { file });
  }

  /** Schreibt mit der eingegebenen Nachricht fest. */
  commit(): Promise<void> {
    const { message } = this.current;
    return this.run("commit", "version_control_commit", { message }, () => this.setMessage(""));
  }

  /** „Commit & Push“: ein Schritt im Kern. Scheitert nur der Push, bleibt der Commit. */
  commitAndPush(): Promise<void> {
    const { message } = this.current;
    return this.run("commitAndPush", "version_control_commit_and_push", { message }, (result) => {
      const { pushError } = result as { pushError: VersionControlError | null };
      this.replace({ ...this.current, message: "", failure: pushError });
    });
  }

  push(): Promise<void> {
    return this.run("push", "version_control_push", {});
  }

  pull(): Promise<void> {
    return this.run("pull", "version_control_pull", {});
  }

  /** „Erst holen, dann pushen“: der Ausweg nach einem abgelehnten Push. */
  pullAndPush(): Promise<void> {
    return this.run("pullAndPush", "version_control_pull_and_push", {});
  }

  /**
   * Führt eine Operation im Kern aus. Läuft bereits eine, geschieht nichts:
   * Das schützt vor Doppelklicks und davor, dass sich zwei Git-Aufrufe im
   * selben Repository in die Quere kommen. Das Ergebnis im Repository kommt
   * über den abonnierten Zustand.
   */
  private async run(
    operation: Operation,
    command: string,
    args: Record<string, unknown>,
    onDone?: (result: unknown) => void,
  ): Promise<void> {
    const { project, busy } = this.current;
    if (project === null || busy !== null) return;
    this.replace({ ...this.current, busy: operation, failure: null });
    try {
      const result = await this.call(command, { project, ...args });
      onDone?.(result);
    } catch (reason) {
      this.replace({ ...this.current, failure: asError(reason) });
    } finally {
      this.replace({ ...this.current, busy: null });
    }
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

const VersionControlContext = createContext<VersionControlStore | null>(null);

export function VersionControlProvider({
  store,
  children,
}: {
  store: VersionControlStore;
  children: ReactNode;
}) {
  return <VersionControlContext.Provider value={store}>{children}</VersionControlContext.Provider>;
}

/** Die Versionskontrolle des Fensters, um etwas auszulösen (wählen, Darstellung wechseln). */
export function useVersionControlStore(): VersionControlStore {
  const store = useContext(VersionControlContext);
  if (!store) throw new Error("VersionControlProvider is missing");
  return store;
}

/**
 * Der Stand der Versionskontrolle des Fensters; zeichnet die Komponente bei
 * jeder Änderung neu. Auch der Explorer liest die geänderten Dateien hierüber.
 */
export function useVersionControl(): VersionControlSnapshot {
  const store = useVersionControlStore();
  return useSyncExternalStore(store.subscribe, store.snapshot);
}
