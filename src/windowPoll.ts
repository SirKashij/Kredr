/**
 * Die Rundfrage über alle Fenster: Ein Fenster stellt allen offenen Fenstern
 * eine Frage und sammelt ihre Antworten, etwa vor einer Aktualisierung, die
 * alle Fenster beendet. Jedes Fenster läuft in einer eigenen Webview; sie
 * sprechen über die Ereignisse von Tauri miteinander.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

/** Die Fragen, die Fenster einander stellen. */
export type PollQuestion =
  /** Was beim Beenden des Fensters verloren ginge oder abbräche (`UpdateReasons`). */
  | "updateReasons"
  /** Das Fenster speichert seine Aufteilung und antwortet danach. */
  | "saveArrangement";

/** Die Ereignisse von Tauri, soweit die Rundfrage sie braucht. */
export interface EventBus {
  /** Sendet ein Ereignis an alle Fenster, auch an das eigene. */
  emit(event: string, payload: unknown): Promise<void>;
  /** Hört auf ein Ereignis aus allen Fenstern; gibt das Abmelden zurück. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

/** Fragt alle Fenster. */
const QUESTION = "window-poll";
/** Die Antwort eines Fensters. */
const ANSWER = "window-poll-answer";

/** So lange wartet die Rundfrage höchstens auf ein Fenster, das nicht antwortet. */
export const POLL_TIMEOUT = 3000;

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
 * Stellt den Fenstern `windows` die Frage `question` und gibt ihre Antworten
 * zurück, in der Reihenfolge von `windows`. Ein Fenster, dessen Antwort
 * scheitert oder nach `timeout` ms nicht da ist, antwortet `null`: Ein
 * stummes Fenster hält nichts dauerhaft auf.
 */
export async function pollWindows<A>(
  bus: EventBus,
  windows: readonly string[],
  question: PollQuestion,
  timeout = POLL_TIMEOUT,
): Promise<(A | null)[]> {
  const id = crypto.randomUUID();
  const waiting = new Set(windows);
  const answers = new Map<string, A>();
  let done = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const unlisten = await bus.listen<Answer>(ANSWER, (payload) => {
    if (payload.id !== id || !waiting.delete(payload.window)) return;
    if (payload.answer !== null) answers.set(payload.window, payload.answer as A);
    if (waiting.size === 0) done();
  });
  const timer = setTimeout(done, timeout);
  try {
    if (waiting.size > 0) {
      await bus.emit(QUESTION, { id, question } satisfies Question);
      await finished;
    }
  } finally {
    clearTimeout(timer);
    unlisten();
  }
  return windows.map((window) => answers.get(window) ?? null);
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

/** Stellt allen offenen Fenstern von Kredr die Frage `question`. */
export async function pollAllWindows<A>(question: PollQuestion): Promise<(A | null)[]> {
  const windows = (await getAllWebviewWindows()).map((window) => window.label);
  return pollWindows<A>(tauriEventBus, windows, question);
}
