import { expect, test } from "vitest";
import type { AgentState, AgentStatus } from "./agentStatus";
import {
  emptyArrangement,
  restoreArrangement,
  tabsOf,
  type Arrangement,
  type Tab,
} from "./arrangement";
import {
  activeProject,
  addProject,
  agentSections,
  firstProject,
  groupByProject,
  isSectionCollapsed,
  keepConversations,
  moveProject,
  projectOf,
  projectOfTab,
  projectsOf,
  removalInterrupts,
  removeProject,
  renameWorkspace,
  startPage,
  tabDescriptions,
  toggleSection,
  workspaceFiles,
  type WindowContent,
} from "./workspace";

const single: WindowContent = { kind: "project", path: "C:\\Projekte\\Kredr" };
const workspace: WindowContent = {
  kind: "workspace",
  id: "workspace-1",
  name: "Unbenannt",
  projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Kern"],
};

test("die Startseite zeigt kein Projekt", () => {
  expect(projectsOf(startPage)).toEqual([]);
  expect(firstProject(startPage)).toBeNull();
});

test("ein Projektfenster zeigt genau sein Projekt", () => {
  expect(projectsOf(single)).toEqual(["C:\\Projekte\\Kredr"]);
  expect(firstProject(single)).toBe("C:\\Projekte\\Kredr");
});

test("ein Workspace zeigt seine Projekte in Reihenfolge, das erste zuerst", () => {
  expect(projectsOf(workspace)).toEqual(["C:\\Projekte\\Web", "C:\\Projekte\\Kern"]);
  expect(firstProject(workspace)).toBe("C:\\Projekte\\Web");
});

test("ein leerer Workspace hat kein erstes Projekt", () => {
  const empty: WindowContent = { ...workspace, projects: [] };

  expect(projectsOf(empty)).toEqual([]);
  expect(firstProject(empty)).toBeNull();
});

const untitled = { id: "workspace-2", name: "Unbenannt" };

test("ein zweites Projekt macht aus dem Projektfenster den Workspace „Unbenannt“", () => {
  expect(addProject(single, "C:\\Projekte\\Web", untitled)).toEqual({
    kind: "added",
    content: {
      kind: "workspace",
      id: "workspace-2",
      name: "Unbenannt",
      projects: ["C:\\Projekte\\Kredr", "C:\\Projekte\\Web"],
    },
  });
});

test("ein Workspace bekommt das Projekt hinten angefügt und behält Kennung und Namen", () => {
  expect(addProject(workspace, "C:\\Projekte\\Notizen", untitled)).toEqual({
    kind: "added",
    content: {
      ...workspace,
      projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Kern", "C:\\Projekte\\Notizen"],
    },
  });
});

test("ein schon enthaltenes Projekt wird abgelehnt, gleich in welcher Schreibweise", () => {
  const refused = { kind: "refused", reason: "alreadyContained" };

  expect(addProject(single, "c:\\projekte\\KREDR", untitled)).toEqual(refused);
  expect(addProject(workspace, "C:\\Projekte\\Kern\\", untitled)).toEqual(refused);
  expect(addProject(workspace, "C:/Projekte/Web", untitled)).toEqual(refused);
});

test("eine Datei gehört zu dem Projekt, in dessen Ordner sie liegt, sonst zu keinem", () => {
  const projects = ["C:\\Projekte\\Web", "C:\\Projekte\\Web\\Kern", "C:\\Projekte\\Webseite"];

  expect(projectOf(projects, "C:\\Projekte\\Web\\index.html")).toBe("C:\\Projekte\\Web");
  // Bei verschachtelten Projekten gewinnt das innere.
  expect(projectOf(projects, "c:/projekte/web/KERN/src/main.rs")).toBe("C:\\Projekte\\Web\\Kern");
  expect(projectOf(projects, "C:\\Projekte\\Webseite")).toBe("C:\\Projekte\\Webseite");
  expect(projectOf(projects, "C:\\Projekte\\Webs\\a.txt")).toBeNull();
  expect(projectOf(projects, "D:\\temp\\a.txt")).toBeNull();
});

// Ein Workspace mit drei Projekten und Tabs aus allen: Terminals ohne
// Startordner gehören zum ersten Projekt, Dateien mit relativem Pfad ebenso.
const three: WindowContent = {
  kind: "workspace",
  id: "workspace-1",
  name: "Arbeit",
  projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Kern", "C:\\Projekte\\Notizen"],
};
const mixed: Arrangement = {
  version: 1,
  root: {
    kind: "split",
    id: "s9",
    axis: "row",
    sizes: [0.5, 0.5],
    children: [
      {
        kind: "group",
        id: "g1",
        activeTab: "t2",
        tabs: [
          { id: "t1", agent: true, shell: "powershell" },
          { id: "t2", content: { kind: "file", path: "src/index.ts" } },
          { id: "t3", content: { kind: "versionControl" } },
        ],
      },
      {
        kind: "group",
        id: "g2",
        activeTab: "t4",
        tabs: [
          { id: "t4", agent: true, cwd: "C:\\Projekte\\Kern\\src" },
          { id: "t5", content: { kind: "file", path: "C:/Projekte/Kern/main.rs" } },
          { id: "t6", cwd: "D:\\temp" },
          { id: "t7", content: { kind: "markdown", path: "C:/Projekte/Notizen/ideen.md" } },
        ],
      },
    ],
  },
  focusedGroup: "g2",
  nextId: 10,
};
const ids = (tabs: readonly Tab[]) => tabs.map((tab) => tab.id);

test("die Agenten-Ansicht gruppiert Terminals nach Projekten in der Reihenfolge des Workspace", () => {
  const sections = agentSections(three.projects, tabsOf(mixed));

  // Dateien und die Versionskontrolle stehen nicht in der Agenten-Ansicht;
  // ein Projekt ohne Terminals behält seinen Abschnitt, „Außerhalb“ kommt zuletzt.
  expect(sections.map((section) => [section.project, ids(section.tabs)])).toEqual([
    ["C:\\Projekte\\Web", ["t1"]],
    ["C:\\Projekte\\Kern", ["t4"]],
    ["C:\\Projekte\\Notizen", []],
    [null, ["t6"]],
  ]);
});

test("zugeklappte Abschnitte stehen in der Aufteilung und überstehen das Speichern", () => {
  const folded = toggleSection(toggleSection(mixed, "C:\\Projekte\\Kern"), null);
  const reopened = restoreArrangement(JSON.parse(JSON.stringify(folded)));

  expect(isSectionCollapsed(reopened, "c:/projekte/kern/")).toBe(true);
  expect(isSectionCollapsed(reopened, null)).toBe(true);
  expect(isSectionCollapsed(reopened, "C:\\Projekte\\Web")).toBe(false);
  expect(tabsOf(reopened)).toEqual(tabsOf(restoreArrangement(mixed)));

  const unfolded = toggleSection(reopened, "C:\\Projekte\\Kern");
  expect(isSectionCollapsed(unfolded, "C:\\Projekte\\Kern")).toBe(false);
  expect(isSectionCollapsed(unfolded, null)).toBe(true);
});

test("zugeklappte Abschnitte bleiben auch ohne offenen Tab gespeichert", () => {
  const folded = toggleSection(emptyArrangement, "C:\\Projekte\\Web");
  const reopened = restoreArrangement(JSON.parse(JSON.stringify(folded)));

  expect(isSectionCollapsed(reopened, "C:\\Projekte\\Web")).toBe(true);
  expect(restoreArrangement({ ...folded, collapsedSections: [3, null] })).toEqual(emptyArrangement);
});

test("ohne Terminal außerhalb der Projekte gibt es keinen Abschnitt dafür", () => {
  const inside: Tab[] = [
    { id: "t1", agent: true, cwd: "c:/projekte/web/KERN" },
    { id: "t2", cwd: "C:\\Projekte\\Web" },
  ];
  const sections = agentSections(["C:\\Projekte\\Web", "C:\\Projekte\\Web\\Kern"], inside);

  // Das verschachtelte Projekt gewinnt, Groß- und Kleinschreibung zählt nicht.
  expect(sections.map((section) => [section.project, ids(section.tabs)])).toEqual([
    ["C:\\Projekte\\Web", ["t2"]],
    ["C:\\Projekte\\Web\\Kern", ["t1"]],
  ]);
});

test("beim Entfernen schließen genau die Terminals und Dateien des Projekts", () => {
  const removal = removeProject(three, mixed, "c:/projekte/kern")!;

  expect(ids(removal.closing)).toEqual(["t4", "t5"]);
  expect(removal.content).toEqual({
    ...three,
    projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Notizen"],
  });
  expect(ids(tabsOf(removal.arrangement))).toEqual(["t1", "t2", "t3", "t6", "t7"]);
});

test("mit dem ersten Projekt schließen Terminals ohne Startordner und Dateien mit relativem Pfad", () => {
  const removal = removeProject(three, mixed, "C:\\Projekte\\Web")!;

  expect(ids(removal.closing)).toEqual(["t1", "t2"]);
  // Die Versionskontrolle folgt dann dem nächsten Projekt.
  expect(ids(tabsOf(removal.arrangement))).toEqual(["t3", "t4", "t5", "t6", "t7"]);
});

test("ein Workspace bleibt mit einem Projekt bestehen und mit keinem leer", () => {
  const two: WindowContent = { ...three, projects: three.projects.slice(1) };
  const one = removeProject(two, mixed, "C:\\Projekte\\Notizen")!;

  expect(one.content).toEqual({ ...three, projects: ["C:\\Projekte\\Kern"] });

  // Ohne Projekt gibt es nichts mehr, wozu ein Tab gehören könnte.
  const none = removeProject(one.content, one.arrangement, "C:\\Projekte\\Kern")!;
  expect(none.content).toEqual({ ...three, projects: [] });
  expect(none.arrangement.root).toBeNull();
  expect(ids(none.closing)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
});

test("aus einem Projektfenster oder einem fremden Workspace wird nichts entfernt", () => {
  expect(removeProject(single, mixed, "C:\\Projekte\\Kredr")).toBeNull();
  expect(removeProject(three, mixed, "C:\\Projekte\\Kredr")).toBeNull();
});

function statusOf(state: AgentState): AgentStatus {
  return { state, lastAction: null, since: 0, subagents: [], backgroundTasks: [] };
}

test("gefragt wird, wenn dabei ein Agent arbeitet oder wartet", () => {
  const closing = removeProject(three, mixed, "C:\\Projekte\\Kern")!.closing;
  const elsewhere = new Map([["t1", statusOf("working")]]);

  expect(removalInterrupts(closing, new Map())).toBe(false);
  expect(removalInterrupts(closing, elsewhere)).toBe(false);
  expect(removalInterrupts(closing, new Map([["t4", statusOf("done")]]))).toBe(false);
  expect(removalInterrupts(closing, new Map([["t4", statusOf("working")]]))).toBe(true);
  expect(removalInterrupts(closing, new Map([["t4", statusOf("waiting")]]))).toBe(true);
});

const interrupted: Tab = {
  id: "t4",
  agent: true,
  shell: "powershell",
  cwd: "C:\\Projekte\\Kern\\src",
  conversation: { agent: "claudeCode", id: "c-4", assignment: "Tests", working: true },
};
const finished: Tab = {
  id: "t8",
  agent: true,
  cwd: "c:/projekte/kern/",
  conversation: { agent: "claudeCode", id: "c-8" },
};
const plain: Tab = { id: "t9", cwd: "C:\\Projekte\\Kern" };

test("die Gespräche geschlossener Agenten kommen in die Aufteilung des Projekts", () => {
  const kept = keepConversations(
    emptyArrangement,
    [interrupted, plain, finished],
    "C:\\Projekte\\Kern",
  );

  // Neue Kennungen; der Projektordner als Startordner ist der Normalfall und entfällt.
  expect(kept.root).toEqual({
    kind: "group",
    id: "g3",
    activeTab: "t1",
    tabs: [
      { ...interrupted, id: "t1" },
      { id: "t2", agent: true, conversation: { agent: "claudeCode", id: "c-8" } },
    ],
  });
  expect(kept.focusedGroup).toBe("g3");
  expect(kept.nextId).toBe(4);
});

test("die gespeicherte Aufteilung des Projekts behält ihre Tabs und bekommt die Agenten daneben", () => {
  const stored: Arrangement = {
    version: 1,
    root: { kind: "group", id: "g2", activeTab: "t1", tabs: [{ id: "t1", name: "Server" }] },
    focusedGroup: "g2",
    nextId: 3,
  };
  const kept = keepConversations(stored, [interrupted], "C:\\Projekte\\Kern");

  expect(kept.root).toEqual({
    kind: "split",
    id: "s5",
    axis: "row",
    sizes: [0.5, 0.5],
    children: [
      stored.root,
      { kind: "group", id: "g4", activeTab: "t3", tabs: [{ ...interrupted, id: "t3" }] },
    ],
  });
  expect(kept.focusedGroup).toBe("g2");
});

test("ein Gespräch, das die Aufteilung des Projekts schon kennt, steht dort nur einmal", () => {
  // Aus diesem Projekt entstand der Workspace; seine Aufteilung kennt den Agenten von damals.
  const stored: Arrangement = {
    version: 1,
    root: {
      kind: "group",
      id: "g2",
      activeTab: "t1",
      tabs: [{ id: "t1", agent: true, conversation: { agent: "claudeCode", id: "c-4" } }],
    },
    focusedGroup: "g2",
    nextId: 3,
  };
  const kept = keepConversations(stored, [interrupted], "C:\\Projekte\\Kern");

  expect(tabsOf(kept)).toEqual([{ id: "t1", agent: true, conversation: interrupted.conversation }]);
});

test("ohne Gespräche bleibt die Aufteilung des Projekts, wie sie ist", () => {
  expect(keepConversations(emptyArrangement, [plain], "C:\\Projekte\\Kern")).toBe(emptyArrangement);
});

test("ein leerer Workspace nimmt sein erstes Projekt auf", () => {
  const empty: WindowContent = { ...workspace, projects: [] };

  expect(addProject(empty, "C:\\Projekte\\Web", untitled)).toEqual({
    kind: "added",
    content: { ...empty, projects: ["C:\\Projekte\\Web"] },
  });
});

test("ein Workspace bekommt den neuen Namen ohne Leerraum am Rand und bleibt derselbe", () => {
  expect(renameWorkspace(workspace, "  Kunden  ")).toEqual({ ...workspace, name: "Kunden" });
});

test("ein leerer, unveränderter oder fremder Name wird nicht übernommen", () => {
  expect(renameWorkspace(workspace, "   ")).toBeNull();
  expect(renameWorkspace(workspace, "Unbenannt ")).toBeNull();
  expect(renameWorkspace(single, "Kunden")).toBeNull();
  expect(renameWorkspace(startPage, "Kunden")).toBeNull();
});

test("ein Projekt rückt an die Stelle, an der es abgelegt wird", () => {
  const moved = moveProject(three, mixed, "c:/projekte/notizen", 1)!;

  expect(moved.content).toEqual({
    ...three,
    projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Notizen", "C:\\Projekte\\Kern"],
  });
  // Das erste Projekt bleibt; die Tabs bleiben, wie sie sind.
  expect(moved.arrangement).toBe(mixed);
  // Hinter das letzte Projekt abgelegt, steht es am Ende.
  expect(moveProject(three, mixed, "C:\\Projekte\\Kern", 3)!.content).toEqual({
    ...three,
    projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Notizen", "C:\\Projekte\\Kern"],
  });
});

test("an der eigenen Stelle abgelegt oder ohne Workspace ändert sich nichts", () => {
  expect(moveProject(three, mixed, "C:\\Projekte\\Kern", 1)).toBeNull();
  expect(moveProject(three, mixed, "C:\\Projekte\\Kern", 2)).toBeNull();
  expect(moveProject(three, mixed, "C:\\Projekte\\Kredr", 0)).toBeNull();
  expect(moveProject(single, mixed, "C:\\Projekte\\Kredr", 0)).toBeNull();
});

test("wechselt das erste Projekt, bleiben seine Terminals und Dateien bei ihm", () => {
  const moved = moveProject(three, mixed, "C:\\Projekte\\Kern", 0)!;
  const projects = projectsOf(moved.content);

  expect(projects).toEqual(["C:\\Projekte\\Kern", "C:\\Projekte\\Web", "C:\\Projekte\\Notizen"]);
  const tabs = tabsOf(moved.arrangement);
  expect(tabs.slice(0, 2)).toEqual([
    { id: "t1", agent: true, shell: "powershell", cwd: "C:\\Projekte\\Web" },
    { id: "t2", content: { kind: "file", path: "C:/Projekte/Web/src/index.ts" } },
  ]);
  // Jeder Tab gehört danach zum selben Projekt wie vorher.
  const owners = (list: readonly string[], arrangement: Arrangement) =>
    tabsOf(arrangement).map((tab) => projectOfTab(list, tab));
  expect(owners(projects, moved.arrangement)).toEqual(owners(three.projects, mixed));
});

test("das aktive Projekt ist das des aktiven Tabs, ohne Projekt das erste", () => {
  const [web, core] = projectsOf(workspace);
  const terminal = (cwd: string): Tab => ({ id: "t", cwd });
  const file = (path: string): Tab => ({ id: "f", content: { kind: "file", path } });

  expect(activeProject([web, core], terminal("c:\\projekte\\kern\\src"), web)).toBe(core);
  expect(activeProject([web, core], file("C:/Projekte/Kern/README.md"), web)).toBe(core);
  // Ein Terminal außerhalb aller Projekte und kein Tab: das erste Projekt.
  expect(activeProject([web, core], terminal("D:\\temp"), core)).toBe(web);
  expect(activeProject([web, core], undefined, core)).toBe(web);
  expect(activeProject([], undefined, null)).toBeNull();
});

test("zeigt der aktive Tab die Versionskontrolle, bleibt das bisher aktive Projekt", () => {
  const [web, core] = projectsOf(workspace);
  const versionControl: Tab = { id: "v", content: { kind: "versionControl" } };

  expect(activeProject([web, core], versionControl, core)).toBe(core);
  // Ist das bisherige Projekt nicht mehr im Fenster, gilt das erste.
  expect(activeProject([web, core], versionControl, "C:\\Projekte\\Alt")).toBe(web);
});

test("Suchtreffer stehen unter ihrem Projekt in der Reihenfolge des Workspace", () => {
  const [web, core] = projectsOf(workspace);
  const hit = (project: string, path: string) => ({ project, path });

  const groups = groupByProject(
    [web, core],
    [hit(core, "a.rs"), hit(web, "index.ts"), hit("c:\\projekte\\kern", "b.rs")],
  );

  // Projekte ohne Treffer fehlen; innerhalb eines Projekts bleibt die Reihenfolge.
  expect(groups).toEqual([
    { project: web, items: [hit(web, "index.ts")] },
    { project: core, items: [hit(core, "a.rs"), hit("c:\\projekte\\kern", "b.rs")] },
  ]);
  // Treffer eines Projekts, das nicht mehr im Workspace ist, fallen weg.
  expect(groupByProject([web], [hit(core, "a.rs")])).toEqual([]);
});

test("Quick Open kennt die Dateien aller Projekte in der Reihenfolge des Workspace", () => {
  const [web, core] = projectsOf(workspace);
  const lists = new Map([
    [web, ["index.ts", "src/app.ts"]],
    [core, ["src/lib.rs"]],
  ]);

  const files = workspaceFiles([web, core], (project) => lists.get(project) ?? []);

  // Der Schlüssel ist der Pfad, unter dem die Datei öffnet: im ersten Projekt
  // relativ, sonst voll.
  expect(files).toEqual([
    { project: web, path: "index.ts", key: "index.ts" },
    { project: web, path: "src/app.ts", key: "src/app.ts" },
    { project: core, path: "src/lib.rs", key: "C:/Projekte/Kern/src/lib.rs" },
  ]);
});

test("auch verschachtelte Projekte nennen jede Datei unter eigenem Schlüssel", () => {
  const outer = "C:\\Projekte";
  const inner = "C:\\Projekte\\Kern";
  const lists = new Map([
    [outer, ["Kern/x.ts"]],
    [inner, ["x.ts"]],
  ]);

  const keys = (projects: string[]) =>
    workspaceFiles(projects, (project) => lists.get(project) ?? []).map((file) => file.key);

  expect(keys([outer, inner])).toEqual(["Kern/x.ts", "C:/Projekte/Kern/x.ts"]);
  expect(keys([inner, outer])).toEqual(["x.ts", "C:/Projekte/Kern/x.ts"]);
});

/** Der Name am Tab: der Dateiname oder der Name des Terminals. */
function labelOfTab(tab: Tab): string {
  if (tab.content && "path" in tab.content) return tab.content.path.split("/").at(-1)!;
  return tab.name ?? "PowerShell";
}

test("gleichnamige Tabs aus verschiedenen Projekten tragen den Projektnamen, eindeutige nicht", () => {
  const [web, core] = projectsOf(workspace);
  const tabs: Tab[] = [
    { id: "a", content: { kind: "file", path: "README.md" } },
    { id: "b", content: { kind: "file", path: "C:/Projekte/Kern/README.md" } },
    { id: "c", content: { kind: "file", path: "src/index.ts" } },
  ];

  const descriptions = tabDescriptions([web, core], tabs, labelOfTab);

  expect([...descriptions]).toEqual([
    ["a", "Web"],
    ["b", "Kern"],
  ]);
});

test("Terminals außerhalb aller Projekte tragen den Namen ihres Startordners", () => {
  const [web, core] = projectsOf(workspace);
  const tabs: Tab[] = [
    { id: "a" },
    { id: "b", cwd: "C:\\Projekte\\Web\\src" },
    { id: "c", cwd: "D:\\temp" },
    { id: "v", content: { kind: "versionControl" } },
  ];

  expect([...tabDescriptions([web, core], tabs, labelOfTab)]).toEqual([
    ["a", "Web"],
    ["b", "Web"],
    ["c", "temp"],
  ]);
  // Zwei gleichnamige Terminals im selben Projekt brauchen keinen Zusatz.
  expect(tabDescriptions([web, core], tabs.slice(0, 2), labelOfTab).size).toBe(0);
});

test("ein einzelnes Projekt nennt seine Dateien wie bisher", () => {
  const files = workspaceFiles(projectsOf(single), () => ["a.ts", "src/b.ts"]);

  expect(files.map((file) => file.key)).toEqual(["a.ts", "src/b.ts"]);
});
