import { describe, expect, it } from "vitest";
import type { AgentState, Statuses } from "./agentStatus";
import { translate } from "./i18n/i18n";
import { alertBody, decide, noAlerts, QUIET_MS, type Alerts } from "./waitingAlerts";

/** Der Agentenstatus eines Fensters: je Tab der Zustand und seit wann er gilt. */
function statuses(tabs: Record<string, [AgentState, number]>): Statuses {
  return new Map(
    Object.entries(tabs).map(([tabId, [state, since]]) => [
      tabId,
      { state, lastAction: null, since },
    ]),
  );
}

/** Das Fenster liegt im Hintergrund, Benachrichtigungen sind eingeschaltet. */
const background = { foreground: false, enabled: true };

describe("Wann sich Kredr wegen eines wartenden Agenten meldet", () => {
  it("meldet einen Agenten, der im Hintergrund auf Eingabe wartet", () => {
    const decision = decide(noAlerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000] }),
      now: 1_000,
    });

    expect(decision.notify).toEqual(["t1"]);
  });

  it("meldet nichts, solange das Fenster im Vordergrund ist", () => {
    const decision = decide(noAlerts, {
      foreground: true,
      enabled: true,
      statuses: statuses({ t1: ["waiting", 1_000] }),
      now: 1_000,
    });

    expect(decision.notify).toBeNull();
    expect(decision.checkAgainAt).toBeNull();
  });

  it("meldet nichts, wenn Benachrichtigungen abgeschaltet sind", () => {
    const decision = decide(noAlerts, {
      foreground: false,
      enabled: false,
      statuses: statuses({ t1: ["waiting", 1_000] }),
      now: 1_000,
    });

    expect(decision.notify).toBeNull();
    expect(decision.checkAgainAt).toBeNull();
  });

  it("meldet nur den Wechsel auf „wartet auf Eingabe“, nicht jede weitere Meldung", () => {
    const first = decide(noAlerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000], t2: ["working", 1_000] }),
      now: 1_000,
    });

    // Der andere Agent wird fertig; am wartenden ändert sich nichts.
    const second = decide(first.alerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000], t2: ["done", 60_000] }),
      now: 60_000,
    });

    expect(second.notify).toBeNull();
  });

  it("meldet einen Agenten erneut, wenn er nach weiterer Arbeit wieder wartet", () => {
    let { alerts } = decide(noAlerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000] }),
      now: 1_000,
    });
    ({ alerts } = decide(alerts, {
      ...background,
      statuses: statuses({ t1: ["working", 30_000] }),
      now: 30_000,
    }));

    const decision = decide(alerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 60_000] }),
      now: 60_000,
    });

    expect(decision.notify).toEqual(["t1"]);
  });

  it("meldet einen Agenten nicht nachträglich, der schon im Vordergrund wartete", () => {
    const waiting = statuses({ t1: ["waiting", 1_000] });
    const seen = decide(noAlerts, {
      foreground: true,
      enabled: true,
      statuses: waiting,
      now: 1_000,
    });

    const decision = decide(seen.alerts, { ...background, statuses: waiting, now: 2_000 });

    expect(decision.notify).toBeNull();
  });

  it("meldet nach dem Einschalten nicht nach, was währenddessen wartete", () => {
    const waiting = statuses({ t1: ["waiting", 1_000] });
    const off = decide(noAlerts, {
      foreground: false,
      enabled: false,
      statuses: waiting,
      now: 1_000,
    });

    const decision = decide(off.alerts, { ...background, statuses: waiting, now: 2_000 });

    expect(decision.notify).toBeNull();
  });
});

describe("Mehrere kurz hintereinander wartende Agenten", () => {
  /** Ein Agent wartet und ist gemeldet; gleich darauf warten zwei weitere. */
  function threeWaiting(): { alerts: Alerts; all: Statuses } {
    const first = decide(noAlerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000] }),
      now: 1_000,
    });
    const all = statuses({
      t1: ["waiting", 1_000],
      t2: ["waiting", 1_500],
      t3: ["waiting", 2_000],
    });
    const second = decide(first.alerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000], t2: ["waiting", 1_500] }),
      now: 1_500,
    });
    expect(second.notify).toBeNull();
    const third = decide(second.alerts, { ...background, statuses: all, now: 2_000 });
    expect(third.notify).toBeNull();
    expect(third.checkAgainAt).toBe(1_000 + QUIET_MS);
    return { alerts: third.alerts, all };
  }

  it("ergeben nach der Ruhezeit eine einzige Benachrichtigung für alle", () => {
    const { alerts, all } = threeWaiting();

    const decision = decide(alerts, { ...background, statuses: all, now: 1_000 + QUIET_MS });

    expect(decision.notify).toEqual(["t1", "t2", "t3"]);
    expect(decision.checkAgainAt).toBeNull();
  });

  it("ergeben zusammen eine Benachrichtigung, wenn sie gleichzeitig warten", () => {
    const decision = decide(noAlerts, {
      ...background,
      statuses: statuses({ t1: ["waiting", 1_000], t2: ["waiting", 1_000] }),
      now: 1_000,
    });

    expect(decision.notify).toEqual(["t1", "t2"]);
  });

  it("bleiben ungemeldet, wenn das Fenster vor Ablauf der Ruhezeit nach vorn kommt", () => {
    const { alerts, all } = threeWaiting();
    const attended = decide(alerts, {
      foreground: true,
      enabled: true,
      statuses: all,
      now: 3_000,
    });

    const decision = decide(attended.alerts, {
      ...background,
      statuses: all,
      now: 1_000 + QUIET_MS,
    });

    expect(attended.checkAgainAt).toBeNull();
    expect(decision.notify).toBeNull();
  });

  it("nennen nach der Ruhezeit keinen Agenten mehr, der inzwischen weiterarbeitet", () => {
    const { alerts } = threeWaiting();

    const decision = decide(alerts, {
      ...background,
      statuses: statuses({
        t1: ["working", 4_000],
        t2: ["waiting", 1_500],
        t3: ["waiting", 2_000],
      }),
      now: 1_000 + QUIET_MS,
    });

    expect(decision.notify).toEqual(["t2", "t3"]);
  });

  it("werden nicht mehr gemeldet, wenn der Schalter in der Ruhezeit ausgeht", () => {
    const { alerts, all } = threeWaiting();

    const decision = decide(alerts, {
      foreground: false,
      enabled: false,
      statuses: all,
      now: 1_000 + QUIET_MS,
    });

    expect(decision.notify).toBeNull();
    expect(decision.checkAgainAt).toBeNull();
  });

  it("zählen nach dem Blick ins Fenster von vorn", () => {
    const { alerts, all } = threeWaiting();
    const attended = decide(alerts, { foreground: true, enabled: true, statuses: all, now: 3_000 });

    const decision = decide(attended.alerts, {
      ...background,
      statuses: new Map([...all, ...statuses({ t4: ["waiting", 90_000] })]),
      now: 90_000,
    });

    expect(decision.notify).toEqual(["t4"]);
  });
});

describe("Text der Benachrichtigung", () => {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string>) =>
    translate("de", key, values);

  it("nennt das wartende Terminal", () => {
    expect(alertBody(["Agent"], t)).toBe("Agent wartet auf Eingabe");
  });

  it("fasst mehrere wartende Agenten zusammen", () => {
    expect(alertBody(["Agent", "Tests"], t)).toBe("2 Agenten warten auf Eingabe: Agent, Tests");
  });

  it("nennt gleichnamige Terminals nur einmal", () => {
    expect(alertBody(["Agent", "Tests", "Agent"], t)).toBe(
      "3 Agenten warten auf Eingabe: Agent, Tests",
    );
  });
});
