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
import { updateQuestion, type UpdateReasons } from "./updateReasons";

const none: AppUpdateState = {
  phase: "none",
  version: null,
  installed: "0.5.0",
  progress: null,
  hidden: false,
  cause: null,
  error: null,
  asker: null,
  reasons: null,
};

const offered: AppUpdateState = { ...none, phase: "offered", version: "0.6.0" };

const quiet: UpdateReasons = {
  unsavedFiles: 0,
  runningProcesses: 0,
  workingAgents: 0,
  backgroundAgents: 0,
  silentWindows: 0,
};

/**
 * Die Ports der Fenster zu einem Kern ohne eigenen Ablauf: `announce` meldet
 * allen Fenstern einen neuen Zustand, wie es der Kern tut. `portFor` ist der Port des Fensters `window`; was die
 * Fenster aufrufen, steht in `calls`, und `answer` ist die Antwort der
 * Person im Dialog der Rückfrage.
 */
function fakePorts(initial: AppUpdateState, answer: () => Promise<boolean> = async () => true) {
  const listeners = new Set<(state: AppUpdateState) => void>();
  const calls: string[] = [];
  let state = initial;
  const announce = (next: AppUpdateState) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  const portFor = (window: string): AppUpdatePort => {
    const named = (call: string) => (window === "main" ? call : `${call} ${window}`);
    return {
      window: () => window,
      current: async () => state,
      check: async () => {
        calls.push(named("check"));
        throw new Error("Kern nicht erreichbar");
      },
      onChange: (listener) => {
        listeners.add(listener);
      },
      updateNow: async () => {
        calls.push(named("updateNow"));
      },
      confirm: async (reasons) => {
        calls.push(named(`confirm ${updateQuestion(de, reasons).split(".")[0]}`));
        return answer();
      },
      answer: async (proceed) => {
        calls.push(named(`answer ${proceed}`));
      },
      cancel: async () => {
        calls.push(named("cancel"));
      },
      fail: async (error) => {
        calls.push(named(`fail ${error}`));
        return true;
      },
      later: async () => {
        calls.push(named("later"));
      },
      openUrl: (url) => calls.push(`open ${url}`),
    };
  };
  return { port: portFor("main"), portFor, announce, calls };
}

/** Ein Fenster, das schon geladen hat; den Aufruf beim Laden vergisst `calls`. */
async function windowOf(core: ReturnType<typeof fakePorts>, label = "main") {
  const update = new AppUpdate(core.portFor(label));
  await settled();
  core.calls.length = 0;
  return update;
}

/** Wartet, bis alle anstehenden Antworten angekommen sind. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

const de: Translate = (key, values) => translate("de", key, values);

test("erreicht „Jetzt suchen“ den Kern nicht, gilt die Suche als gescheitert", async () => {
  const core = fakePorts(none);
  const update = await windowOf(core);

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
  const core = fakePorts(none);
  const update = await windowOf(core);

  core.announce(offered);

  expect(update.snapshot()).toMatchObject({
    phase: "offered",
    version: "0.6.0",
    installed: "0.5.0",
  });
});

test("„Jetzt aktualisieren“ gibt den Auftrag an den Kern, einmal", async () => {
  const core = fakePorts(offered);
  const update = await windowOf(core);

  await update.updateNow();
  core.announce({ ...offered, phase: "downloading", progress: 0 });
  await update.updateNow();

  expect(core.calls).toEqual(["updateNow"]);
});

test("ohne Angebot stößt „Jetzt aktualisieren“ nichts an", async () => {
  const core = fakePorts(none);
  const update = await windowOf(core);

  await update.updateNow();

  expect(core.calls).toEqual([]);
});

test("erreicht der Auftrag den Kern nicht, zeigt der Hinweis den Fehlschlag mit Originaltext", async () => {
  const core = fakePorts(offered);
  const port = core.portFor("main");
  port.updateNow = () => Promise.reject(new Error("IPC kaputt"));
  const update = new AppUpdate(port);
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
  const core = fakePorts(offered);
  const update = await windowOf(core);

  core.announce({ ...offered, phase: "downloading", progress: 42 });

  expect(update.snapshot().progress).toBe(42);
  expect(showsNotice(update.snapshot())).toBe(true);
  expect(showsIcon(update.snapshot())).toBe(false);
});

test("ist der Hinweis zum Download weggeklickt, zeigt das Symbol den Fortschritt", async () => {
  const core = fakePorts(none);
  const update = await windowOf(core);

  core.announce({ ...offered, phase: "downloading", progress: 42, hidden: true });

  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(true);
  expect(update.snapshot().progress).toBe(42);
});

test("die Installation zeigt den Hinweis auch nach dem Wegklicken", async () => {
  const core = fakePorts(none);
  const update = await windowOf(core);

  core.announce({ ...offered, phase: "installing", hidden: true });

  expect(showsNotice(update.snapshot())).toBe(true);
});

test.each([
  ["network", "Keine Verbindung zu GitHub."],
  ["signature", "Signatur ungültig."],
  ["installer", "Der Installer ließ sich nicht starten."],
  ["unknown", "Unerwarteter Fehler."],
] as const)("ein Fehlschlag mit Grund %s nennt ihn in einem Satz", async (cause, sentence) => {
  const core = fakePorts(none);
  const update = await windowOf(core);

  core.announce({ ...offered, phase: "failed", cause, error: "error sending request" });

  expect(failureSentence(de, update.snapshot())).toBe(sentence);
  expect(update.snapshot().error).toBe("error sending request");
  expect(offersActions(update.snapshot())).toBe(true);
});

test("scheitert die automatische Suche, meldet Kredr nichts", async () => {
  const core = fakePorts(none);
  const port = core.portFor("main");
  port.current = () => Promise.reject(new Error("keine Verbindung"));
  const update = new AppUpdate(port);
  await settled();

  expect(update.snapshot().phase).toBe("none");
  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(false);
});

test("„Neuerungen“ öffnet die Release-Seite des Tags", async () => {
  const core = fakePorts(offered);
  const update = await windowOf(core);

  update.showReleaseNotes();

  expect(core.calls).toEqual(["open https://github.com/SirKashij/Kredr/releases/tag/v0.6.0"]);
});

test("ein Angebot zeigt den Hinweis, nach „Später“ bleibt nur das Symbol", async () => {
  const core = fakePorts(offered);
  const update = await windowOf(core);
  expect(showsNotice(update.snapshot())).toBe(true);
  expect(showsIcon(update.snapshot())).toBe(false);

  await update.later();
  core.announce({ ...offered, phase: "later" });

  expect(core.calls).toEqual(["later"]);
  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(true);
});

test("nach einem Neustart kommt dieselbe Version nur als Symbol, eine höhere als Hinweis", async () => {
  const core = fakePorts(none);
  const update = await windowOf(core);

  // Der Kern hat sich 0.6.0 gemerkt und meldet sie nach dem Start als „später“.
  core.announce({ ...offered, phase: "later" });
  expect(showsNotice(update.snapshot())).toBe(false);
  expect(showsIcon(update.snapshot())).toBe(true);

  core.announce({ ...offered, version: "0.7.0" });
  expect(showsNotice(update.snapshot())).toBe(true);
  expect(showsIcon(update.snapshot())).toBe(false);
});

test("während der Rückfrage zeigt ein anderes Fenster sie ohne Aktionen", async () => {
  const core = fakePorts(offered);
  const other = await windowOf(core, "zweites");

  core.announce({ ...offered, phase: "confirm", asker: "main" });

  expect(showsNotice(other.snapshot())).toBe(true);
  expect(offersActions(other.snapshot())).toBe(false);
  await other.updateNow();
  await other.later();
  expect(core.calls).toEqual([]);
});

test("eine Rückfrage aus dem Symbol zeigt in den anderen Fenstern nur das Symbol, ohne Menü", async () => {
  const core = fakePorts({ ...offered, phase: "later" });
  const other = await windowOf(core, "zweites");

  core.announce({ ...offered, phase: "confirm", asker: "main", hidden: true });

  expect(showsNotice(other.snapshot())).toBe(false);
  expect(showsIcon(other.snapshot())).toBe(true);
  expect(offersActions(other.snapshot())).toBe(false);
});

test("den Dialog der Rückfrage zeigt nur das fragende Fenster, und es schickt die Antwort", async () => {
  const core = fakePorts(offered, async () => false);
  await windowOf(core, "main");
  await windowOf(core, "zweites");

  core.announce({
    ...offered,
    phase: "confirm",
    asker: "main",
    reasons: { ...quiet, workingAgents: 1 },
  });
  await settled();

  expect(core.calls).toEqual(["confirm 1 Agent arbeitet noch", "answer false"]);
});

test("solange der Kern nur fragt, zeigt auch das fragende Fenster keinen Dialog", async () => {
  const core = fakePorts(offered);
  await windowOf(core, "main");

  // Die Rundfrage läuft noch; Anlässe gibt es erst danach.
  core.announce({ ...offered, phase: "confirm", asker: "main" });
  await settled();

  expect(core.calls).toEqual([]);
});

test("scheitert der Dialog, meldet das fragende Fenster den Fehlschlag", async () => {
  const core = fakePorts(offered, () => Promise.reject(new Error("Dialog kaputt")));
  await windowOf(core, "main");

  core.announce({
    ...offered,
    phase: "confirm",
    asker: "main",
    reasons: { ...quiet, unsavedFiles: 1 },
  });
  await settled();

  expect(core.calls.at(-1)).toBe("fail Error: Dialog kaputt");
});

test("lädt ein Fenster neu, gibt es seine Rückfrage im Kern auf", async () => {
  const core = fakePorts({ ...offered, phase: "confirm", asker: "main" });

  new AppUpdate(core.portFor("main"));
  await settled();

  expect(core.calls).toEqual(["cancel"]);
});

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
