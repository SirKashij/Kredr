// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentStatuses } from "./agentStatus";
import {
  activateTab,
  closeTab,
  emptyArrangement,
  groupsOf,
  openContent,
  openTab,
  splitGroup,
  type Arrangement,
} from "./arrangement";
import type { OpenFiles } from "./openFiles";
import type { RunningTerminal, RunningTerminals } from "./runningTerminals";
import { defaultSettings } from "./settingsStore";
import type { ContentTab } from "./tabViews";
import { WindowAgents } from "./windowAgents";

/** Wann der Inhalt des Datei-Tabs wirft; `null` heißt: gar nicht. */
let failure: "render" | "effect" | "cleanup" | null = null;

function FailingBody({ tab }: { tab: ContentTab }) {
  if (failure === "render") throw new Error("Fehler beim Zeichnen");
  useEffect(() => {
    if (failure === "effect") throw new Error("Fehler im Effekt");
    return () => {
      if (failure === "cleanup") throw new Error("Fehler beim Aufräumen");
    };
  }, []);
  return <div className="inhalt">{"path" in tab.content ? tab.content.path : ""}</div>;
}

vi.mock("./tabViews", () => ({
  ContentTabFace: () => <span className="tab-label">Datei</span>,
  ContentTabBody: FailingBody,
}));
vi.mock("./settings", () => ({
  useSettings: () => ({ settings: defaultSettings }),
}));

const { MainArea } = await import("./MainArea");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Laufende Terminals ohne Kern: Jedes Terminal entsteht einmal je Tab und
 * zeichnet beim Einhängen ein Element mit seiner Kennung. Mit `attachFailures`
 * wirft das nächste Einhängen, wie eine kaputte Terminalansicht.
 */
function fakeTerminals() {
  const created: string[] = [];
  const running = new Map<string, unknown>();
  const terminals = {
    statuses: new AgentStatuses(),
    attachFailures: 0,
    created,
    /** Jedes gelungene Einhängen einer Ansicht, nach Tab. */
    attached: [] as string[],
    open(tabId: string) {
      let terminal = running.get(tabId);
      if (!terminal) {
        created.push(tabId);
        const screen = document.createElement("div");
        screen.className = "fake-terminal";
        screen.textContent = tabId;
        terminal = {
          attach(host: HTMLElement) {
            if (terminals.attachFailures > 0) {
              terminals.attachFailures--;
              throw new Error("Terminalansicht kaputt");
            }
            terminals.attached.push(tabId);
            host.append(screen);
          },
          detach() {
            screen.remove();
          },
          focus() {},
        };
        running.set(tabId, terminal);
      }
      return terminal;
    },
    find(tabId: string) {
      return running.get(tabId);
    },
    startNow() {},
  };
  return terminals;
}

let root: Root;
let host: HTMLElement;
let uncaught: unknown[];
let terminals: ReturnType<typeof fakeTerminals>;
let agents: WindowAgents<RunningTerminal>;

beforeEach(() => {
  failure = null;
  uncaught = [];
  terminals = fakeTerminals();
  agents = new WindowAgents({
    terminals: terminals as unknown as RunningTerminals,
    statuses: terminals.statuses,
    change: () => {},
    settings: () => defaultSettings,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host, {
    onUncaughtError: (error) => uncaught.push(error),
    onCaughtError: () => {},
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Links ein Terminal, rechts ein Terminal und davor sichtbar ein Datei-Tab. */
function twoGroups(): Arrangement {
  const single = openTab(emptyArrangement);
  const split = splitGroup(single, groupsOf(single)[0].id, "right");
  return openContent(split, { kind: "file", path: "kaputt.txt" });
}

async function show(arrangement: Arrangement) {
  await act(() =>
    root.render(
      <MainArea
        arrangement={arrangement}
        terminals={terminals as unknown as RunningTerminals}
        agents={agents}
        statuses={terminals.statuses}
        files={{} as OpenFiles}
        cwd="C:/proj"
        shells={[]}
        focusRequest={0}
        update={() => {}}
        onOpenFile={() => {}}
        onCloseTab={() => {}}
        onRefocus={() => {}}
      />,
    ),
  );
}

const groups = () => [...host.querySelectorAll<HTMLElement>("section.group")];
const crashOf = (group: HTMLElement) => group.querySelector(".tab-crash");

test("wirft ein Tab-Inhalt beim Zeichnen, zeigt nur dieser Tab den Fehler", async () => {
  failure = "render";
  await show(twoGroups());

  expect(uncaught).toEqual([]);
  const [left, right] = groups();
  expect(left.querySelector(".fake-terminal")?.textContent).toBe("t1");
  expect(crashOf(left)).toBeNull();
  expect(crashOf(right)?.textContent).toContain("Fehler beim Zeichnen");
  expect(right.querySelectorAll("[role=tab]")).toHaveLength(2);
});

test("wirft ein Tab-Inhalt in einem Effekt, zeigt nur dieser Tab den Fehler", async () => {
  failure = "effect";
  await show(twoGroups());

  expect(uncaught).toEqual([]);
  const [left, right] = groups();
  expect(crashOf(left)).toBeNull();
  expect(crashOf(right)?.textContent).toContain("Fehler im Effekt");
});

test("wirft ein Tab-Inhalt beim Aufräumen, bleibt die Oberfläche stehen", async () => {
  failure = "cleanup";
  const arrangement = twoGroups();
  await show(arrangement);
  const terminalTab = groupsOf(arrangement)[1].tabs.find((tab) => !tab.content)!;
  terminals.attached.length = 0;

  await show(activateTab(arrangement, terminalTab.id));

  expect(uncaught).toEqual([]);
  // Nur die Ansicht des gewechselten Tabs hängt sich ein; die linke Gruppe bleibt, wie sie war.
  expect(terminals.attached).toEqual([terminalTab.id]);
  const [left, right] = groups();
  expect(left.querySelector(".fake-terminal")?.textContent).toBe("t1");
  // Der Fehler gehört zum verlassenen Tab, nicht zum nun sichtbaren Terminal.
  expect(crashOf(right)).toBeNull();
  expect(right.querySelector(".fake-terminal")?.textContent).toBe(terminalTab.id);
});

test("ein Tab, der beim Verlassen geworfen hat, zeigt beim nächsten Anzeigen seinen Inhalt", async () => {
  failure = "cleanup";
  const arrangement = twoGroups();
  await show(arrangement);
  const terminalTab = groupsOf(arrangement)[1].tabs.find((tab) => !tab.content)!;
  await show(activateTab(arrangement, terminalTab.id));
  failure = null;

  await show(arrangement);

  expect(crashOf(groups()[1])).toBeNull();
  expect(groups()[1].querySelector(".inhalt")?.textContent).toBe("kaputt.txt");
});

test("wirft der Inhalt beim Schließen seiner Gruppe, bleibt die übrige Oberfläche stehen", async () => {
  failure = "cleanup";
  const arrangement = twoGroups();
  await show(arrangement);
  const right = groupsOf(arrangement)[1];

  // Ohne ihre Tabs verschwindet die rechte Gruppe samt Fehlergrenze.
  await show(right.tabs.reduce((current, tab) => closeTab(current, tab.id), arrangement));

  expect(uncaught).toEqual([]);
  expect(groups()).toHaveLength(1);
  expect(groups()[0].querySelector(".fake-terminal")?.textContent).toBe("t1");
});

test("nach dem Neuladen zeigt der Tab seinen Inhalt wieder", async () => {
  failure = "render";
  await show(twoGroups());
  failure = null;

  const reload = crashOf(groups()[1])!.querySelector("button")!;
  await act(() => reload.click());

  expect(crashOf(groups()[1])).toBeNull();
  expect(groups()[1].querySelector(".inhalt")?.textContent).toBe("kaputt.txt");
});

test("eine kaputte Terminalansicht hängt nach dem Neuladen wieder am selben Terminal", async () => {
  // Eine Gruppe mit zwei Terminals; beide laufen schon.
  const arrangement = openTab(openTab(emptyArrangement));
  const [first, second] = groupsOf(arrangement)[0].tabs;
  await show(activateTab(arrangement, first.id));
  await show(activateTab(arrangement, second.id));
  expect(terminals.created).toEqual([first.id, second.id]);

  terminals.attachFailures = 1;
  await show(activateTab(arrangement, first.id));

  expect(uncaught).toEqual([]);
  expect(crashOf(groups()[0])?.textContent).toContain("Terminalansicht kaputt");

  await act(() => crashOf(groups()[0])!.querySelector("button")!.click());

  expect(crashOf(groups()[0])).toBeNull();
  expect(groups()[0].querySelector(".fake-terminal")?.textContent).toBe(first.id);
  expect(terminals.created).toEqual([first.id, second.id]);
});
