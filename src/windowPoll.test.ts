import { expect, test } from "vitest";
import { answerPolls, type EventBus } from "./windowPoll";

/** Ein Ereignisbus wie der von Tauri: Was gesendet wird, hören alle. */
function fakeBus() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const bus: EventBus = {
    emit: async (event, payload) => {
      // Wie bei Tauri kommt das Ereignis erst nach dem Senden an.
      await Promise.resolve();
      handlers.get(event)?.forEach((handler) => handler(payload));
    },
    listen: async (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      const listener = handler as (payload: unknown) => void;
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  return bus;
}

/** Stellt die Frage wie der Kern und sammelt die Antworten, bis `count` da sind. */
async function askLikeTheCore(bus: EventBus, question: string, count: number) {
  const answers: unknown[] = [];
  const all = new Promise<void>((resolve) => {
    void bus.listen("window-poll-answer", (answer) => {
      answers.push(answer);
      if (answers.length === count) resolve();
    });
  });
  await bus.emit("window-poll", { id: "kern-1", question });
  await all;
  return answers;
}

test("jedes Fenster antwortet auf die Rundfrage des Kerns mit Kennung und Label", async () => {
  const bus = fakeBus();
  await answerPolls(bus, "main", async (question) => `${question} von main`);
  await answerPolls(bus, "window-1", async (question) => `${question} von window-1`);

  const answers = await askLikeTheCore(bus, "updateReasons", 2);

  expect(answers).toEqual([
    { id: "kern-1", window: "main", answer: "updateReasons von main" },
    { id: "kern-1", window: "window-1", answer: "updateReasons von window-1" },
  ]);
});

test("scheitert die Antwort eines Fensters, antwortet es ohne Antwort", async () => {
  const bus = fakeBus();
  await answerPolls(bus, "main", async () => {
    throw new Error("kaputt");
  });

  const answers = await askLikeTheCore(bus, "saveArrangement", 1);

  expect(answers).toEqual([{ id: "kern-1", window: "main", answer: null }]);
});
