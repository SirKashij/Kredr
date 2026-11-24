import { expect, test } from "vitest";
import { answerPolls, pollWindows, type EventBus } from "./windowPoll";

/** Ein Ereignisbus wie der von Tauri: Was ein Fenster sendet, hören alle. */
function fakeBus(): EventBus {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
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
}

test("die Rundfrage sammelt die Antwort jedes Fensters in seiner Reihenfolge", async () => {
  const bus = fakeBus();
  await answerPolls(bus, "main", async (question) => `${question} von main`);
  await answerPolls(bus, "window-1", async (question) => `${question} von window-1`);

  const answers = await pollWindows<string>(bus, ["main", "window-1"], "updateReasons");

  expect(answers).toEqual(["updateReasons von main", "updateReasons von window-1"]);
});

test("ein Fenster, das nicht antwortet, hält die Rundfrage nicht auf und antwortet null", async () => {
  const bus = fakeBus();
  await answerPolls(bus, "main", async () => "da");

  const answers = await pollWindows<string>(bus, ["main", "window-1"], "updateReasons", 20);

  expect(answers).toEqual(["da", null]);
});

test("scheitert die Antwort eines Fensters, antwortet es null, und die Rundfrage endet trotzdem", async () => {
  const bus = fakeBus();
  await answerPolls(bus, "main", async () => "da");
  await answerPolls(bus, "window-1", async () => {
    throw new Error("kaputt");
  });

  const answers = await pollWindows<string>(bus, ["main", "window-1"], "updateReasons", 10_000);

  expect(answers).toEqual(["da", null]);
});
