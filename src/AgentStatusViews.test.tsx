// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentStatus } from "./agentStatus";
import { SubagentSection } from "./AgentStatusViews";
import { I18nProvider } from "./i18n/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function sub(id: string, state: SubagentStatus["state"]): SubagentStatus {
  return {
    id,
    kind: "general-purpose",
    description: `review: ${id}`,
    state,
    lastAction: null,
    started: 0,
    ended: state === "done" ? 1_000 : null,
  };
}

describe("Abschnitt Subagenten auf der Karte", () => {
  let host: HTMLDivElement;
  let root: Root;
  const selected = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    selected.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** Die Karte eines Agenten mit Einklappen und „weitere“ wie in der Agenten-Ansicht. */
  function Card({ subagents }: { subagents: SubagentStatus[] }) {
    const [collapsed, setCollapsed] = useState(false);
    const [showsAll, setShowsAll] = useState(false);
    return (
      <div onClick={selected}>
        <SubagentSection
          subagents={subagents}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(!collapsed)}
          showsAll={showsAll}
          onToggleShowsAll={() => setShowsAll(!showsAll)}
        />
      </div>
    );
  }

  function show(subagents: SubagentStatus[]) {
    act(() =>
      root.render(
        <I18nProvider language="de">
          <Card subagents={subagents} />
        </I18nProvider>,
      ),
    );
  }

  const rows = () =>
    [...host.querySelectorAll(".subagent .description")].map((row) => row.textContent);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent === name || candidate.getAttribute("aria-label") === name,
    );
  const click = (name: string) => act(() => button(name)!.click());

  const workflow = [
    sub("bugs", "done"),
    sub("standards", "working"),
    sub("spec", "done"),
    sub("rust", "working"),
    sub("sidebar", "working"),
    sub("arrangement", "done"),
  ];

  it("zeigt von sechs Subagenten drei, arbeitende zuerst, und „+ 3 weitere“", () => {
    show(workflow);

    expect(rows()).toEqual(["review: standards", "review: rust", "review: sidebar"]);
    expect(button("+ 3 weitere")).toBeDefined();
  });

  it("zeigt einen wartenden Subagenten in der ersten Zeile, hervorgehoben", () => {
    show([...workflow, sub("check", "waiting")]);

    expect(rows()).toEqual(["review: check", "review: standards", "review: rust"]);
    expect(host.querySelector(".subagent")!.classList).toContain("waiting");
    expect(button("+ 4 weitere")).toBeDefined();
  });

  it("zeigt mit „+ 3 weitere“ alle und mit „Weniger zeigen“ wieder drei", () => {
    show(workflow);

    click("+ 3 weitere");
    expect(rows()).toHaveLength(6);
    expect(button("+ 3 weitere")).toBeUndefined();

    click("Weniger zeigen");
    expect(rows()).toHaveLength(3);
  });

  it("zeigt bis drei Subagenten ohne „weitere“", () => {
    show(workflow.slice(0, 3));

    expect(rows()).toHaveLength(3);
    expect(host.querySelector(".more")).toBeNull();
  });

  it("klappt zur Zusammenfassung ein und bleibt eingeklappt, wenn sich die Subagenten ändern", () => {
    show(workflow);

    click("Subagenten einklappen");
    expect(rows()).toEqual([]);
    expect(host.querySelector(".subagents-head")!.textContent).toBe("6 Subagenten · 3 arbeiten");

    show([...workflow.slice(0, 5), sub("arrangement", "working"), sub("neu", "working")]);
    expect(host.querySelector(".subagents-head")!.textContent).toBe("7 Subagenten · 5 arbeiten");

    click("Subagenten ausklappen");
    expect(rows()).toHaveLength(3);
  });

  it("wählt mit Pfeil und „weitere“ nicht das Terminal aus, mit einer Zeile schon", () => {
    show(workflow);

    click("Subagenten einklappen");
    click("Subagenten ausklappen");
    click("+ 3 weitere");
    click("Weniger zeigen");
    expect(selected).not.toHaveBeenCalled();

    act(() => host.querySelector<HTMLElement>(".subagent")!.click());
    expect(selected).toHaveBeenCalledOnce();
  });
});
