import { expect, test } from "vitest";
import { resolveKey, type KeyStroke } from "./keybindings";

function key(keyCode: number, modifiers: Partial<KeyStroke> = {}): KeyStroke {
  return { keyCode, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers };
}

const A = 65;
const B = 66;
const E = 69;

test("Strg+Umschalt+A startet einen neuen Agenten", () => {
  expect(resolveKey(key(A, { ctrlKey: true, shiftKey: true }), false)).toEqual({
    kind: "newAgent",
  });
});

test("ohne Umschalt oder mit AltGr bleibt A eine gewöhnliche Taste", () => {
  expect(resolveKey(key(A, { ctrlKey: true }), false)).toBe(null);
  expect(resolveKey(key(A, { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(null);
});

test("Strg+Umschalt+E zeigt den Explorer", () => {
  expect(resolveKey(key(E, { ctrlKey: true, shiftKey: true }), false)).toEqual({
    kind: "showExplorer",
  });
});

test("Strg+Umschalt+G zeigt die Versionskontrolle", () => {
  const G = 71;
  expect(resolveKey(key(G, { ctrlKey: true, shiftKey: true }), false)).toEqual({
    kind: "showVersionControl",
  });
  expect(resolveKey(key(G, { ctrlKey: true }), false)).toBeNull();
});

test("Strg+B blendet die Seitenleiste ein und aus", () => {
  expect(resolveKey(key(B, { ctrlKey: true }), false)).toEqual({ kind: "toggleSidebar" });
});

test("E und B ohne Strg bleiben gewöhnliche Eingaben", () => {
  expect(resolveKey(key(E, { shiftKey: true }), false)).toBeNull();
  expect(resolveKey(key(B), false)).toBeNull();
  // Strg+Alt ist AltGr.
  expect(resolveKey(key(B, { ctrlKey: true, altKey: true }), false)).toBeNull();
});
