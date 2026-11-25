/**
 * Die Anlässe der Rückfrage vor der Aktualisierung als Text für den Dialog.
 * Gezählt und zusammengezählt werden sie im Kern (`UpdateReasons` in
 * `app_update/reasons.rs`); jedes Fenster nennt nur seine eigenen.
 */

import { plural, type MessageKey, type Translate } from "./i18n/translate";

/** Die Anlässe eines Fensters oder aller Fenster zusammen. */
export interface UpdateReasons {
  /** Dateien mit ungespeicherten Änderungen. */
  unsavedFiles: number;
  /** Terminals mit einem laufenden Prozess, ohne Agenten, die fortgesetzt werden. */
  runningProcesses: number;
  /** Agenten, die arbeiten und deren Gespräch danach fortgesetzt wird. */
  workingAgents: number;
  /** Agenten „im Hintergrund“, deren Gespräch danach fortgesetzt wird. */
  backgroundAgents: number;
  /**
   * Fenster, die ihre Anlässe nicht nennen konnten. Sie könnten Ungespeichertes
   * haben, deshalb fragt Kredr lieber nach.
   */
  silentWindows: number;
}

/** Die Texte zu jedem Anlass, in der Reihenfolge der Rückfrage. */
const REASON_TEXTS: [keyof UpdateReasons, one: MessageKey, other: MessageKey][] = [
  ["workingAgents", "appUpdate.reason.workingAgents.one", "appUpdate.reason.workingAgents.other"],
  [
    "backgroundAgents",
    "appUpdate.reason.backgroundAgents.one",
    "appUpdate.reason.backgroundAgents.other",
  ],
  [
    "runningProcesses",
    "appUpdate.reason.runningProcesses.one",
    "appUpdate.reason.runningProcesses.other",
  ],
  ["unsavedFiles", "appUpdate.reason.unsavedFiles.one", "appUpdate.reason.unsavedFiles.other"],
  ["silentWindows", "appUpdate.reason.silentWindows.one", "appUpdate.reason.silentWindows.other"],
];

/**
 * Der Text der Rückfrage vor der Aktualisierung: zählt die Anlässe aller
 * Fenster auf und sagt, was beim Beenden geschieht. Dass laufende Antworten
 * abbrechen und die Gespräche fortgesetzt werden, steht nur da, wenn ein
 * Agent betroffen ist.
 */
export function updateQuestion(t: Translate, reasons: UpdateReasons): string {
  const listed = REASON_TEXTS.filter(([reason]) => reasons[reason] > 0).map(
    ([reason, one, other]) => plural(t, reasons[reason], one, other),
  );
  const agents = reasons.workingAgents + reasons.backgroundAgents > 0;
  return t(agents ? "appUpdate.confirm.agentsMessage" : "appUpdate.confirm.message", {
    reasons: listed.join(", "),
  });
}
