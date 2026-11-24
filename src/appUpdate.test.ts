import { expect, test } from "vitest";
import { AppUpdate, showsNotice, type AppUpdatePort, type AppUpdateState } from "./appUpdate";

const none: AppUpdateState = { phase: "none", version: null, installed: "0.5.0", error: null };

/**
 * Ein Kern, den der Test steuert: `announce` meldet allen Fenstern einen neuen
 * Zustand, `installSteps` sind die Zustände, die er beim Aktualisieren meldet.
 */
function fakeCore(initial: AppUpdateState, installSteps: AppUpdateState[] = []) {
  const listeners = new Set<(state: AppUpdateState) => void>();
  const calls: string[] = [];
  const announce = (state: AppUpdateState) => listeners.forEach((listener) => listener(state));
  const port: AppUpdatePort = {
    current: async () => initial,
    onChange: (listener) => {
      listeners.add(listener);
    },
    install: async () => {
      calls.push("install");
      for (const step of installSteps) {
        await Promise.resolve();
        announce(step);
      }
    },
    later: async () => {
      calls.push("later");
    },
    openUrl: (url) => calls.push(`open ${url}`),
  };
  return { port, announce, calls };
}

/** Wartet, bis alle anstehenden Antworten des Kerns angekommen sind. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

test("eine neue Version ergibt ein Angebot", async () => {
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);
  await settled();

  core.announce({ ...none, phase: "offered", version: "0.6.0" });

  expect(update.snapshot()).toMatchObject({
    phase: "offered",
    version: "0.6.0",
    installed: "0.5.0",
  });
});

test("„Jetzt aktualisieren“ führt über den Download zur Installation", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [
    { ...offered, phase: "downloading" },
    { ...offered, phase: "installing" },
  ]);
  const update = new AppUpdate(core.port);
  await settled();
  const phases: string[] = [];
  update.subscribe(() => phases.push(update.snapshot().phase));

  await update.updateNow();

  expect(core.calls).toEqual(["install"]);
  expect(phases).toEqual(["downloading", "installing"]);
  expect(showsNotice(update.snapshot())).toBe(true);
});

test("ein zweiter Klick während des Downloads startet keine zweite Aktualisierung", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [{ ...offered, phase: "downloading" }]);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();
  await update.updateNow();

  expect(core.calls).toEqual(["install"]);
});

test("scheitert die Aktualisierung, zeigt der Hinweis den Grund", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  core.port.install = () => Promise.reject(new Error("Signatur ungültig"));
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(update.snapshot()).toMatchObject({ phase: "failed", error: "Error: Signatur ungültig" });
  expect(showsNotice(update.snapshot())).toBe(true);
});

test("„Neuerungen“ öffnet die Release-Seite des Tags", async () => {
  const core = fakeCore({ ...none, phase: "offered", version: "0.6.0" });
  const update = new AppUpdate(core.port);
  await settled();

  update.showReleaseNotes();

  expect(core.calls).toEqual(["open https://github.com/SirKashij/Kredr/releases/tag/v0.6.0"]);
});

test("ohne neue Version erscheint kein Hinweis", async () => {
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);
  await settled();

  expect(update.snapshot().phase).toBe("none");
  expect(showsNotice(update.snapshot())).toBe(false);
});

test("ein Angebot zeigt den Hinweis, nach „Später“ verschwindet er", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  const update = new AppUpdate(core.port);
  await settled();
  expect(showsNotice(update.snapshot())).toBe(true);

  await update.later();
  core.announce({ ...offered, phase: "later" });

  expect(core.calls).toEqual(["later"]);
  expect(showsNotice(update.snapshot())).toBe(false);
});
