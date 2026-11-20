import { Channel, invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { FileContent } from "./fileState";
import { followSelection, type ChangedFile, type VersionControlState } from "./versionControlState";

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
  /** Ob der Diff beide Fassungen nebeneinander zeigt statt untereinander. */
  sideBySide: boolean;
}

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
    sideBySide: true,
  };
  private readonly listeners = new Set<() => void>();

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
    this.replace({ ...this.current, project, state: null, selected: null });
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
    this.replace({ ...this.current, selected: file });
  }

  setSideBySide(sideBySide: boolean) {
    this.replace({ ...this.current, sideBySide });
  }

  private replace(next: VersionControlSnapshot) {
    this.current = next;
    for (const listener of this.listeners) listener();
  }
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
