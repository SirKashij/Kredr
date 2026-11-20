import { expect, test } from "vitest";
import { resolveKey } from "./keybindings";

const A = 65;

test("Strg+Umschalt+A startet einen neuen Agenten", () => {
  const key = { keyCode: A, ctrlKey: true, shiftKey: true, altKey: false };

  expect(resolveKey(key, false)).toEqual({ kind: "newAgent" });
});

test("ohne Umschalt oder mit AltGr bleibt A eine gewöhnliche Taste", () => {
  expect(resolveKey({ keyCode: A, ctrlKey: true, shiftKey: false, altKey: false }, false)).toBe(
    null,
  );
  expect(resolveKey({ keyCode: A, ctrlKey: true, shiftKey: true, altKey: true }, false)).toBe(null);
});
