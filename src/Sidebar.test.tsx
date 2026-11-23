// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { View } from "./ActivityBar";
import { AgentStatuses, type SubagentUpdate } from "./agentStatus";
import { emptyArrangement, openTab, tabsOf, type Arrangement, type Tab } from "./arrangement";
import { I18nProvider } from "./i18n/i18n";
import { defaultSettings } from "./settingsStore";
import { projectsOf, startPage, toggleSection, type WindowContent } from "./workspace";

vi.mock("./settings", () => ({
  useSettings: () => ({ settings: defaultSettings }),
}));
// Explorer und Suche lesen Dateien über den Kern; hier geht es nur um die Agenten-Ansicht.
vi.mock("./Explorer", () => ({ Explorer: () => null }));
vi.mock("./SearchView", () => ({ SearchView: () => null }));

const { Sidebar } = await import("./Sidebar");

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
