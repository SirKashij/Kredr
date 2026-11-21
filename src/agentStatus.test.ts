import { describe, expect, it } from "vitest";
import { AgentStatuses, countStates, duration } from "./agentStatus";

const working = {
  state: "working",
  lastAction: null,
  stateChanged: true,
  assignment: null,
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
      { state: "waiting", lastAction: "Bash(cargo test)", stateChanged: true, assignment: null },
      2_000,
    );

    expect(statuses.snapshot().get("tab-1")).toEqual({
      state: "working",
      lastAction: null,
      since: 1_000,
      assignment: null,
    });
    expect(statuses.snapshot().get("tab-2")).toEqual({
      state: "waiting",
      lastAction: "Bash(cargo test)",
      since: 2_000,
      assignment: null,
    });
  });

  it("zählt die Laufzeit ab dem Wechsel des Zustands, nicht ab der letzten Aktion", () => {
    const statuses = new AgentStatuses();

    statuses.report("tab-1", working, 1_000);
    statuses.report(
      "tab-1",
      { state: "working", lastAction: "Edit(src/App.tsx)", stateChanged: false, assignment: null },
      5_000,
    );
    expect(statuses.snapshot().get("tab-1")).toEqual({
      state: "working",
      lastAction: "Edit(src/App.tsx)",
      since: 1_000,
      assignment: null,
    });

    statuses.report(
      "tab-1",
      { state: "done", lastAction: "Erledigt.", stateChanged: true, assignment: null },
      9_000,
    );
    expect(statuses.snapshot().get("tab-1")?.since).toBe(9_000);
  });

  it("übernimmt den Auftrag mit jeder Meldung", () => {
    const statuses = new AgentStatuses();

    statuses.report("tab-1", { ...working, assignment: "/mattpocock-skills:implement 24" }, 1_000);

    expect(statuses.snapshot().get("tab-1")?.assignment).toBe("/mattpocock-skills:implement 24");
  });

  it("fällt auf „unbekannt“ zurück, wenn sich der Agent beendet", () => {
    const statuses = new AgentStatuses();
    statuses.report("tab-1", working, 1_000);

    statuses.report(
      "tab-1",
      { state: "unknown", lastAction: null, stateChanged: true, assignment: null },
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
      { state: "done", lastAction: null, stateChanged: true, assignment: null },
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
      { state: "waiting", lastAction: null, stateChanged: true, assignment: null },
      1_000,
    );

    expect(countStates(statuses.snapshot())).toEqual({ working: 2, waiting: 1, done: 0 });
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
