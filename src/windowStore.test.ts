import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  emptyArrangement,
  openContent,
  openTab,
  openTabIn,
  recordConversation,
  tabsOf,
  type Arrangement,
  type Conversation,
} from "./arrangement";
import {
  ArrangementSaver,
  restoreStored,
  WindowStore,
  type ClosingQuestion,
  type Renaming,
  type WindowCore,
  type WindowStoreOptions,
} from "./windowStore";
import { projectsOf, startPage, type WindowContent } from "./workspace";

const alpha = "C:\\Alpha";
const beta = "C:\\Beta";
const gamma = "C:\\Gamma";

/** Ein Kern im Speicher: was er zeigt, was er gespeichert hat und in welcher Reihenfolge er gefragt wurde. */
class FakeCore implements WindowCore {
  /** Was das Fenster laut Kern zeigt. */
  shown: WindowContent = startPage;
  /** Gespeicherte Aufteilungen, nach Projektordner bzw. Kennung des Workspace. */
  readonly stored = new Map<string, unknown>();
  /** Gespeicherte Workspaces. */
  readonly workspaces = new Map<string, { name: string; projects: string[] }>();
  /** Projekte, die in einem anderen Fenster offen sind. */
  readonly elsewhere = new Set<string>();
  /** Jeder Aufruf mit Namen, in Reihenfolge. */
  readonly calls: string[] = [];
  /** Befehle, deren nächster Aufruf scheitert. */
  private readonly failing = new Set<string>();
  private held: Array<() => void> | null = null;

  /** Der nächste Aufruf von `command` scheitert. */
  fail(command: string) {
    this.failing.add(command);
  }

  /** Hält jedes Laden der Aufteilung an, bis die gelieferte Funktion es freigibt. */
  holdLoads(): () => void {
    this.held = [];
    return () => {
      const waiting = this.held ?? [];
      this.held = null;
      waiting.forEach((release) => release());
    };
  }

  count(command: string): number {
    return this.calls.filter((call) => call === command).length;
  }

  private owner(): string | null {
    if (this.shown.kind === "workspace") return this.shown.id;
    if (this.shown.kind === "project") return this.shown.path;
    return null;
  }

  private call(command: string) {
    this.calls.push(command);
    if (this.failing.delete(command)) throw new Error(`${command} scheiterte`);
  }

  async openProject(folder: string) {
    this.call("openProject");
    if (this.elsewhere.has(folder)) return null;
    this.shown = { kind: "project", path: folder };
    return this.shown;
  }

  async openWorkspace(id: string) {
    this.call("openWorkspace");
    const workspace = this.workspaces.get(id)!;
    if (workspace.projects.some((project) => this.elsewhere.has(project))) {
      return { kind: "openElsewhere" } as const;
    }
    this.shown = { kind: "workspace", id, ...workspace };
    return { kind: "opened", content: this.shown } as const;
  }

  async addProject(content: WindowContent) {
    this.call("addProject");
    if (projectsOf(content).some((project) => this.elsewhere.has(project))) {
      return { kind: "openElsewhere" } as const;
    }
    if (content.kind !== "workspace") throw new Error("kein Workspace");
    // Ein neuer Workspace übernimmt, was für das Projekt gespeichert ist.
    if (this.shown.kind === "project")
      this.stored.set(content.id, this.stored.get(this.shown.path));
    this.shown = content;
    return { kind: "added", content } as const;
  }

  async removeProject(project: string, arrangement: Arrangement) {
    this.call("removeProject");
    if (this.shown.kind !== "workspace") throw new Error("kein Workspace");
    this.shown = {
      ...this.shown,
      projects: this.shown.projects.filter((open) => open !== project),
    };
    this.stored.set(this.shown.id, arrangement);
    return this.shown;
  }

  async reorderProjects(projects: readonly string[]) {
    this.call("reorderProjects");
    if (this.shown.kind !== "workspace") throw new Error("kein Workspace");
    this.shown = { ...this.shown, projects: [...projects] };
    return this.shown;
  }

  async renameWorkspace(name: string) {
    this.call("renameWorkspace");
    if (this.shown.kind !== "workspace") throw new Error("kein Workspace");
    this.shown = { ...this.shown, name };
    return this.shown;
  }

  async closeWorkspace() {
    this.call("closeWorkspace");
    this.shown = startPage;
  }

  async loadArrangement() {
    this.call("loadArrangement");
    const owner = this.owner();
    if (this.held) await new Promise<void>((release) => this.held!.push(release));
    return owner === null ? null : (this.stored.get(owner) ?? null);
  }

  async saveArrangement(arrangement: Arrangement) {
    this.call("saveArrangement");
    const owner = this.owner();
    if (owner !== null) this.stored.set(owner, JSON.parse(JSON.stringify(arrangement)));
  }

  async loadProjectArrangement(project: string) {
    this.call("loadProjectArrangement");
    return this.stored.get(project) ?? null;
  }

  async saveProjectArrangement(project: string, arrangement: Arrangement) {
    this.call("saveProjectArrangement");
    this.stored.set(project, JSON.parse(JSON.stringify(arrangement)));
  }

  async filesExist(_project: string, paths: readonly string[]) {
    return paths.map(() => true);
  }

  async foldersAmong(paths: readonly string[]) {
    return paths.filter((path) => !path.includes("."));
  }
}

/** Ein Fenster mit seinem Store; die Rückfragen beantwortet `answer`. */
function windowWith(core = new FakeCore(), options: Partial<WindowStoreOptions> = {}) {
  const resumed: Array<{ stored: Arrangement; project: string }> = [];
  const questions: ClosingQuestion[] = [];
  const renamed: Renaming[] = [];
  const answer = { yes: true, during: () => {} };
  const store = new WindowStore({
    core,
    settings: () => ({ resumeAgents: true }),
    settle: (arrangement) => arrangement,
    untitledName: () => "Unbenannt",
    resume: (stored, project) => resumed.push({ stored, project }),
    mayClose: async (question) => {
      questions.push(question);
      answer.during();
      return answer.yes;
    },
    renameFiles: (pairs) => renamed.push(...pairs),
    ...options,
  });
  return { core, store, resumed, questions, renamed, answer };
}

const conversation: Conversation = { agent: "claudeCode", id: "gespraech-1" };

/** Eine Aufteilung mit einem Agenten, der ein Gespräch hat, gestartet in `cwd`. */
function agentIn(cwd: string | undefined, talk: Conversation = conversation): Arrangement {
  const opened =
    cwd === undefined ? openTab(emptyArrangement, true) : openTabIn(emptyArrangement, cwd, true);
  return recordConversation(opened, tabsOf(opened)[0].id, talk);
}

/** Wartet, bis alle ausstehenden Aufrufe an den Kern beantwortet sind. */
async function settled() {
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// --- Laden ---

test("ein geöffnetes Projekt lädt seine gespeicherte Aufteilung genau einmal und setzt die Agenten einmal fort", async () => {
  const core = new FakeCore();
  core.stored.set(alpha, agentIn(undefined));
  const { store, resumed } = windowWith(core);

  await store.open(alpha);
  await settled();
  store.show({ kind: "project", path: alpha });
  await settled();

  expect(core.count("loadArrangement")).toBe(1);
  expect(store.snapshot().restored).toBe(true);
  expect(tabsOf(store.snapshot().arrangement)[0].conversation).toEqual(conversation);
  expect(resumed).toHaveLength(1);
  expect(resumed[0].project).toBe(alpha);
});

test("ohne gespeicherte Aufteilung beginnt ein Projekt mit einem Terminal", async () => {
  const { store } = windowWith();

  await store.open(alpha);
  await settled();

  expect(tabsOf(store.snapshot().arrangement)).toHaveLength(1);
});

test("ist beim Laden schon ein Terminal entstanden, bleibt die gespeicherte Aufteilung ungenutzt", async () => {
  const core = new FakeCore();
  core.stored.set(alpha, agentIn(undefined));
  const release = core.holdLoads();
  const { store, resumed } = windowWith(core);

  await store.open(alpha);
  store.change((current) => openTabIn(current, "C:\\Alpha\\neu"));
  release();
  await settled();

  expect(tabsOf(store.snapshot().arrangement)).toEqual([{ id: "t1", cwd: "C:\\Alpha\\neu" }]);
  expect(resumed).toEqual([]);
  expect(store.snapshot().restored).toBe(true);
});

test("erst nach dem Laden wird gespeichert, danach jede Änderung", async () => {
  const { core, store } = windowWith();

  store.change(openTab);
  vi.advanceTimersByTime(1000);
  expect(core.count("saveArrangement")).toBe(0);

  await store.open(alpha);
  await settled();
  store.change(openTab);
  vi.advanceTimersByTime(1000);
  await settled();

  expect(core.count("saveArrangement")).toBe(1);
  expect(tabsOf(core.stored.get(alpha) as Arrangement)).toHaveLength(2);
});

// --- Hinzufügen ---

test("beim Hinzufügen ist die Aufteilung gespeichert, bevor der Kern gefragt wird", async () => {
  const { core, store } = windowWith();
  await store.open(alpha);
  await settled();
  store.change(openTab);

  const outcome = await store.add(beta);

  expect(outcome).toEqual({ kind: "becameWorkspace", from: alpha, name: "Unbenannt" });
  const order = core.calls.filter((call) => call === "saveArrangement" || call === "addProject");
  expect(order).toEqual(["saveArrangement", "addProject"]);
});

test("aus einem Projekt wird ein Workspace, der die laufende Aufteilung behält und nichts neu lädt", async () => {
  const { core, store, resumed } = windowWith();
  await store.open(alpha);
  await settled();
  store.change(openTab);
  const running = store.snapshot().arrangement;
  resumed.length = 0;

  await store.add(beta);
  await settled();

  const { content, arrangement } = store.snapshot();
  expect(content).toMatchObject({ kind: "workspace", name: "Unbenannt", projects: [alpha, beta] });
  expect(arrangement).toBe(running);
  expect(core.count("loadArrangement")).toBe(1);
  expect(resumed).toHaveLength(0);
});

test("ein weiteres Projekt kommt im Workspace hinten an", async () => {
  const { store } = windowWith();
  await store.open(alpha);
  await store.add(beta);

  expect(await store.add(gamma)).toEqual({ kind: "added" });
  expect(projectsOf(store.snapshot().content)).toEqual([alpha, beta, gamma]);
});

test("ein schon enthaltenes Projekt kommt nicht hinzu, und nichts ändert sich", async () => {
  const { core, store } = windowWith();
  await store.open(alpha);
  await settled();
  const before = store.snapshot();

  expect(await store.add(alpha)).toEqual({ kind: "alreadyContained" });
  expect(store.snapshot()).toBe(before);
  expect(core.count("addProject")).toBe(0);
});

test("ein anderswo offenes Projekt kommt nicht hinzu, und nichts ändert sich", async () => {
  const { core, store } = windowWith();
  core.elsewhere.add(beta);
  await store.open(alpha);
  await settled();
  const before = store.snapshot();

  expect(await store.add(beta)).toEqual({ kind: "openElsewhere" });
  expect(store.snapshot()).toBe(before);
});

test("gezogene Ordner kommen nacheinander hinzu, Dateien nicht", async () => {
  const { store } = windowWith();
  await store.open(alpha);

  const outcomes = await store.addFolders([beta, "C:\\notiz.txt", gamma]);

  expect(outcomes.map(({ folder, outcome }) => [folder, outcome.kind])).toEqual([
    [beta, "becameWorkspace"],
    [gamma, "added"],
  ]);
  expect(projectsOf(store.snapshot().content)).toEqual([alpha, beta, gamma]);
});

// --- Umbenennen ---

/** Ein Fenster mit dem geladenen Workspace aus `projects`. */
async function workspaceWindow(projects: string[], stored?: Arrangement) {
  const window = windowWith();
  window.core.workspaces.set("ws", { name: "Arbeit", projects });
  if (stored) window.core.stored.set("ws", stored);
  await window.store.openWorkspace("ws");
  await settled();
  return window;
}

test("ein leerer oder gleicher Name ändert nichts", async () => {
  const { core, store } = await workspaceWindow([alpha]);

  expect(await store.rename("  ")).toEqual({ kind: "unchanged" });
  expect(await store.rename(" Arbeit ")).toEqual({ kind: "unchanged" });
  expect(core.count("renameWorkspace")).toBe(0);
});

test("vor dem Umbenennen wird Ausstehendes gespeichert", async () => {
  const { core, store } = await workspaceWindow([alpha]);
  store.change(openTab);

  expect(await store.rename("Neu")).toEqual({ kind: "renamed" });

  const order = core.calls.filter(
    (call) => call === "saveArrangement" || call === "renameWorkspace",
  );
  expect(order).toEqual(["saveArrangement", "renameWorkspace"]);
  expect(store.snapshot().content).toMatchObject({ kind: "workspace", name: "Neu" });
});

// --- Umsortieren ---

test("rückt ein anderes Projekt nach vorn, bleiben die Tabs des bisher ersten bei ihm", async () => {
  let arrangement = openTab(emptyArrangement);
  arrangement = openContent(arrangement, { kind: "file", path: "src/a.ts" });
  const { store, renamed } = await workspaceWindow([alpha, beta], arrangement);

  const outcome = await store.move(beta, 0);

  const moved: Renaming[] = [["src/a.ts", "C:/Alpha/src/a.ts"]];
  expect(outcome).toEqual({ kind: "moved", renamed: moved });
  expect(renamed).toEqual(moved);
  expect(projectsOf(store.snapshot().content)).toEqual([beta, alpha]);
  expect(tabsOf(store.snapshot().arrangement)).toEqual([
    { id: "t1", cwd: alpha },
    { id: "t3", content: { kind: "file", path: "C:/Alpha/src/a.ts" } },
  ]);
});

test("an dieselbe Stelle verschoben ändert sich nichts", async () => {
  const { core, store } = await workspaceWindow([alpha, beta]);

  expect(await store.move(alpha, 1)).toEqual({ kind: "unchanged" });
  expect(core.count("reorderProjects")).toBe(0);
});

// --- Entfernen ---

test("beim Entfernen landen die Gespräche der Agenten genau einmal in der Aufteilung des Projekts", async () => {
  // Der Workspace entstand aus Beta: Dessen Aufteilung kennt das Gespräch schon.
  const running = openTabIn(agentIn(beta), alpha);
  const { core, store, questions } = await workspaceWindow([alpha, beta], running);
  core.stored.set(beta, agentIn(undefined));

  expect(await store.remove(beta)).toEqual({ kind: "removed" });

  expect(questions).toEqual([
    { kind: "removeProject", project: beta, closing: [tabsOf(running)[0]] },
  ]);
  const kept = tabsOf(core.stored.get(beta) as Arrangement);
  expect(kept.filter((tab) => tab.conversation?.id === conversation.id)).toHaveLength(1);
  expect(projectsOf(store.snapshot().content)).toEqual([alpha]);
  expect(tabsOf(store.snapshot().arrangement)).toEqual([{ id: "t3", cwd: alpha }]);
  expect(tabsOf(core.stored.get("ws") as Arrangement)).toEqual([{ id: "t3", cwd: alpha }]);
});

test("sagt die Person beim Entfernen Nein, ändert sich nichts", async () => {
  const { core, store, answer } = await workspaceWindow([alpha, beta], agentIn(beta));
  answer.yes = false;
  const before = store.snapshot();

  expect(await store.remove(beta)).toEqual({ kind: "declined" });
  expect(store.snapshot()).toBe(before);
  expect(core.count("removeProject")).toBe(0);
  expect(core.count("saveProjectArrangement")).toBe(0);
});

test("ändert sich während der Rückfrage etwas, gilt beim Entfernen der neue Stand", async () => {
  const later: Conversation = { agent: "claudeCode", id: "gespraech-2" };
  const { core, store, answer } = await workspaceWindow([alpha, beta], agentIn(beta));
  answer.during = () =>
    store.change((current) => {
      const opened = openTabIn(current, beta, true);
      return recordConversation(opened, tabsOf(opened).at(-1)!.id, later);
    });

  expect(await store.remove(beta)).toEqual({ kind: "removed" });

  const kept = tabsOf(core.stored.get(beta) as Arrangement).map((tab) => tab.conversation?.id);
  expect(kept).toEqual([conversation.id, later.id]);
  expect(tabsOf(store.snapshot().arrangement)).toEqual([]);
});

// --- Schließen ---

test("nach dem Schließen zeigt das Fenster die Startseite und speichert nichts mehr", async () => {
  const { core, store, questions } = await workspaceWindow([alpha]);
  store.change(openTab);

  expect(await store.closeWorkspace()).toEqual({ kind: "closed" });
  expect(questions).toEqual([{ kind: "closeWorkspace" }]);
  expect(store.snapshot()).toEqual({
    content: startPage,
    arrangement: emptyArrangement,
    restored: false,
  });
  const saves = core.count("saveArrangement");

  store.change(openTab);
  vi.advanceTimersByTime(1000);
  await settled();

  expect(core.count("saveArrangement")).toBe(saves);
});

test("sagt die Person beim Schließen Nein, bleibt der Workspace", async () => {
  const { core, store, answer } = await workspaceWindow([alpha]);
  answer.yes = false;

  expect(await store.closeWorkspace()).toEqual({ kind: "declined" });
  expect(core.count("closeWorkspace")).toBe(0);
  expect(store.snapshot().content.kind).toBe("workspace");
});

// --- Fehler des Kerns ---

test.each([
  ["openProject", (store: WindowStore) => store.open(gamma)],
  ["openWorkspace", (store: WindowStore) => store.openWorkspace("ws")],
  ["addProject", (store: WindowStore) => store.add(gamma)],
  ["renameWorkspace", (store: WindowStore) => store.rename("Neu")],
  ["reorderProjects", (store: WindowStore) => store.move(beta, 0)],
  ["removeProject", (store: WindowStore) => store.remove(beta)],
  ["closeWorkspace", (store: WindowStore) => store.closeWorkspace()],
])(
  "scheitert %s im Kern, bleiben Fensterinhalt und Aufteilung wie vorher",
  async (command, act) => {
    const { core, store } = await workspaceWindow([alpha, beta], agentIn(beta));
    const before = store.snapshot();
    core.fail(command);

    const outcome = await act(store);

    expect(outcome).toEqual({ kind: "failed", details: `Error: ${command} scheiterte` });
    expect(store.snapshot()).toBe(before);
  },
);

// --- Laufendes Speichern ---

const one = openTab(emptyArrangement);
const two = openTab(one);

/** Ein Speicher, der festhält, was bei ihm ankommt. */
function recorder() {
  const saved: unknown[] = [];
  const save = async (arrangement: unknown) => {
    saved.push(arrangement);
  };
  return { saved, save };
}

test("eine geänderte Aufteilung wird kurz darauf von selbst gespeichert", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);

  saver.changed(one);
  expect(saved).toEqual([]);
  vi.advanceTimersByTime(500);

  expect(saved).toEqual([one]);
});

test("viele Änderungen kurz nacheinander ergeben ein Speichern mit dem letzten Stand", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);

  saver.changed(one);
  vi.advanceTimersByTime(300);
  saver.changed(two);
  vi.advanceTimersByTime(300);
  expect(saved).toEqual([]);
  vi.advanceTimersByTime(200);

  expect(saved).toEqual([two]);
});

test("ein verschobenes Fenster speichert die Aufteilung erneut", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);
  saver.changed(one);
  vi.advanceTimersByTime(500);

  saver.windowChanged();
  vi.advanceTimersByTime(500);

  expect(saved).toEqual([one, one]);
});

test("solange keine Aufteilung bekannt ist, speichert ein verschobenes Fenster nichts", () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);

  saver.windowChanged();
  vi.advanceTimersByTime(500);

  expect(saved).toEqual([]);
});

test("beim Schließen des Fensters wird Ausstehendes sofort gespeichert, sonst nichts", async () => {
  const { saved, save } = recorder();
  const saver = new ArrangementSaver(save, 500);
  saver.changed(one);

  await saver.flush();
  expect(saved).toEqual([one]);

  await saver.flush();
  vi.advanceTimersByTime(500);
  expect(saved).toEqual([one]);
});

test("ein gescheitertes Speichern bleibt folgenlos; die nächste Änderung speichert wieder", async () => {
  const saved: unknown[] = [];
  let fail = true;
  const saver = new ArrangementSaver(async (arrangement) => {
    if (fail) throw new Error("Datenträger voll");
    saved.push(arrangement);
  }, 500);

  saver.changed(one);
  await saver.flush();
  fail = false;
  saver.changed(two);
  await saver.flush();

  expect(saved).toEqual([two]);
});

test("beim Wiederherstellen entfällt genau das, was es laut Kern nicht mehr gibt", async () => {
  let arrangement = openTabIn(emptyArrangement, "C:\\Projekt\\weg");
  arrangement = openContent(arrangement, { kind: "file", path: "src/da.ts" });
  arrangement = openContent(arrangement, { kind: "file", path: "src/weg.ts" });
  const asked: string[][] = [];

  const restored = await restoreStored(JSON.parse(JSON.stringify(arrangement)), async (paths) => {
    asked.push(paths);
    return paths.map((path) => !path.includes("weg"));
  });

  expect(asked).toEqual([["C:\\Projekt\\weg", "src/da.ts", "src/weg.ts"]]);
  expect(tabsOf(restored)).toEqual([
    { id: "t1" },
    { id: "t3", content: { kind: "file", path: "src/da.ts" } },
  ]);
});

test("eine nicht lesbare gespeicherte Aufteilung ergibt die leere, ohne den Kern zu fragen", async () => {
  const restored = await restoreStored("kaputt", async () => {
    throw new Error("sollte nicht gefragt werden");
  });

  expect(restored).toEqual(emptyArrangement);
});
