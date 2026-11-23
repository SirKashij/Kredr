// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { View } from "./ActivityBar";
import { AgentStatuses, type SubagentUpdate } from "./agentStatus";
import { emptyArrangement, openTab, tabsOf, type Arrangement, type Tab } from "./arrangement";
import { I18nProvider } from "./i18n/i18n";
import {
  isRepositoryCollapsed,
  isRepositoryHidden,
  toggleRepositoryCollapsed,
  toggleRepositoryHidden,
} from "./repositories";
import { defaultSettings } from "./settingsStore";
import { projectsOf, startPage, toggleSection, type WindowContent } from "./workspace";

vi.mock("./settings", () => ({
  useSettings: () => ({ settings: defaultSettings }),
}));
// Explorer und Suche lesen Dateien über den Kern; hier geht es um Agenten-Ansicht und Versionskontrolle.
vi.mock("./Explorer", () => ({ Explorer: () => null }));
vi.mock("./SearchView", () => ({ SearchView: () => null }));

/** Die Kanäle, über die der Kern den Zustand der Versionskontrolle meldet, je Projekt. */
const channels = new Map<string, { onmessage: (state: unknown) => void }>();
vi.mock("@tauri-apps/api/core", () => {
  let pending: { onmessage: (state: unknown) => void } | null = null;
  return {
    Channel: class {
      onmessage: (state: unknown) => void = () => {};
      constructor() {
        pending = this;
      }
    },
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === "version_control_watch") channels.set(args.project as string, pending!);
      return 1;
    },
  };
});

const { Sidebar } = await import("./Sidebar");
const { VersionControlProvider, VersionControls } = await import("./versionControl");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sub(id: string): SubagentUpdate {
  return {
    id,
    kind: "Explore",
    description: `review: ${id}`,
    state: "working",
    lastAction: null,
  };
}

describe("Agenten-Ansicht mit Subagenten", () => {
  let host: HTMLDivElement;
  let root: Root;
  const selected = vi.fn();
  const arrangement = openTab(emptyArrangement, true);
  const tabId = tabsOf(arrangement)[0].id;
  let statuses: AgentStatuses;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    selected.mockClear();
    statuses = new AgentStatuses();
    statuses.report(tabId, {
      state: "working",
      lastAction: null,
      stateChanged: true,
      assignment: null,
      conversation: null,
      resumeFailed: false,
      backgroundTasks: [],
      subagents: ["a", "b", "c", "d"].map(sub),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function show(view: View) {
    act(() =>
      root.render(
        <I18nProvider language="de">
          <Sidebar
            view={view}
            visible
            project={null}
            content={startPage}
            onAddProject={() => {}}
            onRemoveProject={() => {}}
            onMoveProject={() => {}}
            onRenameWorkspace={() => {}}
            renameRequest={0}
            onCloseWorkspace={() => {}}
            folderDrop={false}
            onOpenTerminalIn={() => {}}
            activeFile={null}
            onOpenFile={() => {}}
            onOpenMatch={() => {}}
            searchFocus={0}
            onShowChange={() => {}}
            arrangement={arrangement}
            statuses={statuses}
            onSelectTab={selected}
            onToggleSection={() => {}}
            onArrangeRepositories={() => {}}
          />
        </I18nProvider>,
      ),
    );
  }

  const rows = () => [...host.querySelectorAll(".subagent .description")];
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name);

  it("zeigt nach einem Wechsel der Ansicht weiter alle Subagenten", () => {
    show("agents");
    act(() => button("+ 1 weitere")!.click());
    expect(rows()).toHaveLength(4);

    show("versionControl");
    show("agents");

    expect(rows()).toHaveLength(4);
  });

  it("macht Karte und Zeilen zu eigenen Knöpfen, ohne Knöpfe in Knöpfen", () => {
    show("agents");

    // Ein Knopf ist per Tab erreichbar und wird mit Enter und Leertaste gedrückt.
    const card = host.querySelector(".card")!;
    expect(card.querySelector(":scope > button")).not.toBeNull();
    for (const row of rows()) expect(row.closest("button")).not.toBeNull();
    expect(host.querySelector("button button, [role='button'] button")).toBeNull();
    expect(host.querySelector("[role='button']")).toBeNull();
  });

  it("wählt mit der Karte und mit einer Zeile das Terminal aus", () => {
    show("agents");

    act(() => host.querySelector<HTMLElement>(".card > button")!.click());
    act(() => rows()[0].closest("button")!.click());

    expect(selected.mock.calls).toEqual([[tabId], [tabId]]);
  });

  it("zeigt die Hintergrundaufgaben unter den Subagenten, eine Zeile wählt das Terminal", () => {
    statuses.report(tabId, {
      state: "background",
      lastAction: null,
      stateChanged: true,
      assignment: null,
      conversation: null,
      resumeFailed: false,
      backgroundTasks: [
        { id: "b1", kind: "shell", description: "CI beobachten", command: "gh run watch" },
      ],
      subagents: ["a"].map(sub),
    });
    show("agents");

    const heads = [...host.querySelectorAll(".card .subagents-head")];
    expect(heads.map((head) => head.textContent)).toEqual(["Subagenten", "Hintergrundaufgaben"]);
    act(() => host.querySelector<HTMLElement>(".background-task")!.click());
    expect(selected.mock.calls).toEqual([[tabId]]);
  });
});

describe("Agenten-Ansicht nach Projekten", () => {
  let host: HTMLDivElement;
  let root: Root;
  const openIn = vi.fn();
  const toggled = vi.fn();
  const web = "C:\\Projekte\\Web";
  const core = "C:\\Projekte\\Kern";
  const tabs: Tab[] = [
    { id: "t1", agent: true, cwd: web },
    { id: "t2", cwd: "c:\\projekte\\web\\src" },
    { id: "t3", agent: true, cwd: "D:\\temp" },
    { id: "t4", content: { kind: "file", path: "README.md" } },
  ];
  const arrangement: Arrangement = {
    version: 1,
    root: { kind: "group", id: "g0", tabs, activeTab: "t1" },
    focusedGroup: "g0",
    nextId: 5,
  };
  const workspace: WindowContent = {
    kind: "workspace",
    id: "w1",
    name: "Arbeit",
    projects: [web, core],
  };
  let statuses: AgentStatuses;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    openIn.mockClear();
    toggled.mockClear();
    statuses = new AgentStatuses();
    const report = (tabId: string, state: "working" | "waiting") =>
      statuses.report(tabId, {
        state,
        lastAction: null,
        stateChanged: true,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      });
    report("t1", "working");
    report("t3", "waiting");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function show(content: WindowContent, shown: Arrangement = arrangement) {
    act(() =>
      root.render(
        <I18nProvider language="de">
          <Sidebar
            view="agents"
            visible
            project={projectsOf(content)[0] ?? null}
            content={content}
            onAddProject={() => {}}
            onRemoveProject={() => {}}
            onMoveProject={() => {}}
            onRenameWorkspace={() => {}}
            renameRequest={0}
            onCloseWorkspace={() => {}}
            folderDrop={false}
            onOpenTerminalIn={openIn}
            activeFile={null}
            onOpenFile={() => {}}
            onOpenMatch={() => {}}
            searchFocus={0}
            onShowChange={() => {}}
            arrangement={shown}
            statuses={statuses}
            onSelectTab={() => {}}
            onToggleSection={toggled}
            onArrangeRepositories={() => {}}
            onNewAgent={() => {}}
            onNewTerminal={() => {}}
          />
        </I18nProvider>,
      ),
    );
  }

  const heads = () =>
    [...host.querySelectorAll(".agent-section-head .agent-section-name")].map(
      (head) => head.textContent,
    );
  const cardsIn = (name: string) => {
    const section = [...host.querySelectorAll(".agent-section")].find(
      (candidate) => candidate.querySelector(".agent-section-name")?.textContent === name,
    )!;
    return [...section.querySelectorAll(".card .name")].map((card) => card.textContent);
  };
  const labelled = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  it("zeigt einen Abschnitt je Projekt und zuletzt „Außerhalb der Projekte“", () => {
    show(workspace);

    expect(heads()).toEqual(["Web", "Kern", "Außerhalb der Projekte"]);
    expect(cardsIn("Web")).toEqual(["Agent", "PowerShell"]);
    expect(cardsIn("Außerhalb der Projekte")).toEqual(["Agent"]);
    // Ein Projekt ohne Terminals lädt zum ersten Agenten ein.
    expect(cardsIn("Kern")).toEqual([]);
    expect(labelled("1 arbeitet")).not.toBeNull();
    expect(labelled("1 wartet")).not.toBeNull();
  });

  it("zählt Agenten im Hintergrund im Abschnittskopf zwischen wartenden und fertigen", () => {
    const update = (state: "background" | "done") => ({
      state,
      lastAction: null,
      stateChanged: true,
      assignment: null,
      conversation: null,
      resumeFailed: false,
      backgroundTasks: [],
      subagents: [],
    });
    const more: Tab[] = [
      { id: "t5", agent: true, cwd: "D:\\temp" },
      { id: "t6", agent: true, cwd: "D:\\temp" },
    ];
    statuses.report("t5", update("background"));
    statuses.report("t6", update("done"));

    show(workspace, {
      ...arrangement,
      root: { kind: "group", id: "g0", tabs: [...tabs, ...more], activeTab: "t1" },
    });

    const outside = [...host.querySelectorAll(".agent-section")].find((section) =>
      section.textContent?.includes("Außerhalb der Projekte"),
    )!;
    expect(
      [...outside.querySelectorAll(".agent-section-counts > span")].map((count) =>
        count.getAttribute("aria-label"),
      ),
    ).toEqual(["1 wartet", "1 im Hintergrund", "1 fertig"]);
  });

  it("startet mit den Knöpfen des Abschnitts ohne Rückfrage im Projekt", () => {
    show(workspace);

    act(() => labelled("Neuer Agent in Kern")!.click());
    act(() => labelled("Neues Terminal in Web")!.click());
    const start = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Agent starten",
    )!;
    act(() => start.click());

    expect(openIn.mock.calls).toEqual([
      [core, true],
      [web, false],
      [core, true],
    ]);
  });

  it("klappt Abschnitte zu, wie die Aufteilung es sich merkt", () => {
    show(workspace, toggleSection(arrangement, web));

    expect(cardsIn("Web")).toEqual([]);
    expect(cardsIn("Außerhalb der Projekte")).toEqual(["Agent"]);

    const toggle = [...host.querySelectorAll<HTMLElement>(".agent-section-toggle")];
    act(() => toggle[0].click());
    act(() => toggle[2].click());
    expect(toggled.mock.calls).toEqual([[web], [null]]);
  });

  it("zeigt ein einzelnes Projekt ohne Abschnitte, wie bisher", () => {
    show({ kind: "project", path: web });

    expect(host.querySelector(".agent-section")).toBeNull();
    expect([...host.querySelectorAll(".card .name")].map((card) => card.textContent)).toEqual([
      "Agent",
      "Agent",
      "PowerShell",
    ]);
    expect(host.querySelector(".sect")?.textContent).toBe("Terminals");
  });
});

describe("Versionskontrolle mit mehreren Repositories", () => {
  let host: HTMLDivElement;
  let root: Root;
  let controls: InstanceType<typeof VersionControls>;
  const arranged = vi.fn();
  const web = "C:\\Projekte\\Web";
  const notes = "C:\\Projekte\\Notizen";
  const core = "C:\\Projekte\\Kern";
  const change = { originalPath: null, status: "modified", staged: false };
  const repository = (branch: string, paths: string[], ahead = 0) => ({
    kind: "repository",
    branch,
    commit: "abc",
    files: paths.map((path) => ({ path, ...change })),
    upstream: `origin/${branch}`,
    ahead,
    behind: 0,
  });
  const noRepository = { kind: "unavailable", reason: "notARepository", details: "" };
  const workspace = (projects: string[]): WindowContent => ({
    kind: "workspace",
    id: "w1",
    name: "Arbeit",
    projects,
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    arranged.mockClear();
    channels.clear();
    controls = new VersionControls();
  });

  afterEach(() => {
    act(() => root.unmount());
    controls.follow([]);
    host.remove();
  });

  /** Zeigt die Versionskontrolle des Fensters; `states` meldet der Kern je Projekt. */
  function show(content: WindowContent, states: Record<string, unknown>, shown = emptyArrangement) {
    act(() => controls.follow(projectsOf(content)));
    act(() => {
      for (const [project, state] of Object.entries(states))
        channels.get(project)!.onmessage(state);
    });
    act(() =>
      root.render(
        <I18nProvider language="de">
          <VersionControlProvider controls={controls}>
            <Sidebar
              view="versionControl"
              visible
              project={projectsOf(content)[0] ?? null}
              content={content}
              onAddProject={() => {}}
              onRemoveProject={() => {}}
              onMoveProject={() => {}}
              onRenameWorkspace={() => {}}
              renameRequest={0}
              onCloseWorkspace={() => {}}
              folderDrop={false}
              onOpenTerminalIn={() => {}}
              activeFile={null}
              onOpenFile={() => {}}
              onOpenMatch={() => {}}
              searchFocus={0}
              onShowChange={() => {}}
              arrangement={shown}
              statuses={new AgentStatuses()}
              onSelectTab={() => {}}
              onToggleSection={() => {}}
              onArrangeRepositories={arranged}
            />
          </VersionControlProvider>
        </I18nProvider>,
      ),
    );
  }

  const texts = (selector: string) =>
    [...host.querySelectorAll(selector)].map((element) => element.textContent);
  const messageFields = () => host.querySelectorAll("textarea");

  it("zeigt „Repositories“ ab zwei Repositories und lässt Projekte ohne Git weg", () => {
    show(workspace([web, notes, core]), {
      [web]: repository("main", ["a.ts", "b.ts"], 1),
      [notes]: noRepository,
      [core]: repository("dev", []),
    });

    expect(texts(".repositories-title")).toEqual(["Repositories"]);
    expect(texts(".repo-row .repo-name")).toEqual(["Web", "Kern"]);
    expect(texts(".repo-row .repo-branch")).toEqual(["main", "dev"]);
    expect(texts(".repo-row .repo-count")).toEqual(["2", "0"]);
    expect(host.querySelector("[aria-label='1 ausgehend, 0 eingehend']")).not.toBeNull();
    // Ein Abschnitt je Repository mit eigenem Commit-Feld.
    expect(texts(".repo-section .agent-section-name")).toEqual(["Web", "Kern"]);
    expect(messageFields()).toHaveLength(2);
    expect(host.textContent).not.toContain("Notizen");
  });

  it("zeigt ein einzelnes Repository wie bisher, ohne „Repositories“ und Abschnittskopf", () => {
    show(workspace([web, notes]), { [web]: repository("main", ["a.ts"]), [notes]: noRepository });

    expect(host.querySelector(".repositories-title")).toBeNull();
    expect(host.querySelector(".repo-section")).toBeNull();
    expect(messageFields()).toHaveLength(1);
    expect(host.textContent).not.toContain("kein Git-Repository");
  });

  it("weist darauf hin, wenn kein Projekt des Workspace ein Repository ist", () => {
    show(workspace([web, notes]), { [web]: noRepository, [notes]: noRepository });

    expect(host.textContent).toContain("Kein Projekt dieses Workspace ist ein Git-Repository.");
    expect(messageFields()).toHaveLength(0);
  });

  it("blendet ausgeblendete und zugeklappte Repositories aus, wie die Aufteilung es sich merkt", () => {
    const states = { [web]: repository("main", ["a.ts"]), [core]: repository("dev", ["c.ts"]) };
    const folded = toggleRepositoryCollapsed(toggleRepositoryHidden(emptyArrangement, web), core);
    show(workspace([web, core]), states, folded);

    // Das ausgeblendete steht nur noch in „Repositories“, das zugeklappte ohne Commit-Feld.
    expect(texts(".repo-row .repo-name")).toEqual(["Web", "Kern"]);
    expect(texts(".repo-section .agent-section-name")).toEqual(["Kern"]);
    expect(messageFields()).toHaveLength(0);

    act(() => host.querySelector<HTMLElement>("[aria-label='Web einblenden']")!.click());
    act(() => host.querySelector<HTMLElement>(".repo-row .repo-name")!.click());
    const [toggle, reveal] = arranged.mock.calls.map(([change]) => change(folded));
    expect(isRepositoryHidden(toggle, web)).toBe(false);
    expect(isRepositoryCollapsed(toggle, web)).toBe(false);
    expect(isRepositoryHidden(reveal, web)).toBe(false);
  });
});
