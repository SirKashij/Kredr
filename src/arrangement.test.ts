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
  openTab,
  splitGroup,
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
