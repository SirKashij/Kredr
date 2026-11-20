import { expect, test } from "vitest";
import {
  activateAdjacentTab,
  activateTab,
  closeTab,
  emptyArrangement,
  focusAdjacentGroup,
  focusGroup,
  focusGroupAt,
  focusGroupToward,
  groupsOf,
  moveDivider,
  moveTab,
  assignShell,
  openTab,
  openTabIn,
  renameTab,
  splitGroup,
  tabsOf,
  type Arrangement,
  type Group,
  type Split,
} from "./arrangement";

test("das erste Terminal öffnet sich als Tab einer neuen Gruppe", () => {
  const arrangement = openTab(emptyArrangement);

  const groups = groupsOf(arrangement);
  expect(groups).toHaveLength(1);
  expect(groups[0].tabs).toHaveLength(1);
  expect(groups[0].activeTab).toBe(groups[0].tabs[0].id);
  expect(arrangement.focusedGroup).toBe(groups[0].id);
});

test("weitere Terminals öffnen sich als Tabs derselben Gruppe", () => {
  const arrangement = openTab(openTab(emptyArrangement));

  const [group, ...others] = groupsOf(arrangement);
  expect(others).toEqual([]);
  expect(group.tabs).toHaveLength(2);
  expect(new Set(group.tabs.map((tab) => tab.id)).size).toBe(2);
  expect(group.activeTab).toBe(group.tabs[1].id);
});

test("ein Tab schließt sich; der Nachbar wird sichtbar", () => {
  const three = openTab(openTab(openTab(emptyArrangement)));
  const [first, second, third] = groupsOf(three)[0].tabs;

  const closedActive = closeTab(three, third.id);
  expect(groupsOf(closedActive)[0]).toMatchObject({ tabs: [first, second], activeTab: second.id });

  const closedInactive = closeTab(three, first.id);
  expect(groupsOf(closedInactive)[0]).toMatchObject({ tabs: [second, third], activeTab: third.id });
});

/** Eine Aufteilung mit einer Gruppe und einem Tab. */
const single = openTab(emptyArrangement);

test("nach rechts teilen legt rechts eine neue Gruppe mit eigenem Tab an", () => {
  const [original] = groupsOf(single);

  const arrangement = splitGroup(single, original.id, "right");

  const groups = groupsOf(arrangement);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toEqual(original);
  expect(groups[1].tabs).toHaveLength(1);
  expect(groups[1].tabs[0].id).not.toBe(original.tabs[0].id);
  expect(arrangement.root).toMatchObject({ kind: "split", axis: "row", sizes: [0.5, 0.5] });
  expect(arrangement.focusedGroup).toBe(groups[1].id);
});

test("nach unten teilen legt die neue Gruppe darunter an", () => {
  const arrangement = splitGroup(single, groupsOf(single)[0].id, "down");

  expect(arrangement.root).toMatchObject({ kind: "split", axis: "column", sizes: [0.5, 0.5] });
});

test("eine Gruppe verschwindet mit ihrem letzten Tab; die Nachbarn füllen den Platz", () => {
  const [a] = groupsOf(single);
  const once = splitGroup(single, a.id, "right");
  const b = groupsOf(once)[1];
  const three = splitGroup(once, a.id, "right");
  const c = groupsOf(three)[1];
  // a 25 %, c 25 %, b 50 %

  const closed = closeTab(three, c.tabs[0].id);

  expect(groupsOf(closed).map((group) => group.id)).toEqual([a.id, b.id]);
  const sizes = (closed.root as Split).sizes;
  expect(sizes[0]).toBeCloseTo(1 / 3);
  expect(sizes[1]).toBeCloseTo(2 / 3);
});

test("verschwindet die fokussierte Gruppe, erhält eine Nachbargruppe den Fokus", () => {
  const [a] = groupsOf(single);
  const split = splitGroup(single, a.id, "right");
  const b = groupsOf(split)[1];
  expect(split.focusedGroup).toBe(b.id);

  const closed = closeTab(split, b.tabs[0].id);

  expect(closed.focusedGroup).toBe(a.id);
});

test("bleibt von einer Teilung nur ein Teilstück, tritt es an ihre Stelle", () => {
  const [a] = groupsOf(single);
  const right = splitGroup(single, a.id, "right");
  const b = groupsOf(right)[1];
  const nested = splitGroup(right, b.id, "down");
  const c = groupsOf(nested)[2];
  const deeper = splitGroup(nested, c.id, "right");
  const d = groupsOf(deeper)[3];
  // a | (b über (c | d))

  const closed = closeTab(deeper, b.tabs[0].id);

  // c und d liegen jetzt in derselben Zeile wie a und teilen sich dessen rechte Hälfte.
  expect(closed.root).toMatchObject({
    axis: "row",
    sizes: [0.5, 0.25, 0.25],
    children: [{ id: a.id }, { id: c.id }, { id: d.id }],
  });

  const alone = closeTab(right, b.tabs[0].id);
  expect(alone.root).toEqual(a);
});

test("mit dem letzten Tab der letzten Gruppe ist der Hauptbereich leer", () => {
  const closed = closeTab(single, groupsOf(single)[0].tabs[0].id);

  expect(closed.root).toBeNull();
  expect(closed.focusedGroup).toBeNull();
  expect(groupsOf(closed)).toEqual([]);

  // Danach lässt sich wieder ein Terminal öffnen, mit frischen Kennungen.
  const reopened = openTab(closed);
  expect(groupsOf(reopened)).toHaveLength(1);
  expect(groupsOf(reopened)[0].id).not.toBe(groupsOf(single)[0].id);
});

test("beliebig tief teilen: gleiche Richtung reiht ein, andere Richtung schachtelt", () => {
  const [a] = groupsOf(single);
  const once = splitGroup(single, a.id, "right");
  const [, b] = groupsOf(once);
  const twice = splitGroup(once, a.id, "right");
  const c = groupsOf(twice)[1];

  // Die geteilte Gruppe gibt die Hälfte ihres Platzes ab, die neue liegt direkt neben ihr.
  expect(twice.root).toMatchObject({
    axis: "row",
    sizes: [0.25, 0.25, 0.5],
    children: [{ id: a.id }, { id: c.id }, { id: b.id }],
  });

  const nested = splitGroup(twice, b.id, "down");
  const d = groupsOf(nested)[3];
  expect(nested.root).toMatchObject({
    axis: "row",
    sizes: [0.25, 0.25, 0.5],
    children: [
      { id: a.id },
      { id: c.id },
      { axis: "column", sizes: [0.5, 0.5], children: [{ id: b.id }, { id: d.id }] },
    ],
  });
});

/** Drei Gruppen nebeneinander, von links: a 25 %, c 25 %, b 50 %. */
function threeSideBySide() {
  const [a] = groupsOf(single);
  const once = splitGroup(single, a.id, "right");
  const b = groupsOf(once)[1];
  const arrangement = splitGroup(once, a.id, "right");
  const c = groupsOf(arrangement)[1];
  return { arrangement, a, b, c, split: arrangement.root as Split };
}

test("eine Trennlinie verschieben ändert nur die Größe ihrer beiden Nachbarn", () => {
  const { arrangement, split } = threeSideBySide();

  // Die zweite Trennlinie liegt bei 50 % und wandert auf 70 %.
  const moved = moveDivider(arrangement, split.id, 1, 0.7);

  const sizes = (moved.root as Split).sizes;
  expect(sizes[0]).toBeCloseTo(0.25);
  expect(sizes[1]).toBeCloseTo(0.45);
  expect(sizes[2]).toBeCloseTo(0.3);
  expect(groupsOf(moved)).toEqual(groupsOf(arrangement));
});

test("eine Trennlinie lässt jedem Nachbarn eine Mindestgröße", () => {
  const { arrangement, split } = threeSideBySide();

  const farLeft = (moveDivider(arrangement, split.id, 1, 0.1, 0.05).root as Split).sizes;
  expect(farLeft[0]).toBeCloseTo(0.25);
  expect(farLeft[1]).toBeCloseTo(0.05);
  expect(farLeft[2]).toBeCloseTo(0.7);

  const farRight = (moveDivider(arrangement, split.id, 1, 2, 0.05).root as Split).sizes;
  expect(farRight[1]).toBeCloseTo(0.7);
  expect(farRight[2]).toBeCloseTo(0.05);
});

test("einen Tab anzeigen gibt seiner Gruppe den Fokus", () => {
  const { arrangement, a, b } = threeSideBySide();
  const two = openTab(focusGroup(arrangement, a.id));
  const b2 = splitGroup(two, b.id, "down");
  expect(b2.focusedGroup).not.toBe(a.id);

  const shown = activateTab(b2, a.tabs[0].id);

  expect(shown.focusedGroup).toBe(a.id);
  expect(groupsOf(shown)[0].activeTab).toBe(a.tabs[0].id);
});

test("der Fokus wandert reihum durch die Gruppen", () => {
  const { arrangement, a, b, c } = threeSideBySide();
  const atA = focusGroup(arrangement, a.id);

  expect(focusAdjacentGroup(atA, 1).focusedGroup).toBe(c.id);
  expect(focusAdjacentGroup(atA, -1).focusedGroup).toBe(b.id);
  expect(focusAdjacentGroup(focusGroup(arrangement, b.id), 1).focusedGroup).toBe(a.id);
});

test("der Fokus springt auf die Gruppe an einer Stelle; fehlt sie, bleibt er", () => {
  const { arrangement, a, b } = threeSideBySide();

  expect(focusGroupAt(arrangement, 2).focusedGroup).toBe(b.id);
  expect(focusGroupAt(arrangement, 0).focusedGroup).toBe(a.id);
  expect(focusGroupAt(arrangement, 5)).toBe(arrangement);
});

test("in der fokussierten Gruppe wechselt der sichtbare Tab reihum", () => {
  const three = openTab(openTab(openTab(emptyArrangement)));
  const [first, second, third] = groupsOf(three)[0].tabs;

  const next = activateAdjacentTab(three, 1);
  expect(groupsOf(next)[0].activeTab).toBe(first.id);
  expect(groupsOf(activateAdjacentTab(next, 1))[0].activeTab).toBe(second.id);
  expect(groupsOf(activateAdjacentTab(next, -1))[0].activeTab).toBe(third.id);
});

test("Operationen auf unbekannte Kennungen und auf den leeren Hauptbereich ändern nichts", () => {
  const { arrangement } = threeSideBySide();

  expect(closeTab(arrangement, "fehlt")).toBe(arrangement);
  expect(splitGroup(arrangement, "fehlt", "right")).toBe(arrangement);
  expect(focusGroup(arrangement, "fehlt")).toBe(arrangement);
  expect(activateTab(arrangement, "fehlt")).toBe(arrangement);
  expect(moveDivider(arrangement, "fehlt", 0, 0.5)).toBe(arrangement);
  expect(focusAdjacentGroup(emptyArrangement, 1)).toBe(emptyArrangement);
  expect(activateAdjacentTab(emptyArrangement, 1)).toBe(emptyArrangement);
});

test("die Aufteilung übersteht den Weg durch JSON und bleibt bedienbar", () => {
  const { arrangement, b } = threeSideBySide();

  const restored: Arrangement = JSON.parse(JSON.stringify(arrangement));

  expect(restored).toEqual(arrangement);
  expect(restored.version).toBe(1);
  expect(closeTab(restored, b.tabs[0].id)).toEqual(closeTab(arrangement, b.tabs[0].id));
  expect(splitGroup(restored, b.id, "down")).toEqual(splitGroup(arrangement, b.id, "down"));
});

test("der Fokus springt zur Gruppe, die in einer Richtung angrenzt", () => {
  const [a] = groupsOf(single);
  const right = splitGroup(single, a.id, "right");
  const b = groupsOf(right)[1];
  const nested = splitGroup(right, b.id, "down");
  const c = groupsOf(nested)[2];
  const arrangement = splitGroup(nested, c.id, "right");
  const d = groupsOf(arrangement)[3];
  // a links über die ganze Höhe; rechts b oben, darunter c und d nebeneinander.
  const from = (group: Group) => focusGroup(arrangement, group.id);

  expect(focusGroupToward(from(a), "right").focusedGroup).toBe(b.id);
  expect(focusGroupToward(from(b), "down").focusedGroup).toBe(c.id);
  expect(focusGroupToward(from(c), "right").focusedGroup).toBe(d.id);
  expect(focusGroupToward(from(d), "up").focusedGroup).toBe(b.id);
  expect(focusGroupToward(from(d), "left").focusedGroup).toBe(c.id);
  expect(focusGroupToward(from(c), "left").focusedGroup).toBe(a.id);
});

test("grenzt in einer Richtung keine Gruppe an, bleibt der Fokus", () => {
  const { arrangement, a, b } = threeSideBySide();

  expect(focusGroupToward(focusGroup(arrangement, a.id), "left").focusedGroup).toBe(a.id);
  expect(focusGroupToward(focusGroup(arrangement, b.id), "right").focusedGroup).toBe(b.id);
  expect(focusGroupToward(arrangement, "up")).toBe(arrangement);
  expect(focusGroupToward(emptyArrangement, "down")).toBe(emptyArrangement);
});

test("ein neuer Tab geht nie verloren, auch wenn keine gültige Gruppe den Fokus hat", () => {
  const { arrangement, a } = threeSideBySide();
  // So kann eine gespeicherte Aufteilung aussehen, die von Hand verändert wurde.
  const stale: Arrangement = { ...arrangement, focusedGroup: "fehlt" };

  const opened = openTab(stale);

  expect(groupsOf(opened)[0].tabs).toHaveLength(2);
  expect(opened.focusedGroup).toBe(a.id);
});

/** Zwei Gruppen nebeneinander: links a mit den Tabs a1, a2 (sichtbar), a3; rechts b mit b1. */
function twoGroups() {
  const three = openTab(openTab(single));
  const tabbed = activateTab(three, groupsOf(three)[0].tabs[1].id);
  const arrangement = splitGroup(tabbed, groupsOf(tabbed)[0].id, "right");
  const [a, b] = groupsOf(arrangement);
  const [a1, a2, a3] = a.tabs;
  return { arrangement, a, b, a1, a2, a3, b1: b.tabs[0] };
}

test("ein Tab zieht in eine andere Gruppe um, wird dort sichtbar und nimmt den Fokus mit", () => {
  const { arrangement, a, b, a1, a2, a3, b1 } = twoGroups();
  const focusedLeft = focusGroup(arrangement, a.id);

  const moved = moveTab(focusedLeft, a2.id, { groupId: b.id, index: 0 });

  const [left, right] = groupsOf(moved);
  // In der alten Gruppe rückt der rechte Nachbar nach.
  expect(left).toMatchObject({ id: a.id, tabs: [a1, a3], activeTab: a3.id });
  expect(right).toMatchObject({ id: b.id, tabs: [a2, b1], activeTab: a2.id });
  expect(moved.focusedGroup).toBe(b.id);
  // Die Aufteilung davor bleibt, wie sie war.
  expect(groupsOf(focusedLeft)[0].tabs).toEqual([a1, a2, a3]);
});

test("Tabs lassen sich innerhalb ihrer Gruppe umsortieren", () => {
  const { arrangement, a, a1, a2, a3 } = twoGroups();
  const order = (moved: Arrangement) => groupsOf(moved)[0].tabs;

  // Die Stelle zählt die Lücken der Tab-Leiste, wie sie vor dem Verschieben aussieht.
  expect(order(moveTab(arrangement, a1.id, { groupId: a.id, index: 3 }))).toEqual([a2, a3, a1]);
  expect(order(moveTab(arrangement, a1.id, { groupId: a.id, index: 2 }))).toEqual([a2, a1, a3]);
  expect(order(moveTab(arrangement, a3.id, { groupId: a.id, index: 0 }))).toEqual([a3, a1, a2]);
  // Die Lücken links und rechts des Tabs selbst lassen ihn, wo er ist.
  expect(order(moveTab(arrangement, a2.id, { groupId: a.id, index: 1 }))).toEqual([a1, a2, a3]);
  expect(order(moveTab(arrangement, a2.id, { groupId: a.id, index: 2 }))).toEqual([a1, a2, a3]);

  const moved = moveTab(arrangement, a1.id, { groupId: a.id, index: 3 });
  expect(groupsOf(moved)[0].activeTab).toBe(a1.id);
  expect(moved.focusedGroup).toBe(a.id);
});

test("zieht der letzte Tab einer Gruppe um, verschwindet sie; die Nachbarn füllen den Platz", () => {
  const { arrangement, a, b, c } = threeSideBySide();
  // a 25 %, c 25 %, b 50 %

  const moved = moveTab(arrangement, c.tabs[0].id, { groupId: b.id, index: 1 });

  expect(groupsOf(moved).map((group) => group.id)).toEqual([a.id, b.id]);
  expect(groupsOf(moved)[1]).toMatchObject({
    tabs: [b.tabs[0], c.tabs[0]],
    activeTab: c.tabs[0].id,
  });
  const sizes = (moved.root as Split).sizes;
  expect(sizes[0]).toBeCloseTo(1 / 3);
  expect(sizes[1]).toBeCloseTo(2 / 3);
  expect(moved.focusedGroup).toBe(b.id);

  // Bleibt nur eine Gruppe, tritt sie an die Stelle der Teilung.
  const { arrangement: two, a: left, b1 } = twoGroups();
  const alone = moveTab(two, b1.id, { groupId: left.id, index: 0 });
  expect(alone.root).toMatchObject({ kind: "group", id: left.id });
  expect((alone.root as Group).tabs).toHaveLength(4);
});

test("am Rand einer Gruppe bildet der Tab eine neue Gruppe auf dieser Seite", () => {
  const { arrangement, a, b, a1, a2, a3, b1 } = twoGroups();

  const below = moveTab(arrangement, a2.id, { groupId: b.id, side: "down" });

  const added = groupsOf(below)[2];
  expect(added).toMatchObject({ tabs: [a2], activeTab: a2.id });
  expect(new Set(groupsOf(below).map((group) => group.id)).size).toBe(3);
  expect(below.focusedGroup).toBe(added.id);
  expect(below.root).toMatchObject({
    axis: "row",
    sizes: [0.5, 0.5],
    children: [
      { id: a.id, tabs: [a1, a3], activeTab: a3.id },
      { axis: "column", sizes: [0.5, 0.5], children: [{ id: b.id }, { id: added.id }] },
    ],
  });

  const above = moveTab(arrangement, a2.id, { groupId: b.id, side: "up" });
  expect(groupsOf(above).map((group) => group.tabs)).toEqual([[a1, a3], [a2], [b1]]);

  // In Richtung der umgebenden Teilung reiht sich die neue Gruppe ein.
  const right = moveTab(arrangement, a2.id, { groupId: b.id, side: "right" });
  expect(right.root).toMatchObject({ axis: "row", sizes: [0.5, 0.25, 0.25] });
  expect(groupsOf(right).map((group) => group.tabs)).toEqual([[a1, a3], [b1], [a2]]);

  // Auch am Rand der eigenen Gruppe.
  const left = moveTab(arrangement, a2.id, { groupId: a.id, side: "left" });
  expect(left.root).toMatchObject({ axis: "row", sizes: [0.25, 0.25, 0.5] });
  expect(groupsOf(left).map((group) => group.tabs)).toEqual([[a2], [a1, a3], [b1]]);

  // Neue Kennungen stoßen später nicht mit alten zusammen.
  const ids = [...groupsOf(openTab(below)), ...tabsOf(openTab(below))].map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("der letzte Tab einer Gruppe bildet am Rand einer anderen eine neue; die alte verschwindet", () => {
  const { arrangement, a, b, c } = threeSideBySide();

  const moved = moveTab(arrangement, c.tabs[0].id, { groupId: a.id, side: "down" });

  const added = groupsOf(moved)[1];
  expect(moved.root).toMatchObject({
    axis: "row",
    children: [{ axis: "column", children: [{ id: a.id }, { tabs: c.tabs }] }, { id: b.id }],
  });
  expect(moved.focusedGroup).toBe(added.id);
});

test("ein Tab ohne gültiges Ziel bleibt, wo er ist", () => {
  const { arrangement, a, b, b1, a1 } = twoGroups();

  expect(moveTab(arrangement, "fehlt", { groupId: b.id, index: 0 })).toBe(arrangement);
  expect(moveTab(arrangement, a1.id, { groupId: "fehlt", index: 0 })).toBe(arrangement);
  expect(moveTab(arrangement, a1.id, { groupId: "fehlt", side: "left" })).toBe(arrangement);
  // Der einzige Tab einer Gruppe kann an deren Rand keine neue Gruppe bilden.
  expect(moveTab(arrangement, b1.id, { groupId: b.id, side: "left" })).toBe(arrangement);
  // Eine Stelle jenseits der Tab-Leiste meint ihr Ende.
  const far = moveTab(arrangement, b1.id, { groupId: a.id, index: 99 });
  expect((far.root as Group).tabs.at(-1)).toEqual(b1);
});

test("ein neuer Agent öffnet sich als Tab, der als Agent erkennbar ist", () => {
  const arrangement = openTab(single, true);

  const [terminal, agent] = groupsOf(arrangement)[0].tabs;
  expect(terminal.agent).toBeUndefined();
  expect(agent.agent).toBe(true);
  expect(groupsOf(arrangement)[0].activeTab).toBe(agent.id);
});

test("der erste Tab eines Fensters kann ein Agent sein", () => {
  const arrangement = openTab(emptyArrangement, true);

  expect(tabsOf(arrangement)).toMatchObject([{ agent: true }]);
});

test("ein Agent bleibt beim Verschieben in eine andere Gruppe ein Agent", () => {
  const split = splitGroup(openTab(emptyArrangement, true), groupsOf(single)[0].id, "right");
  const [left, right] = groupsOf(split);

  const moved = moveTab(split, left.tabs[0].id, { groupId: right.id, index: 0 });

  expect(groupsOf(moved)[0].tabs[0]).toMatchObject({ id: left.tabs[0].id, agent: true });
});

test("„Terminal hier öffnen“ legt in der fokussierten Gruppe einen Tab mit eigenem Startordner an", () => {
  const before = splitGroup(single, groupsOf(single)[0].id, "right");
  const focused = groupsOf(before)[1];

  const arrangement = openTabIn(before, "C:\\Projekt\\src");

  const [untouched, group] = groupsOf(arrangement);
  expect(untouched).toEqual(groupsOf(before)[0]);
  expect(group.tabs).toHaveLength(2);
  expect(group.tabs[0]).toEqual(focused.tabs[0]);
  expect(group.tabs[1]).toEqual({ id: group.activeTab, cwd: "C:\\Projekt\\src" });
  expect(arrangement.focusedGroup).toBe(group.id);
});

test("„Agent hier starten“ öffnet den Tab als Agent, auch als ersten Tab überhaupt", () => {
  const arrangement = openTabIn(emptyArrangement, "C:\\Projekt\\docs", true);

  expect(tabsOf(arrangement)).toEqual([
    { id: groupsOf(arrangement)[0].activeTab, agent: true, cwd: "C:\\Projekt\\docs" },
  ]);
});

test("ein neues Terminal merkt sich die gewählte Shell", () => {
  const arrangement = openTab(openTab(emptyArrangement, false, "gitBash"));

  const [first, second] = tabsOf(arrangement);
  expect(first.shell).toBe("gitBash");
  expect(second.shell).toBeUndefined();
});

test("Terminals ohne gewählte Shell erhalten die Standard-Shell", () => {
  const chosen = openTab(emptyArrangement, false, "gitBash");
  const split = splitGroup(openTab(chosen), groupsOf(chosen)[0].id, "right");

  const assigned = assignShell(split, "powershell");

  expect(tabsOf(assigned).map((tab) => tab.shell)).toEqual(["gitBash", "powershell", "powershell"]);
  // Ändert sich später die Standard-Shell, behält jedes Terminal seine Shell.
  expect(assignShell(assigned, "gitBash")).toBe(assigned);
});

test("ein Terminal lässt sich umbenennen", () => {
  const two = openTab(openTab(emptyArrangement));
  const [first, second] = tabsOf(two);

  const renamed = renameTab(two, second.id, "  Agent Suche ");

  expect(tabsOf(renamed)).toEqual([first, { ...second, name: "Agent Suche" }]);
});

test("ein leerer Name stellt den Standardnamen wieder her", () => {
  const named = renameTab(single, tabsOf(single)[0].id, "Build");

  const reset = renameTab(named, tabsOf(named)[0].id, "   ");

  expect(tabsOf(reset)[0].name).toBeUndefined();
});

test("umbenennen eines unbekannten Tabs ändert nichts", () => {
  expect(renameTab(single, "gibt-es-nicht", "Name")).toBe(single);
});

test("der Name wandert beim Verschieben mit dem Tab", () => {
  const split = splitGroup(single, groupsOf(single)[0].id, "right");
  const [left, right] = groupsOf(split);
  const named = renameTab(split, left.tabs[0].id, "Agent");

  const moved = moveTab(named, left.tabs[0].id, { groupId: right.id, index: 1 });

  expect(tabsOf(moved).map((tab) => tab.name)).toEqual([undefined, "Agent"]);
});
