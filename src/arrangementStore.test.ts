import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { emptyArrangement, openContent, openTab, openTabIn, tabsOf } from "./arrangement";
import { ArrangementSaver, restoreStored } from "./arrangementStore";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const one = openTab(emptyArrangement);
const two = openTab(one);

/** Ein Speicher, der festhält, was bei ihm ankommt. */
function recorder() {
  const saved: unknown[] = [];
  const save = async (arrangement: unknown) => {
    saved.push(arrangement);
  };
  return { saved, save };
}

test("eine geänderte Aufteilung wird kurz darauf von selbst gespeichert", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);

  saver.changed(one);
  expect(saved).toEqual([]);
  vi.advanceTimersByTime(500);

  expect(saved).toEqual([one]);
});

test("viele Änderungen kurz nacheinander ergeben ein Speichern mit dem letzten Stand", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);

  saver.changed(one);
  vi.advanceTimersByTime(300);
  saver.changed(two);
  vi.advanceTimersByTime(300);
  expect(saved).toEqual([]);
  vi.advanceTimersByTime(200);

  expect(saved).toEqual([two]);
});

test("ein verschobenes Fenster speichert die Aufteilung erneut", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);
  saver.changed(one);
  vi.advanceTimersByTime(500);

  saver.windowChanged();
  vi.advanceTimersByTime(500);

  expect(saved).toEqual([one, one]);
});

test("solange keine Aufteilung bekannt ist, speichert ein verschobenes Fenster nichts", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);

  saver.windowChanged();
  vi.advanceTimersByTime(500);

  expect(saved).toEqual([]);
});

test("beim Schließen des Fensters wird Ausstehendes sofort gespeichert, sonst nichts", async () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);
  saver.changed(one);

  await saver.flush();
  expect(saved).toEqual([one]);

  await saver.flush();
  vi.advanceTimersByTime(500);
  expect(saved).toEqual([one]);
});

test("ein gescheitertes Speichern bleibt folgenlos; die nächste Änderung speichert wieder", async () => {
  const saved: unknown[] = [];
  let fail = true;
  const saver = new ArrangementSaver(async (arrangement) => {
    if (fail) throw new Error("Datenträger voll");
    saved.push(arrangement);
  }, 500);

  saver.changed(one);
  await saver.flush();
  fail = false;
  saver.changed(two);
  await saver.flush();

  expect(saved).toEqual([two]);
});

test("beim Wiederherstellen entfällt genau das, was es laut Kern nicht mehr gibt", async () => {
  let arrangement = openTabIn(emptyArrangement, "C:\\Projekt\\weg");
  arrangement = openContent(arrangement, { kind: "file", path: "src/da.ts" });
  arrangement = openContent(arrangement, { kind: "file", path: "src/weg.ts" });
  const asked: string[][] = [];

  const restored = await restoreStored(JSON.parse(JSON.stringify(arrangement)), async (paths) => {
    asked.push(paths);
    return paths.map((path) => !path.includes("weg"));
  });

  expect(asked).toEqual([["C:\\Projekt\\weg", "src/da.ts", "src/weg.ts"]]);
  expect(tabsOf(restored)).toEqual([
    { id: "t1" },
    { id: "t3", content: { kind: "file", path: "src/da.ts" } },
  ]);
});

test("eine nicht lesbare gespeicherte Aufteilung ergibt die leere, ohne den Kern zu fragen", async () => {
  const restored = await restoreStored("kaputt", async () => {
    throw new Error("sollte nicht gefragt werden");
  });

  expect(restored).toEqual(emptyArrangement);
});
