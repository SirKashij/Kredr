/**
 * Die Antwortseite der Rundfrage: Der Kern stellt allen offenen Fenstern eine
 * Frage und sammelt ihre Antworten, etwa vor einer Aktualisierung, die alle
 * Fenster beendet. Jedes Fenster läuft in einer eigenen Webview und antwortet
 * über die Ereignisse von Tauri. Wer nach drei Sekunden nicht geantwortet
 * hat, gilt im Kern als stumm.
 */

import { emit, listen } from "@tauri-apps/api/event";

/** Die Fragen des Kerns an die Fenster. */
export type PollQuestion =
  /** Was beim Beenden des Fensters verloren ginge oder abbräche (`UpdateReasons`). */
  | "updateReasons"
  /** Das Fenster speichert seine Aufteilung und antwortet danach. */
  | "saveArrangement";

/** Die Ereignisse von Tauri, soweit die Rundfrage sie braucht. */
export interface EventBus {
  /** Sendet ein Ereignis an alle Fenster und den Kern. */
  emit(event: string, payload: unknown): Promise<void>;
  /** Hört auf ein Ereignis aus allen Fenstern und dem Kern; gibt das Abmelden zurück. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

/** Der Kern fragt alle Fenster. */
const QUESTION = "window-poll";
/** Die Antwort eines Fensters. */
const ANSWER = "window-poll-answer";

interface Question {
  id: string;
  question: PollQuestion;
}

interface Answer {
  id: string;
  window: string;
  /** `null`, wenn das Fenster keine Antwort fand. */
  answer: unknown;
}

/**
 * Lässt das Fenster `window` auf Rundfragen antworten, solange es lebt; gibt
 * das Abmelden zurück. Scheitert `answer`, antwortet das Fenster ohne Antwort.
 */
export function answerPolls(
  bus: EventBus,
  window: string,
  answer: (question: PollQuestion) => Promise<unknown>,
): Promise<() => void> {
  return bus.listen<Question>(QUESTION, ({ id, question }) => {
    answer(question)
      .catch(() => null)
      .then((result) => bus.emit(ANSWER, { id, window, answer: result ?? null } satisfies Answer))
      .catch(() => {});
  });
}

/** Die Ereignisse von Tauri. */
export const tauriEventBus: EventBus = {
  emit: (event, payload) => emit(event, payload),
  listen: <T>(event: string, handler: (payload: T) => void) =>
    listen<T>(event, ({ payload }) => handler(payload)),
};
