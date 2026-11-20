/**
 * Die Verbindung der Aufteilung zum Aufteilungsspeicher im Kern: laden und
 * wiederherstellen beim Öffnen eines Projekts, laufend speichern danach.
 */

import { invoke } from "@tauri-apps/api/core";
import { restoreArrangement, tabsOf, type Arrangement } from "./arrangement";

/** Fragt, welche der Pfade es gibt; die Antwort in derselben Reihenfolge. */
type ExistenceCheck = (paths: string[]) => Promise<boolean[]>;

/**
 * Lädt die gespeicherte Aufteilung des Projekts dieses Fensters und stellt sie
 * wieder her. Ohne gespeicherte Aufteilung, und wenn sie sich nicht lesen
 * lässt, ergibt sich die leere Aufteilung.
 */
export async function loadArrangement(project: string): Promise<Arrangement> {
  try {
    const stored = await invoke<unknown>("arrangement_load");
    return await restoreStored(stored, (paths) =>
      invoke<boolean[]>("project_files_exist", { project, paths }),
    );
  } catch (reason) {
    // Ein Projekt öffnet sich auch, wenn sein Speicher nicht erreichbar ist.
    console.error(reason);
    return restoreArrangement(null);
  }
}

/**
 * Stellt die gespeicherte Aufteilung wieder her und lässt dabei aus, was es
 * laut `exist` nicht mehr gibt: Dateiansichten ohne Datei, Startordner ohne Ordner.
 */
export async function restoreStored(stored: unknown, exist: ExistenceCheck): Promise<Arrangement> {
  const paths = [
    ...new Set(
      tabsOf(restoreArrangement(stored)).flatMap((tab) => [tab.cwd, tab.content?.path] as const),
    ),
  ].filter((path) => path !== undefined);
  if (paths.length === 0) return restoreArrangement(stored);
  const found = await exist(paths);
  const present = new Set(paths.filter((_, index) => found[index]));
  return restoreArrangement(stored, (path) => present.has(path));
}

/** Speichert die Aufteilung zusammen mit Größe und Position dieses Fensters. */
function saveArrangement(arrangement: Arrangement): Promise<void> {
  return invoke("arrangement_save", { arrangement });
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
    private readonly save: (arrangement: Arrangement) => Promise<void> = saveArrangement,
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

  /** Speichert sofort, was noch aussteht; vor dem Schließen des Fensters. */
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

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }
}
