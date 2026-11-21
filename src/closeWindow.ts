/** Wonach ein Fenster vor dem Schließen fragt. */
export type CloseQuestion = "unsavedFiles" | "runningProcess" | "workingAgent";

/** Was das Schließen eines Fensters von ihm wissen und in ihm auslösen muss. */
export interface ClosingWindow {
  /** Ob es Dateien mit ungespeicherten Änderungen gibt. */
  hasUnsavedFiles(): boolean;
  /**
   * Ob in einem Terminal noch ein Prozess läuft, etwa ein Agent. Agenten,
   * deren Gespräch beim nächsten Öffnen fortgesetzt wird, zählen nicht.
   */
  hasRunningProcess(): Promise<boolean>;
  /** Ob ein Agent arbeitet, dessen Gespräch beim nächsten Öffnen fortgesetzt wird. */
  hasWorkingAgent(): boolean;
  /** Stellt die Rückfrage; `true` heißt: trotzdem schließen. */
  confirm(question: CloseQuestion): Promise<boolean>;
  /** Speichert, was an der Aufteilung noch nicht gespeichert ist. */
  saveArrangement(): Promise<void>;
  /** Zeigt im Fenster, warum es sich nicht schließen ließ. */
  showError(details: string): void;
}

/**
 * Entscheidet, ob das Fenster schließen darf. Zu jedem Anlass (ungespeicherte
 * Dateien, laufender Prozess, arbeitender Agent, der unterbrochen würde)
 * erscheint höchstens eine Rückfrage; wer eine
 * abbricht, behält das Fenster. Scheitert eine Rückfrage selbst, bleibt das
 * Fenster nur offen, wenn sonst Ungespeichertes verloren ginge: Ein Fehler
 * hält es nie dauerhaft offen.
 */
export async function mayCloseWindow(window: ClosingWindow): Promise<boolean> {
  const unsaved = window.hasUnsavedFiles();
  try {
    if (unsaved && !(await window.confirm("unsavedFiles"))) return false;
    if ((await window.hasRunningProcess()) && !(await window.confirm("runningProcess"))) {
      return false;
    }
    if (window.hasWorkingAgent() && !(await window.confirm("workingAgent"))) return false;
  } catch (reason) {
    if (unsaved) {
      window.showError(String(reason));
      return false;
    }
  }
  // Die Aufteilung ist Komfort; an ihr scheitert das Schließen nicht.
  await window.saveArrangement().catch(() => {});
  return true;
}
