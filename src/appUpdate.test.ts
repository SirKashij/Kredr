import { expect, test } from "vitest";
import {
  AppUpdate,
  checkResultText,
  failureSentence,
  offersActions,
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
 * Zustand, `downloadSteps` sind die Zustände, die er während des Downloads
 * meldet. Danach hält das Fenster wie im echten Kern wieder die Rückfrage, bis
 * es installiert. `windows` sind die Anlässe der offenen Fenster, `answer` ist
 * die Antwort der Person auf die Rückfrage. Wie der echte Kern lässt er nur
 * ein Fenster zugleich fragen und meldet die Rückfrage allen Fenstern.
 * `portFor` ist der Port eines weiteren Fensters, `whileDownloading` lässt den
 * Test während des Downloads etwas ändern.
 */
function fakeCore(
  initial: AppUpdateState,
  downloadSteps: AppUpdateState[] = [],
  windows: UpdateReasons[] = [quiet],
  answer: boolean | (() => Promise<boolean>) = true,
) {
  const listeners = new Set<(state: AppUpdateState) => void>();
  const calls: string[] = [];
  const asked: UpdateReasons[] = [];
  let state = initial;
  let duringDownload = () => {};
  // Beginnt er in der Rückfrage, kam sie aus dem Angebot.
  let beforeConfirm: AppUpdateState =
    initial.phase === "confirm" ? { ...initial, phase: "offered" } : initial;
  /** Das Fenster, das die Rückfrage hält. */
  let asker: string | null = initial.phase === "confirm" ? "main" : null;
  /** Ob die neue Version geladen ist und auf die Installation wartet. */
  let installerReady = false;
  const announce = (next: AppUpdateState) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  const portFor = (window: string): AppUpdatePort => {
    const named = (call: string) => (window === "main" ? call : `${call} ${window}`);
    const holds = () => state.phase === "confirm" && asker === window;
    return {
      current: async () => state,
      check: async () => {
        calls.push(named("check"));
        throw new Error("Kern nicht erreichbar");
      },
      onChange: (listener) => {
        listeners.add(listener);
      },
      ask: async () => {
        calls.push(named("ask"));
        if (!["offered", "later", "failed"].includes(state.phase)) return false;
        beforeConfirm = state;
        asker = window;
        const confirm: AppUpdateState = {
          ...state,
          phase: "confirm",
          hidden: state.phase === "later",
        };
        state = confirm;
        // Wie ein Ereignis des Kerns kommt die Meldung erst etwas später an.
        await Promise.resolve();
        announce(confirm);
        return true;
      },
      cancel: async () => {
        if (!holds()) return;
        calls.push(named("cancel"));
        asker = null;
        installerReady = false;
        announce(beforeConfirm);
      },
      fail: async (error) => {
        // Wie im Kern: nur das fragende Fenster, und nicht während des Downloads.
        const leads = ["confirm", "installing"].includes(state.phase) && asker === window;
        if (!leads) return false;
        calls.push(named("fail"));
        asker = null;
        installerReady = false;
        await Promise.resolve();
        announce({
          ...state,
          phase: "failed",
          progress: null,
          hidden: false,
          cause: "unknown",
          error,
        });
        return true;
      },
      download: async () => {
        calls.push(named("download"));
        if (!holds() || installerReady) return false;
        for (const step of downloadSteps) {
          await Promise.resolve();
          announce(step);
        }
        duringDownload();
        await Promise.resolve();
        installerReady = true;
        announce({ ...state, phase: "confirm", progress: null });
        return true;
      },
      install: async () => {
        calls.push(named("install"));
        if (!holds() || !installerReady) return;
        await Promise.resolve();
        announce({ ...state, phase: "installing", progress: null });
      },
      later: async () => {
        calls.push(named("later"));
      },
      openUrl: (url) => calls.push(`open ${url}`),
      reasons: async () => {
        calls.push(named("reasons"));
        return windows;
      },
      confirm: async (reasons) => {
        calls.push(named("confirm"));
        asked.push(reasons);
        return typeof answer === "boolean" ? answer : answer();
      },
      saveArrangements: async () => {
        calls.push(named("save"));
      },
    };
  };
  return {
    port: portFor("main"),
    portFor,
    announce,
    calls,
    asked,
    /** Was während des Downloads in den Fenstern geschieht. */
    whileDownloading(change: () => void) {
      duringDownload = change;
    },
    /** Neue Anlässe in den Fenstern. */
    setWindows(next: UpdateReasons[]) {
      windows = next;
    },
  };
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
  const core = fakeCore(offered, [{ ...offered, phase: "downloading" }]);
  const update = new AppUpdate(core.port);
  await settled();
  const phases: string[] = [];
  update.subscribe(() => phases.push(update.snapshot().phase));

  await update.updateNow();

  expect(core.calls).toEqual(["ask", "reasons", "download", "reasons", "save", "install"]);
  expect(phases).toEqual(["confirm", "downloading", "confirm", "installing"]);
  expect(showsNotice(update.snapshot())).toBe(true);
});

test("ein zweiter Klick während des Downloads startet keine zweite Aktualisierung", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [{ ...offered, phase: "downloading" }]);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();
  await update.updateNow();

  expect(core.calls).toEqual(["ask", "reasons", "download", "reasons", "save", "install"]);
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
  update.subscribe(() => {
    const { phase, progress: now } = update.snapshot();
    if (phase === "downloading") progress.push(now);
    else expect(showsIcon(update.snapshot())).toBe(false);
  });

  await update.updateNow();

  expect(progress).toEqual([0, 42]);
  expect(showsNotice(update.snapshot())).toBe(true);
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

  const phases: string[] = [];
  update.subscribe(() => phases.push(update.snapshot().phase));

  await update.updateNow();

  expect(core.calls).toEqual(["ask", "reasons", "download", "reasons", "save", "install"]);
  expect(phases).toContain("downloading");
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
    "ask",
    "reasons",
    "download",
    "reasons",
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
  expect(core.calls).toEqual(["ask", "reasons", "download", "reasons", "save", "install"]);
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
  // Nach dem Download gibt es keinen neuen Anlass, also keine zweite Rückfrage.
  expect(core.calls).toEqual([
    "ask",
    "reasons",
    "confirm",
    "download",
    "reasons",
    "save",
    "install",
  ]);
});

test("ein Fenster, das nicht antwortet, verlangt die Rückfrage", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [], [quiet, SILENT_WINDOW], false);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toEqual([{ ...quiet, silentWindows: 1 }]);
  expect(core.calls).toEqual(["ask", "reasons", "confirm", "cancel"]);
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
  expect(core.calls).toEqual(["ask", "reasons", "confirm", "cancel"]);
  expect(update.snapshot().phase).toBe("offered");
});

/** Eine Antwort auf die Rückfrage, die der Test erst später gibt. */
function pendingAnswer() {
  let give: (yes: boolean) => void = () => {};
  const answer = new Promise<boolean>((resolve) => (give = resolve));
  return { answer: () => answer, give };
}

test("während der Rückfrage zeigt ein zweites Fenster sie ohne Aktionen und fragt nicht erneut", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const person = pendingAnswer();
  const core = fakeCore(offered, [], [{ ...quiet, workingAgents: 1 }], person.answer);
  const first = new AppUpdate(core.port);
  const second = new AppUpdate(core.portFor("zweites"));
  await settled();

  const updating = first.updateNow();
  await settled();

  expect(second.snapshot().phase).toBe("confirm");
  expect(showsNotice(second.snapshot())).toBe(true);
  expect(offersActions(second.snapshot())).toBe(false);
  await second.updateNow();
  await second.later();
  expect(core.asked).toHaveLength(1);
  expect(core.calls).toEqual(["ask", "reasons", "confirm"]);

  person.give(false);
  await updating;
  expect(second.snapshot().phase).toBe("offered");
  expect(offersActions(second.snapshot())).toBe(true);
});

test("fragt schon ein anderes Fenster, öffnet ein Klick keine zweite Rückfrage", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [], [{ ...quiet, workingAgents: 1 }]);
  const first = new AppUpdate(core.port);
  const second = new AppUpdate(core.portFor("zweites"));
  await settled();

  // Beide klicken, bevor die Meldung des Kerns das zweite Fenster erreicht.
  await Promise.all([first.updateNow(), second.updateNow()]);

  expect(core.asked).toHaveLength(1);
  expect(core.calls).toEqual([
    "ask",
    "ask zweites",
    "reasons",
    "confirm",
    "download",
    "reasons",
    "save",
    "install",
  ]);
});

test("eine Rückfrage aus dem Symbol zeigt in den anderen Fenstern nur das Symbol, ohne Menü", async () => {
  const later: AppUpdateState = { ...none, phase: "later", version: "0.6.0" };
  const core = fakeCore(later, [], [{ ...quiet, unsavedFiles: 1 }], pendingAnswer().answer);
  const first = new AppUpdate(core.port);
  const second = new AppUpdate(core.portFor("zweites"));
  await settled();

  void first.updateNow();
  await settled();

  expect(second.snapshot().phase).toBe("confirm");
  expect(showsNotice(second.snapshot())).toBe(false);
  expect(showsIcon(second.snapshot())).toBe(true);
  expect(offersActions(second.snapshot())).toBe(false);
});

test("scheitert die Rundfrage, zeigen alle Fenster den Fehlschlag", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  core.port.reasons = () => Promise.reject(new Error("IPC kaputt"));
  const update = new AppUpdate(core.port);
  const other = new AppUpdate(core.portFor("zweites"));
  await settled();

  await update.updateNow();
  await settled();

  expect(core.calls).toEqual(["ask", "fail"]);
  for (const window of [update, other]) {
    expect(window.snapshot()).toMatchObject({
      phase: "failed",
      cause: "unknown",
      error: "Error: IPC kaputt",
    });
  }
  // Die Rückfrage hängt nicht; das andere Fenster kann es erneut versuchen.
  expect(offersActions(other.snapshot())).toBe(true);
});

test("scheitert der Dialog der Rückfrage, zeigen alle Fenster den Fehlschlag", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [], [{ ...quiet, unsavedFiles: 1 }], () =>
    Promise.reject(new Error("Dialog kaputt")),
  );
  const update = new AppUpdate(core.port);
  const other = new AppUpdate(core.portFor("zweites"));
  await settled();

  await update.updateNow();
  await settled();

  expect(other.snapshot()).toMatchObject({ phase: "failed", error: "Error: Dialog kaputt" });
});

test("erreicht der Fehlschlag den Kern nicht, zeigt ihn wenigstens dieses Fenster", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  core.port.reasons = () => Promise.reject(new Error("IPC kaputt"));
  core.port.fail = () => Promise.reject(new Error("Kern weg"));
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.calls).toEqual(["ask", "cancel"]);
  expect(update.snapshot()).toMatchObject({ phase: "failed", error: "Error: IPC kaputt" });
});

test("lädt das fragende Fenster neu, endet seine Rückfrage", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore({ ...offered, phase: "confirm" });
  const other = new AppUpdate(core.portFor("zweites"));
  await settled();
  expect(core.calls).toEqual([]);

  // Das fragende Fenster beginnt nach dem Neuladen mit einem neuen Ablauf.
  new AppUpdate(core.port);
  await settled();

  expect(core.calls).toEqual(["cancel"]);
  expect(other.snapshot().phase).toBe("offered");
});

test("die Aufteilung wird erst nach dem Download gespeichert, unmittelbar vor der Installation", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [{ ...offered, phase: "downloading", progress: 0 }]);
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  const order = core.calls;
  expect(order.indexOf("save")).toBeGreaterThan(order.indexOf("download"));
  expect(order.slice(-2)).toEqual(["save", "install"]);
});

test("ein Anlass, der während des Downloads entsteht, löst vor der Installation eine Rückfrage aus", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered, [{ ...offered, phase: "downloading", progress: 0 }]);
  core.whileDownloading(() => core.setWindows([quiet, { ...quiet, workingAgents: 1 }]));
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toEqual([{ ...quiet, workingAgents: 1 }]);
  expect(core.calls).toEqual([
    "ask",
    "reasons",
    "download",
    "reasons",
    "confirm",
    "save",
    "install",
  ]);
});

test("„Später“ in der Rückfrage nach dem Download installiert nicht", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(
    offered,
    [{ ...offered, phase: "downloading", progress: 0 }],
    [quiet],
    false,
  );
  core.whileDownloading(() => core.setWindows([{ ...quiet, unsavedFiles: 1 }]));
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.calls).toEqual(["ask", "reasons", "download", "reasons", "confirm", "cancel"]);
  expect(update.snapshot().phase).toBe("offered");
});

test("ohne neuen Anlass nach dem Download fragt Kredr kein zweites Mal", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const busy = { ...quiet, workingAgents: 2, unsavedFiles: 1 };
  const core = fakeCore(offered, [], [busy]);
  // Ein Agent ist fertig geworden; das ist weniger, nicht neu.
  core.whileDownloading(() => core.setWindows([{ ...busy, workingAgents: 1 }]));
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.asked).toEqual([busy]);
  expect(core.calls.slice(-2)).toEqual(["save", "install"]);
});

test("scheitert der Download, wird weder gespeichert noch installiert", async () => {
  const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };
  const core = fakeCore(offered);
  core.port.download = async () => {
    core.calls.push("download");
    core.announce({ ...offered, phase: "failed", cause: "network", error: "timeout" });
    return false;
  };
  const update = new AppUpdate(core.port);
  await settled();

  await update.updateNow();

  expect(core.calls).toEqual(["ask", "reasons", "download"]);
  expect(update.snapshot().phase).toBe("failed");
});
