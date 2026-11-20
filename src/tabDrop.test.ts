import { expect, test } from "vitest";
import { dropAt, type GroupRects } from "./tabDrop";

/** Zwei Gruppen nebeneinander, je 400 breit: links g1 mit t1 und t2, rechts g2 mit t3. */
const groups: GroupRects[] = [
  {
    id: "g1",
    bar: { left: 0, top: 0, right: 400, bottom: 35 },
    body: { left: 0, top: 35, right: 400, bottom: 435 },
    tabs: [
      { id: "t1", rect: { left: 0, top: 0, right: 100, bottom: 35 } },
      { id: "t2", rect: { left: 100, top: 0, right: 200, bottom: 35 } },
    ],
  },
  {
    id: "g2",
    bar: { left: 401, top: 0, right: 801, bottom: 35 },
    body: { left: 401, top: 35, right: 801, bottom: 435 },
    tabs: [{ id: "t3", rect: { left: 401, top: 0, right: 501, bottom: 35 } }],
  },
];

test("über einer Tab-Leiste landet der Tab in der Lücke neben dem Zeiger", () => {
  // Rechte Hälfte von t1: die Lücke zwischen t1 und t2.
  expect(dropAt(70, 10, "t3", groups)).toEqual({
    target: { groupId: "g1", index: 1 },
    marker: { left: 99, top: 0, right: 101, bottom: 35 },
  });
  // Linke Hälfte von t1: vor dem ersten Tab; die Markierung bleibt in der Leiste.
  expect(dropAt(20, 10, "t3", groups)).toEqual({
    target: { groupId: "g1", index: 0 },
    marker: { left: 0, top: 0, right: 2, bottom: 35 },
  });
  // Im freien Teil der Leiste: hinter dem letzten Tab.
  expect(dropAt(350, 10, "t3", groups)).toEqual({
    target: { groupId: "g1", index: 2 },
    marker: { left: 199, top: 0, right: 201, bottom: 35 },
  });
  // Auch in der eigenen Gruppe, zum Umsortieren.
  expect(dropAt(350, 10, "t1", groups)?.target).toEqual({ groupId: "g1", index: 2 });
});

test("in der Mitte einer anderen Gruppe reiht sich der Tab hinten ein", () => {
  expect(dropAt(600, 235, "t1", groups)).toEqual({
    target: { groupId: "g2", index: 1 },
    marker: { left: 401, top: 35, right: 801, bottom: 435 },
  });
});

test("am Rand einer Gruppe entsteht dort eine neue; die Markierung zeigt ihre Hälfte", () => {
  expect(dropAt(410, 235, "t1", groups)).toEqual({
    target: { groupId: "g2", side: "left" },
    marker: { left: 401, top: 35, right: 601, bottom: 435 },
  });
  expect(dropAt(790, 235, "t1", groups)).toEqual({
    target: { groupId: "g2", side: "right" },
    marker: { left: 601, top: 35, right: 801, bottom: 435 },
  });
  expect(dropAt(600, 50, "t1", groups)).toEqual({
    target: { groupId: "g2", side: "up" },
    marker: { left: 401, top: 35, right: 801, bottom: 235 },
  });
  expect(dropAt(600, 430, "t1", groups)).toEqual({
    target: { groupId: "g2", side: "down" },
    marker: { left: 401, top: 235, right: 801, bottom: 435 },
  });
  // In einer Ecke gewinnt der nähere Rand.
  expect(dropAt(405, 100, "t1", groups)?.target).toEqual({ groupId: "g2", side: "left" });
  // Auch am Rand der eigenen Gruppe, solange sie weitere Tabs hat.
  expect(dropAt(390, 235, "t1", groups)?.target).toEqual({ groupId: "g1", side: "right" });
});

test("wo das Ablegen nichts ändern würde, gibt es kein Ziel", () => {
  // Außerhalb aller Gruppen.
  expect(dropAt(900, 235, "t1", groups)).toBeNull();
  expect(dropAt(400.5, 235, "t1", groups)).toBeNull();
  // Die Lücken links und rechts des Tabs selbst.
  expect(dropAt(20, 10, "t1", groups)).toBeNull();
  expect(dropAt(70, 10, "t1", groups)).toBeNull();
  expect(dropAt(120, 10, "t2", groups)).toBeNull();
  expect(dropAt(350, 10, "t2", groups)).toBeNull();
  // Die Mitte der eigenen Gruppe.
  expect(dropAt(200, 235, "t1", groups)).toBeNull();
  // Der Rand der eigenen Gruppe, wenn der Tab ihr einziger ist.
  expect(dropAt(410, 235, "t3", groups)).toBeNull();
});
