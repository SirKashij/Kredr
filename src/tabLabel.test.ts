import { describe, expect, it } from "vitest";
import type { Tab } from "./arrangement";
import { translate, type Translate } from "./i18n/i18n";
import { terminalTabLabel } from "./tabLabel";

const t: Translate = (key, values) => translate("de", key, values);
const agent: Tab = { id: "tab-1", agent: true };

/** Der Agent mit einem Gespräch, dessen Auftrag `assignment` ist. */
function assigned(assignment: string, tab: Tab = agent): Tab {
  return { ...tab, conversation: { agent: "claudeCode", id: "abc-123", assignment } };
}

describe("Beschriftung eines Agenten-Tabs", () => {
  it("zeigt den Auftrag groß und darüber klein „Agent“", () => {
    expect(terminalTabLabel(assigned("/mattpocock-skills:implement 24"), true, t)).toEqual({
      kicker: "Agent",
      text: "/mattpocock-skills:implement 24",
      assignment: "/mattpocock-skills:implement 24",
    });
  });

  it("ist ohne Auftrag einzeilig „Agent“ wie bisher", () => {
    const withoutAssignment: Tab = { ...agent, conversation: { agent: "claudeCode", id: "abc" } };

    for (const tab of [agent, withoutAssignment]) {
      expect(terminalTabLabel(tab, true, t)).toEqual({
        kicker: null,
        text: "Agent",
        assignment: null,
      });
    }
  });

  it("zeigt von einem langen Auftrag nur die gekürzte erste Zeile, im Tooltip alles", () => {
    const long =
      "  Warum schlägt arrangementRestore fehl, wenn zwei Gruppen leer sind?\nHier der Log:\n…";

    const label = terminalTabLabel(assigned(long), true, t);

    expect(label.text).toBe("Warum schlägt arrangementRestor…");
    expect([...label.text]).toHaveLength(32);
    expect(label.assignment).toBe(long);
  });

  it("zeigt statt des Auftrags einen eigenen Namen", () => {
    const named = assigned("Baue Ticket 24", { ...agent, name: "Backend" });

    expect(terminalTabLabel(named, true, t)).toEqual({
      kicker: "Agent",
      text: "Backend",
      assignment: "Baue Ticket 24",
    });
  });

  it("zeigt bei abgeschaltetem Auftrag wieder „Agent“ bzw. den eigenen Namen", () => {
    expect(terminalTabLabel(assigned("Baue Ticket 24"), false, t)).toEqual({
      kicker: null,
      text: "Agent",
      assignment: null,
    });
    const named = assigned("Baue Ticket 24", { ...agent, name: "Backend" });
    expect(terminalTabLabel(named, false, t).text).toBe("Backend");
  });

  it("lässt reine Terminals unberührt", () => {
    const terminal: Tab = { id: "tab-2", shell: "gitBash" };

    expect(terminalTabLabel(terminal, true, t)).toEqual({
      kicker: null,
      text: "Git Bash",
      assignment: null,
    });
  });
});
