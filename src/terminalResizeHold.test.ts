import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_HOLD_MS, QUIET_MS, ResizeHold, type TerminalSize } from "./terminalResizeHold";

let applied: { size: TerminalSize; held: string[] }[];
let hold: ResizeHold;
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  vi.useFakeTimers();
  applied = [];
  hold = new ResizeHold((size, held) =>
    applied.push({ size, held: held.map((b) => new TextDecoder().decode(b)) }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

test("ohne Größenänderung geht die Ausgabe direkt ans Terminal", () => {
  expect(hold.output(bytes("a"))).toBe(false);
  expect(hold.holding).toBe(false);
});

test("ConPTY-Umbruch und Neuzeichnen des Programms kommen in einem Schritt mit der Größe", () => {
  hold.start({ cols: 132, rows: 48 });
  vi.advanceTimersByTime(20);
  expect(hold.output(bytes("conpty"))).toBe(true);
  vi.advanceTimersByTime(27);
  expect(hold.output(bytes("claude"))).toBe(true);
  expect(applied).toEqual([]);

  vi.advanceTimersByTime(QUIET_MS);
  expect(applied).toEqual([{ size: { cols: 132, rows: 48 }, held: ["conpty", "claude"] }]);
  expect(hold.holding).toBe(false);
});

test("ohne Ausgabe gilt die neue Größe nach der Ruhezeit", () => {
  hold.start({ cols: 80, rows: 24 });
  vi.advanceTimersByTime(QUIET_MS - 1);
  expect(applied).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(applied).toEqual([{ size: { cols: 80, rows: 24 }, held: [] }]);
});

test("gibt ein Programm ohne Pause aus, gilt die Größe spätestens nach der Höchstzeit", () => {
  hold.start({ cols: 80, rows: 24 });
  for (let t = 0; t < MAX_HOLD_MS; t += 10) {
    hold.output(bytes("."));
    vi.advanceTimersByTime(10);
  }
  expect(applied).toHaveLength(1);
  expect(applied[0].held.length).toBeGreaterThan(0);
});

test("eine weitere Größenänderung während des Haltens gilt statt der ersten", () => {
  hold.start({ cols: 100, rows: 30 });
  vi.advanceTimersByTime(10);
  hold.start({ cols: 132, rows: 48 });
  vi.advanceTimersByTime(QUIET_MS);
  expect(applied).toEqual([{ size: { cols: 132, rows: 48 }, held: [] }]);
});

test("nach dem Schließen wird nichts mehr übergeben", () => {
  hold.start({ cols: 80, rows: 24 });
  hold.output(bytes("x"));
  hold.dispose();
  vi.advanceTimersByTime(MAX_HOLD_MS);
  expect(applied).toEqual([]);
});
