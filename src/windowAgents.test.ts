import { describe, expect, it } from "vitest";
import { AgentStatuses, type StatusUpdate } from "./agentStatus";
import {
  emptyArrangement,
  openTab,
  recordConversation,
  tabsOf,
  type Arrangement,
  type Conversation,
} from "./arrangement";
import type { AgentSignals, TerminalStart } from "./runningTerminals";
import type { Settings } from "./settingsStore";
import { conversationOf, isInterrupted, WindowAgents, type AgentTerminals } from "./windowAgents";

const project = "C:/Projekt";

/** Ein Terminal, das nur festhält, womit es gestartet wurde. */
interface FakeTerminal {
  start: TerminalStart;
  signals: AgentSignals;
  /** Ob die Shell läuft, auch ohne dass der Tab angezeigt wurde. */
  running: boolean;
}

class FakeTerminals implements AgentTerminals<FakeTerminal> {
  readonly opened = new Map<string, FakeTerminal>();
  /** Wie oft ein Terminal entstanden ist, nach Tab. */
  readonly opens = new Map<string, number>();

  find(tabId: string) {
    return this.opened.get(tabId);
  }

  open(tabId: string, start: TerminalStart, signals: AgentSignals) {
    const terminal = { start, signals, running: false };
    this.opened.set(tabId, terminal);
    this.opens.set(tabId, (this.opens.get(tabId) ?? 0) + 1);
    return terminal;
  }

  startNow(tabId: string) {
    this.opened.get(tabId)!.running = true;
  }
}

const conversation: Conversation = { agent: "claudeCode", id: "abc-123", assignment: "Baue 24" };

function update(change: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    state: "working",
    lastAction: null,
    stateChanged: true,
    assignment: null,
    conversation: null,
    resumeFailed: false,
    backgroundTasks: [],
    subagents: [],
    ...change,
  };
}

/** Ein Fenster mit seiner Aufteilung, wie App sie hält. */
function windowWith(start: Arrangement, settings: Partial<Settings> = {}) {
  const terminals = new FakeTerminals();
  const statuses = new AgentStatuses();
  const state = { arrangement: start };
  const agents = new WindowAgents({
    terminals,
    statuses,
    change: (op) => (state.arrangement = op(state.arrangement)),
    settings: () => ({ resumeAgents: true, defaultShell: "powershell", ...settings }),
  });
  return { terminals, statuses, state, agents };
}

/** Eine Aufteilung mit zwei Agenten, deren zweiter sichtbar ist; der erste hat ein Gespräch. */
function twoAgents(remembered: Conversation = conversation): Arrangement {
  const first = openTab(emptyArrangement, true);
  const id = tabsOf(first)[0].id;
  return openTab(recordConversation(first, id, remembered), true);
}

describe("Gespräch einer Meldung", () => {
  it("ergibt aus jeder Meldung das Gespräch samt Auftrag, das die Aufteilung sich merkt", () => {
    const working = update({ assignment: "Baue 24", conversation: "abc-123" });

    expect(conversationOf(working)).toEqual({
      agent: "claudeCode",
      id: "abc-123",
      assignment: "Baue 24",
      working: true,
    });
    expect(conversationOf({ ...working, state: "done", assignment: null })).toEqual({
      agent: "claudeCode",
      id: "abc-123",
    });
    // Ohne Kennung ist der Agent beendet: kein Gespräch mehr.
    expect(conversationOf({ ...working, state: "unknown", conversation: null })).toBeUndefined();
  });
});

describe("Agenten des Fensters", () => {
  it("startet beim Wiederherstellen jeden Tab mit Gespräch sofort, auch verdeckt", () => {
    const stored = twoAgents();
    const [hidden, visible] = tabsOf(stored);
    const { terminals, agents } = windowWith(stored);

    agents.resumeAll(stored, project);

    const terminal = terminals.find(hidden.id);
    expect(terminal?.running).toBe(true);
    expect(terminal?.start).toEqual({
      cwd: project,
      shell: "powershell",
      agent: true,
      resume: conversation,
    });
    expect(terminals.find(visible.id)).toBeUndefined();
  });

  it("speichert mit der ersten Meldung das Gespräch samt Auftrag in der Aufteilung", () => {
    const shown = openTab(emptyArrangement, true);
    const [tab] = tabsOf(shown);
    const { terminals, statuses, state, agents } = windowWith(shown);

    agents.terminal(tab, project);
    terminals
      .find(tab.id)!
      .signals.onStatus(update({ conversation: "abc-123", assignment: "Baue 24" }));

    expect(tabsOf(state.arrangement)[0].conversation).toEqual({
      agent: "claudeCode",
      id: "abc-123",
      assignment: "Baue 24",
      working: true,
    });
    expect(statuses.snapshot().get(tab.id)?.state).toBe("working");
  });

  it("macht den Tab zum gewöhnlichen Terminal, wenn SessionEnd vor der ersten Meldung kommt", () => {
    const stored = twoAgents();
    const [resumed] = tabsOf(stored);
    const { terminals, statuses, state, agents } = windowWith(stored);

    agents.resumeAll(stored, project);
    terminals.find(resumed.id)!.signals.onStatus(update({ state: "unknown", resumeFailed: true }));

    const [tab] = tabsOf(state.arrangement);
    expect(tab.agent).toBeUndefined();
    expect(tab.conversation).toBeUndefined();
    expect(statuses.snapshot().has(resumed.id)).toBe(false);
  });

  it("macht den Tab zum gewöhnlichen Terminal, wenn der Startbefehl das Gespräch nicht fortsetzen kann", () => {
    const stored = twoAgents();
    const [resumed] = tabsOf(stored);
    const { terminals, state, agents } = windowWith(stored);

    agents.resumeAll(stored, project);
    terminals.find(resumed.id)!.signals.onOpened(false);

    const [tab] = tabsOf(state.arrangement);
    expect(tab.agent).toBeUndefined();
    expect(tab.conversation).toBeUndefined();
  });

  it("lässt einen neuen Agenten, dessen Startbefehl kein Claude Code ist, als Agenten stehen", () => {
    const shown = openTab(emptyArrangement, true);
    const [tab] = tabsOf(shown);
    const { terminals, state, agents } = windowWith(shown);

    agents.terminal(tab, project);
    terminals.find(tab.id)!.signals.onOpened(false);

    expect(tabsOf(state.arrangement)[0].agent).toBe(true);
  });

  it("startet den Agenten bei einem späteren Gespräch nicht neu; nur das erste zählt", () => {
    const shown = openTab(emptyArrangement, true);
    const [tab] = tabsOf(shown);
    const { terminals, state, agents } = windowWith(shown);

    const first = agents.terminal(tab, project);
    terminals.find(tab.id)!.signals.onStatus(update({ conversation: "abc-123" }));
    const again = agents.terminal(tabsOf(state.arrangement)[0], project);

    expect(again).toBe(first);
    expect(terminals.opens.get(tab.id)).toBe(1);
    expect(first.start.resume).toBeUndefined();
  });

  it("unterbricht beim Schließen einen arbeitenden Agenten, der zurückkommt", () => {
    const shown = openTab(emptyArrangement, true);
    const [tab] = tabsOf(shown);
    const { terminals, state, agents } = windowWith(shown);
    agents.terminal(tab, project);

    terminals.find(tab.id)!.signals.onStatus(update({ state: "done", conversation: "abc-123" }));
    expect(agents.returning(state.arrangement)).toEqual([tab.id]);
    expect(agents.closingInterrupts(state.arrangement)).toBe(false);

    terminals.find(tab.id)!.signals.onStatus(update({ conversation: "abc-123" }));
    expect(agents.closingInterrupts(state.arrangement)).toBe(true);
  });

  it("beendet beim Schließen die Hintergrundaufgaben eines Agenten, der zurückkommt", () => {
    const shown = openTab(emptyArrangement, true);
    const [tab] = tabsOf(shown);
    const { terminals, state, agents } = windowWith(shown);
    agents.terminal(tab, project);
    const signals = terminals.find(tab.id)!.signals;

    signals.onStatus(update({ state: "done", conversation: "abc-123" }));
    expect(agents.closingEndsBackgroundTasks(state.arrangement)).toBe(false);

    signals.onStatus(update({ state: "background", conversation: "abc-123" }));
    expect(agents.closingEndsBackgroundTasks(state.arrangement)).toBe(true);
    expect(agents.closingInterrupts(state.arrangement)).toBe(false);
  });

  it("lässt ohne „Agenten beim Öffnen fortsetzen“ keinen Agenten zurückkommen", () => {
    const shown = openTab(emptyArrangement, true);
    const [tab] = tabsOf(shown);
    const { terminals, state, agents } = windowWith(shown, { resumeAgents: false });
    agents.terminal(tab, project);

    terminals.find(tab.id)!.signals.onStatus(update({ conversation: "abc-123" }));

    expect(agents.returning(state.arrangement)).toEqual([]);
    expect(agents.closingInterrupts(state.arrangement)).toBe(false);
  });

  it("hält einen Agenten, der beim Schließen arbeitete, bis zu seiner ersten Meldung für unterbrochen", () => {
    const stored = twoAgents({ ...conversation, working: true });
    const [resumed, fresh] = tabsOf(stored);
    const { terminals, statuses, state, agents } = windowWith(stored);

    agents.resumeAll(stored, project);
    expect(isInterrupted(resumed, statuses.snapshot())).toBe(true);
    expect(isInterrupted(fresh, statuses.snapshot())).toBe(false);

    terminals.find(resumed.id)!.signals.onStatus(update({ conversation: "abc-123" }));
    expect(isInterrupted(tabsOf(state.arrangement)[0], statuses.snapshot())).toBe(false);
  });
});
