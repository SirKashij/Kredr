// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { View } from "./ActivityBar";
import { AgentStatuses, type SubagentUpdate } from "./agentStatus";
import { emptyArrangement, openTab, tabsOf } from "./arrangement";
import { I18nProvider } from "./i18n/i18n";
import { defaultSettings } from "./settingsStore";
import { startPage } from "./workspace";

vi.mock("./settings", () => ({
  useSettings: () => ({ settings: defaultSettings }),
}));

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
            onOpenTerminalIn={() => {}}
            activeFile={null}
            onOpenFile={() => {}}
            onOpenMatch={() => {}}
            searchFocus={0}
            onShowChange={() => {}}
            arrangement={arrangement}
            statuses={statuses}
            onSelectTab={selected}
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
