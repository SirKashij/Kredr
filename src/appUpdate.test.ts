import { expect, test } from "vitest";
import {
  AppUpdate,
  checkResultText,
  failureSentence,
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

const none: AppUpdateState = {
  phase: "none",
  version: null,
  installed: "0.5.0",
  progress: null,
  hidden: false,
  cause: null,
  error: null,
};

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
    check: async () => {
      calls.push("check");
      throw new Error("Kern nicht erreichbar");
    },
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

test("erreicht „Jetzt suchen“ den Kern nicht, gilt die Suche als gescheitert", async () => {
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);

  const result = await update.checkNow();

  expect(core.calls).toEqual(["check"]);
  expect(result).toEqual({
    outcome: "failed",
    cause: "unknown",
    error: "Error: Kern nicht erreichbar",
  });
  expect(checkResultText(de, result)).toBe("Suche fehlgeschlagen. Unerwarteter Fehler.");
});

test("„Jetzt suchen“ in der Entwicklungsfassung sagt, dass sie nicht sucht", () => {
  expect(checkResultText(de, { outcome: "development" })).toBe(
    "Die Entwicklungsfassung sucht nicht nach Aktualisierungen.",
  );
});

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

test("scheitert der Aufruf des Kerns, zeigt der Hinweis den Fehlschlag mit Originaltext", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  core.port.install = () => Promise.reject(new Error("IPC kaputt"));
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(update.snapshot()).toMatchObject({
    phase: "failed",
    cause: "unknown",
    error: "Error: IPC kaputt",
  });
  expect(showsNotice(update.snapshot())).toBe(true);
  expect(showsIcon(update.snapshot())).toBe(true);
});

test("der Fortschritt des Downloads kommt im Hinweis an", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const downloading: AppUpdateState = { ...offered, phase: "downloading", progress: 0 };
  const core = fakeCore(offered, [downloading, { ...downloading, progress: 42 }]);
  const update = new AppUpdate(core.port);
  await settled();
  const progress: (number | null)[] = [];
  update.subscribe(() => progress.push(update.snapshot().progress));

  await update.updateNow();

  expect(progress).toEqual([0, 42]);
  expect(showsNotice(update.snapshot())).toBe(true);
  expect(showsIcon(update.snapshot())).toBe(false);
});

test("ist der Hinweis zum Download weggeklickt, zeigt das Symbol den Fortschritt", async () => {
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);
  await settled();

  core.announce({ ...none, phase: "downloading", version: "0.6.0", progress: 42, hidden: true });

  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(true);
  expect(update.snapshot().progress).toBe(42);
});

test("die Installation zeigt den Hinweis auch nach dem Wegklicken", async () => {
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);
  await settled();

  core.announce({ ...none, phase: "installing", version: "0.6.0", hidden: true });

  expect(showsNotice(update.snapshot())).toBe(true);
});

test.each([
  ["network", "Keine Verbindung zu GitHub."],
  ["signature", "Signatur ungültig."],
  ["installer", "Der Installer ließ sich nicht starten."],
  ["unknown", "Unerwarteter Fehler."],
] as const)("ein Fehlschlag mit Grund %s nennt ihn in einem Satz", async (cause, sentence) => {
  const core = fakeCore(none);
  const update = new AppUpdate(core.port);
  await settled();

  core.announce({
    ...none,
    phase: "failed",
    version: "0.6.0",
    cause,
    error: "error sending request",
  });

  expect(failureSentence(de, update.snapshot())).toBe(sentence);
  expect(update.snapshot().error).toBe("error sending request");
});

test("„Erneut versuchen“ startet Download und Installation neu", async () => {
  const failed: AppUpdateState = {
    ...none,
    phase: "failed",
    version: "0.6.0",
    cause: "network",
    error: "timeout",
  };
  const core = fakeCore(failed, [{ ...failed, phase: "downloading", cause: null, error: null }]);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.calls).toEqual(["save", "install"]);
  expect(update.snapshot().phase).toBe("downloading");
});

test("scheitert die automatische Suche, meldet Kredr nichts", async () => {
  const core = fakeCore(none);
  core.port.current = () => Promise.reject(new Error("keine Verbindung"));
  const update = new AppUpdate(core.port);
  await settled();

  expect(update.snapshot().phase).toBe("none");
  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(false);
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
