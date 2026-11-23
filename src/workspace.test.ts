import { expect, test } from "vitest";
import type { AgentState, AgentStatus } from "./agentStatus";
import { emptyArrangement, tabsOf, type Arrangement, type Tab } from "./arrangement";
import {
  addProject,
  firstProject,
  keepConversations,
  projectOf,
  projectsOf,
  removalInterrupts,
  removeProject,
  startPage,
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
  return { state, lastAction: null, since: 0, subagents: [] };
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
