/**
 * Die Antwortseite der Rundfrage: Der Kern stellt allen offenen Fenstern eine
 * Frage und sammelt ihre Antworten, etwa vor einer Aktualisierung, die alle
 * Fenster beendet. Jedes Fenster läuft in einer eigenen Webview, hört die
 * Frage als Ereignis und antwortet per Befehl; der Kern erkennt das Fenster
 * am Aufrufer. Wer nach drei Sekunden nicht geantwortet hat, gilt im Kern als
 * stumm. Warum die Antwort kein Ereignis ist, steht in ADR 0008.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Die Fragen des Kerns an die Fenster. */
export type PollQuestion =
  /** Was beim Beenden des Fensters verloren ginge oder abbräche (`UpdateReasons`). */
  | "updateReasons"
  /** Das Fenster speichert seine Aufteilung und antwortet danach. */
  | "saveArrangement";

/** Eine Frage des Kerns; `id` unterscheidet gleichzeitige Rundfragen. */
export interface Poll {
  id: string;
  question: PollQuestion;
}

/** Der Weg zwischen Kern und Fenster, soweit die Rundfrage ihn braucht. */
export interface PollChannel {
  /** Hört auf die Fragen des Kerns; gibt das Abmelden zurück. */
  listen(handler: (poll: Poll) => void): Promise<() => void>;
  /** Schickt die Antwort dieses Fensters auf die Rundfrage `id` an den Kern. */
  answer(id: string, answer: unknown): Promise<void>;
}

/**
 * Lässt das Fenster auf Rundfragen antworten, solange es lebt; gibt das
 * Abmelden zurück. Scheitert `answer`, antwortet das Fenster ohne Antwort
 * (`null`).
 */
export function answerPolls(
  channel: PollChannel,
  answer: (question: PollQuestion) => Promise<unknown>,
): Promise<() => void> {
  return channel.listen(({ id, question }) => {
    answer(question)
      .catch(() => null)
      .then((result) => channel.answer(id, result ?? null))
      .catch(() => {});
  });
}

/** Die Frage als Ereignis `window-poll`, die Antwort per Befehl `window_poll_answer`. */
export const tauriPollChannel: PollChannel = {
  listen: (handler) => listen<Poll>("window-poll", ({ payload }) => handler(payload)),
  answer: (id, answer) => invoke("window_poll_answer", { id, answer }),
};
