import { expect, test, vi } from "vitest";

// Ein reines Modul lädt React auch nicht über einen Import (CODING_STANDARDS.md).
vi.mock("react", () => {
  throw new Error("Ein reines Modul hat React geladen.");
});

test.each([
  ["appUpdate", () => import("./appUpdate")],
  ["updateReasons", () => import("./updateReasons")],
  ["i18n/translate", () => import("./i18n/translate")],
])("%s lädt React nicht", async (_name, load) => {
  await expect(load()).resolves.toBeDefined();
});
