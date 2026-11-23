import { describe, expect, it } from "vitest";
import {
  AgentStatuses,
  countStates,
  duration,
  subagentLabel,
  subagentsInOrder,
  subagentSummary,
  subagentTooltip,
  type SubagentState,
  type SubagentStatus,
} from "./agentStatus";
import { translate } from "./i18n/i18n";

const working = {
  state: "working",
  lastAction: null,
  stateChanged: true,
  assignment: null,
  conversation: null,
  resumeFailed: false,
  backgroundTasks: [],
  subagents: [],
} as const;

describe("Agentenstatus eines Fensters", () => {
  it("kennt ohne Meldung keinen Status", () => {
    const statuses = new AgentStatuses();

    expect(statuses.snapshot().get("tab-1")).toBeUndefined();
  });

  it("ordnet jede Meldung dem Tab ihres Terminals zu", () => {
    const statuses = new AgentStatuses();

    statuses.report("tab-1", working, 1_000);
    statuses.report(
      "tab-2",
      {
        state: "waiting",
        lastAction: "Bash(cargo test)",
        stateChanged: true,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      },
      2_000,
    );

    expect(statuses.snapshot().get("tab-1")).toEqual({
      state: "working",
      lastAction: null,
      since: 1_000,
      subagents: [],
    });
    expect(statuses.snapshot().get("tab-2")).toEqual({
      state: "waiting",
      lastAction: "Bash(cargo test)",
      since: 2_000,
      subagents: [],
    });
  });

  it("zählt die Laufzeit ab dem Wechsel des Zustands, nicht ab der letzten Aktion", () => {
    const statuses = new AgentStatuses();

    statuses.report("tab-1", working, 1_000);
    statuses.report(
      "tab-1",
      {
        state: "working",
        lastAction: "Edit(src/App.tsx)",
        stateChanged: false,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      },
      5_000,
    );
    expect(statuses.snapshot().get("tab-1")).toEqual({
      state: "working",
      lastAction: "Edit(src/App.tsx)",
      since: 1_000,
      subagents: [],
    });

    statuses.report(
      "tab-1",
      {
        state: "done",
        lastAction: "Erledigt.",
        stateChanged: true,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      },
      9_000,
    );
    expect(statuses.snapshot().get("tab-1")?.since).toBe(9_000);
  });

  it("fällt auf „unbekannt“ zurück, wenn sich der Agent beendet", () => {
    const statuses = new AgentStatuses();
    statuses.report("tab-1", working, 1_000);

    statuses.report(
      "tab-1",
      {
        state: "unknown",
        lastAction: null,
        stateChanged: true,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      },
      2_000,
    );

    expect(statuses.snapshot().has("tab-1")).toBe(false);
  });

  it("vergisst den Status eines geschlossenen Tabs", () => {
    const statuses = new AgentStatuses();
    statuses.report("tab-1", working, 1_000);
    statuses.report("tab-2", working, 1_000);

    statuses.retain(new Set(["tab-2"]));

    expect([...statuses.snapshot().keys()]).toEqual(["tab-2"]);
  });

  it("benachrichtigt Abonnenten bei jeder Änderung mit einem neuen Stand", () => {
    const statuses = new AgentStatuses();
    const before = statuses.snapshot();
    let calls = 0;
    const unsubscribe = statuses.subscribe(() => calls++);

    statuses.report("tab-1", working, 1_000);
    expect(calls).toBe(1);
    expect(statuses.snapshot()).not.toBe(before);
    expect(before.size).toBe(0);

    // Ohne Änderung bleibt der Stand derselbe; so zeichnet React nicht neu.
    const unchanged = statuses.snapshot();
    statuses.retain(new Set(["tab-1"]));
    expect(statuses.snapshot()).toBe(unchanged);
    expect(calls).toBe(1);

    unsubscribe();
    statuses.report(
      "tab-1",
      {
        state: "done",
        lastAction: null,
        stateChanged: true,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      },
      2_000,
    );
    expect(calls).toBe(1);
  });

  it("zählt arbeitende, wartende und fertige Agenten", () => {
    const statuses = new AgentStatuses();
    statuses.report("tab-1", working, 1_000);
    statuses.report("tab-2", working, 1_000);
    statuses.report(
      "tab-3",
      {
        state: "waiting",
        lastAction: null,
        stateChanged: true,
        assignment: null,
        conversation: null,
        resumeFailed: false,
        backgroundTasks: [],
        subagents: [],
      },
      1_000,
    );

    expect(countStates(statuses.snapshot().values())).toEqual({
      working: 2,
      waiting: 1,
      background: 0,
      done: 0,
    });
  });
});

describe("Subagenten eines Agenten", () => {
  const explore = {
    id: "a1",
    kind: "Explore",
    description: "Datei a lesen",
    state: "working",
    lastAction: null,
  } as const;

  it("übernimmt die Subagenten mit dem Zeitpunkt ihres ersten Auftretens", () => {
    const statuses = new AgentStatuses();

    statuses.report("tab-1", { ...working, subagents: [explore] }, 1_000);
    statuses.report(
      "tab-1",
      {
        ...working,
        stateChanged: false,
        subagents: [
          { ...explore, lastAction: "Read(a.txt)" },
          { ...explore, id: "b2", description: null },
        ],
      },
      3_000,
    );

    expect(statuses.snapshot().get("tab-1")?.subagents).toEqual([
      { ...explore, lastAction: "Read(a.txt)", started: 1_000, ended: null },
      { ...explore, id: "b2", description: null, started: 3_000, ended: null },
    ]);
  });

  it("hält die Laufzeit eines fertigen Subagenten an", () => {
    const statuses = new AgentStatuses();
    statuses.report("tab-1", { ...working, subagents: [explore] }, 1_000);

    statuses.report(
      "tab-1",
      { ...working, subagents: [{ ...explore, state: "done", lastAction: "Fertig." }] },
      9_000,
    );
    statuses.report(
      "tab-1",
      { ...working, subagents: [{ ...explore, state: "done", lastAction: "Fertig." }] },
      20_000,
    );

    expect(statuses.snapshot().get("tab-1")?.subagents[0]).toMatchObject({
      state: "done",
      started: 1_000,
      ended: 9_000,
    });
  });

  it("lässt die Laufzeit eines wartenden Subagenten weiterlaufen", () => {
    const statuses = new AgentStatuses();
    statuses.report("tab-1", { ...working, subagents: [explore] }, 1_000);

    statuses.report(
      "tab-1",
      { ...working, subagents: [{ ...explore, state: "waiting", lastAction: "Bash(git push)" }] },
      9_000,
    );

    expect(statuses.snapshot().get("tab-1")?.subagents[0]).toMatchObject({
      state: "waiting",
      started: 1_000,
      ended: null,
    });
  });

  it("zählt Subagenten nicht als Agenten", () => {
    const statuses = new AgentStatuses();

    statuses.report(
      "tab-1",
      { ...working, subagents: [explore, { ...explore, id: "b2", state: "done" }] },
      1_000,
    );

    expect(countStates(statuses.snapshot().values())).toEqual({
      working: 1,
      waiting: 0,
      background: 0,
      done: 0,
    });
  });
});

describe("Zeile eines Subagenten", () => {
  const subagent = {
    id: "a1",
    kind: "Explore",
    description: "Datei a lesen",
    state: "working",
    lastAction: "Grep(agent_id)",
    started: 0,
    ended: null,
  } as const;

  it("nennt die Beschreibung, ohne sie den Typ", () => {
    expect(subagentLabel(subagent)).toBe("Datei a lesen");
    expect(subagentLabel({ ...subagent, description: null })).toBe("Explore");
  });

  it("zeigt Typ und letzte Aktion im Tooltip", () => {
    expect(subagentTooltip(subagent)).toBe("Explore · Grep(agent_id)");
    expect(subagentTooltip({ ...subagent, lastAction: null })).toBe("Explore");
  });
});

describe("Viele Subagenten", () => {
  const sub = (id: string, state: SubagentState) =>
    ({
      id,
      kind: "general-purpose",
      description: id,
      state,
      lastAction: null,
      started: 0,
      ended: null,
    }) as const;

  it("stellt arbeitende vor fertige und behält sonst die Startreihenfolge", () => {
    const ordered = subagentsInOrder([
      sub("bugs", "done"),
      sub("standards", "working"),
      sub("spec", "done"),
      sub("rust", "working"),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(["standards", "rust", "bugs", "spec"]);
  });

  it("stellt wartende vor arbeitende", () => {
    const ordered = subagentsInOrder([
      sub("bugs", "done"),
      sub("standards", "working"),
      sub("check", "waiting"),
    ]);

    expect(ordered.map(({ id }) => id)).toEqual(["check", "standards", "bugs"]);
  });
});

describe("Zusammenfassung eingeklappter Subagenten", () => {
  const t = translate.bind(null, "de");
  const sub = (id: string, state: SubagentState): SubagentStatus => ({
    id,
    kind: "general-purpose",
    description: id,
    state,
    lastAction: null,
    started: 0,
    ended: state === "done" ? 1_000 : null,
  });
  const text = (subagents: SubagentStatus[]) =>
    subagentSummary(t, subagents)
      .map((part) => part.text)
      .join(" · ");

  it("nennt die Anzahl und wie viele arbeiten", () => {
    const six = ["a", "b", "c"].flatMap((id) => [sub(id, "working"), sub(`${id}2`, "done")]);
    expect(text(six)).toBe("6 Subagenten · 3 arbeiten");
    expect(text([sub("a", "working"), sub("b", "done")])).toBe("2 Subagenten · 1 arbeitet");
  });

  it("sagt „alle fertig“, wenn keiner mehr arbeitet", () => {
    expect(text([sub("a", "done"), sub("b", "done")])).toBe("2 Subagenten · alle fertig");
    expect(text([sub("a", "done")])).toBe("1 Subagent · alle fertig");
  });

  it("nennt wartende vor arbeitenden", () => {
    expect(text([sub("a", "waiting"), sub("b", "done")])).toBe("2 Subagenten · 1 wartet");
    expect(text([sub("a", "working"), sub("b", "waiting"), sub("c", "waiting")])).toBe(
      "3 Subagenten · 2 warten · 1 arbeitet",
    );
  });

  it("färbt den Teil der wartenden wie ihren Zustand", () => {
    expect(subagentSummary(t, [sub("a", "waiting")])[1]).toEqual({
      text: "1 wartet",
      state: "waiting",
    });
  });

  it("färbt den Teil der arbeitenden wie ihren Zustand", () => {
    expect(subagentSummary(t, [sub("a", "working")])).toEqual([
      { text: "1 Subagent", state: null },
      { text: "1 arbeitet", state: "working" },
    ]);
  });
});

describe("Laufzeit", () => {
  it("zeigt Sekunden, dann Minuten, dann Stunden mit Minuten", () => {
    expect(duration(0)).toEqual({ key: "duration.seconds", values: { count: "0" } });
    expect(duration(40_900)).toEqual({ key: "duration.seconds", values: { count: "40" } });
    expect(duration(60_000)).toEqual({ key: "duration.minutes", values: { count: "1" } });
    expect(duration(12 * 60_000 + 59_000)).toEqual({
      key: "duration.minutes",
      values: { count: "12" },
    });
    expect(duration(65 * 60_000)).toEqual({
      key: "duration.hours",
      values: { hours: "1", minutes: "5" },
    });
  });

  it("wird nie negativ, auch wenn die Uhr zurückgestellt wurde", () => {
    expect(duration(-5_000)).toEqual({ key: "duration.seconds", values: { count: "0" } });
  });
});
