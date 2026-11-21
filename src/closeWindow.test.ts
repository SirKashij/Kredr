import { expect, test } from "vitest";
import { mayCloseWindow, type ClosingWindow, type CloseQuestion } from "./closeWindow";

/** Ein Fenster, das der Test beschreibt; es merkt sich, was gefragt und gemeldet wurde. */
function closing(
  situation: { unsaved?: boolean; running?: boolean; working?: boolean },
  answer: (question: CloseQuestion) => boolean | Promise<boolean> = () => true,
) {
  const asked: CloseQuestion[] = [];
  const errors: string[] = [];
  let saved = 0;
  const window: ClosingWindow = {
    hasUnsavedFiles: () => situation.unsaved ?? false,
    hasRunningProcess: async () => situation.running ?? false,
    hasWorkingAgent: () => situation.working ?? false,
    confirm: async (question) => {
      asked.push(question);
      return answer(question);
    },
    saveArrangement: async () => {
      saved += 1;
    },
    showError: (details) => errors.push(details),
  };
  return { window, asked, errors, saved: () => saved };
}

test("ohne Ungespeichertes und ohne laufenden Prozess schließt das Fenster ohne Frage", async () => {
  const { window, asked, saved } = closing({});

  expect(await mayCloseWindow(window)).toBe(true);
  expect(asked).toEqual([]);
  expect(saved()).toBe(1);
});

test("ungespeicherte Dateien: Abbrechen lässt das Fenster offen", async () => {
  const { window, asked } = closing({ unsaved: true }, () => false);

  expect(await mayCloseWindow(window)).toBe(false);
  expect(asked).toEqual(["unsavedFiles"]);
});

test("ein laufender Prozess in einem Terminal verlangt eine Rückfrage", async () => {
  const confirmed = closing({ running: true });
  const cancelled = closing({ running: true }, () => false);

  expect(await mayCloseWindow(confirmed.window)).toBe(true);
  expect(confirmed.asked).toEqual(["runningProcess"]);
  expect(await mayCloseWindow(cancelled.window)).toBe(false);
  expect(cancelled.saved()).toBe(0);
});

test("ein arbeitender Agent, der fortgesetzt wird, verlangt eine eigene Rückfrage", async () => {
  const confirmed = closing({ working: true });
  const cancelled = closing({ working: true }, () => false);

  expect(await mayCloseWindow(confirmed.window)).toBe(true);
  expect(confirmed.asked).toEqual(["workingAgent"]);
  expect(confirmed.saved()).toBe(1);
  expect(await mayCloseWindow(cancelled.window)).toBe(false);
});

test("zu jedem Anlass erscheint höchstens eine Frage", async () => {
  const { window, asked, saved } = closing({ unsaved: true, running: true, working: true });

  expect(await mayCloseWindow(window)).toBe(true);
  expect(asked).toEqual(["unsavedFiles", "runningProcess", "workingAgent"]);
  expect(saved()).toBe(1);
});

test("wer die erste Frage abbricht, bekommt die zweite nicht mehr", async () => {
  const { window, asked } = closing({ unsaved: true, running: true }, () => false);

  expect(await mayCloseWindow(window)).toBe(false);
  expect(asked).toEqual(["unsavedFiles"]);
});

test("scheitert die Rückfrage, bleibt ein Fenster mit Ungespeichertem offen und meldet den Fehler", async () => {
  const { window, errors } = closing({ unsaved: true }, () => {
    throw new Error("Dialog nicht verfügbar");
  });

  expect(await mayCloseWindow(window)).toBe(false);
  expect(errors).toEqual(["Error: Dialog nicht verfügbar"]);
});

test("scheitert die Rückfrage, schließt ein Fenster ohne Ungespeichertes trotzdem", async () => {
  const { window, errors } = closing({ running: true }, () => {
    throw new Error("Dialog nicht verfügbar");
  });

  expect(await mayCloseWindow(window)).toBe(true);
  expect(errors).toEqual([]);
});

test("scheitert das Speichern der Aufteilung, schließt das Fenster trotzdem", async () => {
  const { window } = closing({});
  window.saveArrangement = () => Promise.reject(new Error("Platte voll"));

  expect(await mayCloseWindow(window)).toBe(true);
});
