/**
 * Die Anlässe der Rückfrage vor der Aktualisierung: was beim Beenden aller
 * Fenster verloren ginge oder abbräche, gezählt und als Text für den Dialog.
 */

import { plural, type MessageKey, type Translate } from "./i18n/i18n";

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

/** Ein Fenster ohne Anlass. */
export const NO_REASONS: UpdateReasons = {
  unsavedFiles: 0,
  runningProcesses: 0,
  workingAgents: 0,
  backgroundAgents: 0,
  silentWindows: 0,
};

/** Ein Fenster, das nicht geantwortet hat. */
export const SILENT_WINDOW: UpdateReasons = { ...NO_REASONS, silentWindows: 1 };

const KINDS = Object.keys(NO_REASONS) as (keyof UpdateReasons)[];

/** Die Anlässe mehrerer Fenster zusammengezählt. */
export function sumReasons(windows: readonly UpdateReasons[]): UpdateReasons {
  const sum = { ...NO_REASONS };
  for (const window of windows) for (const kind of KINDS) sum[kind] += window[kind] ?? 0;
  return sum;
}

/** Ob es überhaupt einen Anlass gibt. */
export function hasReasons(reasons: UpdateReasons): boolean {
  return KINDS.some((kind) => reasons[kind] > 0);
}

/**
 * Ob `now` einen Anlass hat, den `before` nicht hatte: eine Art mit mehr
 * Fällen als zuvor. Weniger Fälle sind kein neuer Anlass.
 */
export function hasNewReasons(now: UpdateReasons, before: UpdateReasons): boolean {
  return KINDS.some((kind) => now[kind] > before[kind]);
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
