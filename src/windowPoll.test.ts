import { expect, test } from "vitest";
import { answerPolls, type Poll, type PollChannel } from "./windowPoll";

/** Ein Fenster am Kern: hört die Fragen und sammelt, was es antwortet. */
function fakeChannel() {
  const handlers = new Set<(poll: Poll) => void>();
  const answers: { id: string; answer: unknown }[] = [];
  let answered = () => {};
  const channel: PollChannel = {
    listen: async (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    answer: async (id, answer) => {
      answers.push({ id, answer });
      answered();
    },
  };
  /** Stellt die Frage wie der Kern und wartet auf die Antwort. */
  async function ask(question: Poll["question"]) {
    const done = new Promise<void>((resolve) => (answered = resolve));
    handlers.forEach((handler) => handler({ id: "kern-1", question }));
    await done;
    return answers;
  }
  return { channel, ask };
}

test("das Fenster antwortet auf die Rundfrage des Kerns mit deren Kennung", async () => {
  const { channel, ask } = fakeChannel();
  await answerPolls(channel, async (question) => `${question} von main`);

  const answers = await ask("updateReasons");

  expect(answers).toEqual([{ id: "kern-1", answer: "updateReasons von main" }]);
});

test("scheitert die Antwort eines Fensters, antwortet es ohne Antwort", async () => {
  const { channel, ask } = fakeChannel();
  await answerPolls(channel, async () => {
    throw new Error("kaputt");
  });

  const answers = await ask("saveArrangement");

  expect(answers).toEqual([{ id: "kern-1", answer: null }]);
});
