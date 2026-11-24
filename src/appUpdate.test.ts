import { expect, test } from "vitest";
import {
  AppUpdate,
  showsIcon,
  showsNotice,
  type AppUpdatePort,
  type AppUpdateState,
} from "./appUpdate";
import { translate, type Translate } from "./i18n/i18n";
import {
  NO_REASONS as quiet,
  SILENT_WINDOW,
  updateQuestion,
  type UpdateReasons,
} from "./updateReasons";

const none: AppUpdateState = { phase: "none", version: null, installed: "0.5.0", error: null };

/**
 * Ein Kern, den der Test steuert: `announce` meldet allen Fenstern einen neuen
 * Zustand, `installSteps` sind die Zustände, die er beim Aktualisieren meldet.
 * `windows` sind die Anlässe der offenen Fenster, `answer` ist die Antwort der
 * Person auf die Rückfrage.
 */
function fakeCore(
  initial: AppUpdateState,
  installSteps: AppUpdateState[] = [],
  windows: UpdateReasons[] = [quiet],
  answer = true,
) {
  const listeners = new Set<(state: AppUpdateState) => void>();
  const calls: string[] = [];
  const asked: UpdateReasons[] = [];
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
    reasons: async () => windows,
    confirm: async (reasons) => {
      asked.push(reasons);
      return answer;
    },
    saveArrangements: async () => {
      calls.push("save");
    },
  };
  return { port, announce, calls, asked };
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

  expect(core.calls).toEqual(["save", "install"]);
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

  expect(core.calls).toEqual(["save", "install"]);
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

test("„Später“ lässt nur das Symbol stehen", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  const update = new AppUpdate(core.port);
  await settled();
  expect(showsIcon(update.snapshot())).toBe(false);

  await update.later();
  core.announce({ ...offered, phase: "later" });

  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(true);
});

test("nach einem Neustart kommt dieselbe Version nur als Symbol, eine höhere als Hinweis", async () => {
  // Der Kern hat sich 0.6.0 gemerkt und meldet sie nach dem Start als „später“.
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);
  await settled();

  core.announce({ ...none, phase: "later", version: "0.6.0" });
  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(true);

  core.announce({ ...none, phase: "offered", version: "0.7.0" });
  expect(showsNotice(update.snapshot())).toBe(true);
  expect(showsIcon(update.snapshot())).toBe(false);
});

test("aus dem Menü des Symbols lässt sich aktualisieren und die Neuerungen öffnen", async () => {
  const core = fakeCore({ ...none, phase: "later", version: "0.6.0" });
  const update = new AppUpdate(core.port);
  await settled();

  update.showReleaseNotes();
  await update.updateNow();

  expect(core.calls).toEqual([
    "open https://github.com/SirKashij/Kredr/releases/tag/v0.6.0",
    "save",
    "install",
  ]);
});

test("ohne Anlass in einem Fenster aktualisiert Kredr ohne Rückfrage", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [], [quiet, quiet]);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toEqual([]);
  expect(core.calls).toEqual(["save", "install"]);
});

test("Anlässe aus mehreren Fenstern erscheinen zusammen in einer Rückfrage", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(
    offered,
    [],
    [
      { ...quiet, workingAgents: 1, unsavedFiles: 1 },
      quiet,
      { ...quiet, workingAgents: 1, runningProcesses: 2, backgroundAgents: 1 },
    ],
  );
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toEqual([
    {
      unsavedFiles: 1,
      runningProcesses: 2,
      workingAgents: 2,
      backgroundAgents: 1,
      silentWindows: 0,
    },
  ]);
  expect(core.calls).toEqual(["save", "install"]);
});

test("ein Fenster, das nicht antwortet, verlangt die Rückfrage", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [], [quiet, SILENT_WINDOW], false);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toEqual([{ ...quiet, silentWindows: 1 }]);
  expect(core.calls).toEqual([]);
});

const de: Translate = (key, values) => translate("de", key, values);

test("die Rückfrage zählt die Anlässe auf und sagt, dass die Gespräche fortgesetzt werden", () => {
  const text = updateQuestion(de, { ...quiet, workingAgents: 2, unsavedFiles: 1 });

  expect(text).toMatch(/^2 Agenten arbeiten noch, 1 Datei ist nicht gespeichert\.\n\n/);
  expect(text).toContain("Laufende Antworten brechen ab");
  expect(text).toContain("fortgesetzt");
  expect(updateQuestion(de, { ...quiet, backgroundAgents: 1, runningProcesses: 3 })).toMatch(
    /^1 Agent hat eine Hintergrundaufgabe, 3 Terminals haben laufende Prozesse\./,
  );
});

test("ohne betroffenen Agenten verspricht die Rückfrage keine fortgesetzten Gespräche", () => {
  const text = updateQuestion(de, { ...quiet, runningProcesses: 1, silentWindows: 2 });

  expect(text).toMatch(/^1 Terminal hat einen laufenden Prozess, 2 Fenster antworten nicht\./);
  expect(text).not.toContain("fortgesetzt");
  expect(text).not.toContain("Antworten brechen ab");
});

test("„Später“ in der Rückfrage bricht die Aktualisierung ab", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [], [{ ...quiet, workingAgents: 1 }], false);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toHaveLength(1);
  expect(core.calls).toEqual([]);
  expect(update.snapshot().phase).toBe("offered");
});
