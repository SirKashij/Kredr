import { expect, test } from "vitest";
import { resolveKey, type KeyStroke } from "./keybindings";

function key(keyCode: number, modifiers: Partial<KeyStroke> = {}): KeyStroke {
  return { keyCode, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers };
}

const E = 69;
const B = 66;

test("Strg+Umschalt+E zeigt den Explorer", () => {
  expect(resolveKey(key(E, { ctrlKey: true, shiftKey: true }), false)).toEqual({
    kind: "showExplorer",
  });
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
