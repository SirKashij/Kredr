import { expect, test } from "vitest";
import { clipboardCommand } from "./terminalClipboard";

const C = 67;
const V = 86;
const INSERT = 45;

function key(keyCode: number, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return {
    keyCode,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
  };
}

test("Strg+C kopiert, wenn Text markiert ist", () => {
  expect(clipboardCommand(key(C, { ctrl: true }), true)).toBe("copy");
});

test("Strg+C ohne Markierung geht an das laufende Programm", () => {
  expect(clipboardCommand(key(C, { ctrl: true }), false)).toBeNull();
});

test("Strg+Umschalt+C bricht nie ein Programm ab, auch ohne Markierung", () => {
  expect(clipboardCommand(key(C, { ctrl: true, shift: true }), true)).toBe("copy");
  expect(clipboardCommand(key(C, { ctrl: true, shift: true }), false)).toBe("copy");
});

test("Strg+V und Strg+Umschalt+V fügen ein", () => {
  expect(clipboardCommand(key(V, { ctrl: true }), false)).toBe("paste");
  expect(clipboardCommand(key(V, { ctrl: true, shift: true }), true)).toBe("paste");
});

test("Strg+Einfg kopiert, Umschalt+Einfg fügt ein", () => {
  expect(clipboardCommand(key(INSERT, { ctrl: true }), true)).toBe("copy");
  expect(clipboardCommand(key(INSERT, { shift: true }), false)).toBe("paste");
});

test("die Buchstaben allein und mit AltGr bleiben Eingaben", () => {
  expect(clipboardCommand(key(C), true)).toBeNull();
  expect(clipboardCommand(key(V), false)).toBeNull();
  expect(clipboardCommand(key(V, { ctrl: true, alt: true }), false)).toBeNull();
  expect(clipboardCommand(key(C, { ctrl: true, alt: true }), true)).toBeNull();
});
