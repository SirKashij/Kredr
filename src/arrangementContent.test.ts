import { expect, test } from "vitest";
import {
  closeTab,
  emptyArrangement,
  focusedGroupOf,
  groupsOf,
  isTerminal,
  keepTab,
  moveTab,
  openContent,
  openTab,
  splitGroup,
  tabsOf,
  type Arrangement,
  type Tab,
  type TabContent,
} from "./arrangement";

const file = (path: string): TabContent => ({ kind: "file", path });

/** Eine Gruppe mit einem Terminal. */
const single = openTab(emptyArrangement);

function activeTabOf(arrangement: Arrangement): Tab {
  const group = focusedGroupOf(arrangement)!;
  return group.tabs.find((tab) => tab.id === group.activeTab)!;
}

test("eine Datei öffnet sich als sichtbarer Tab rechts neben dem sichtbaren Tab", () => {
  const two = openTab(single);
  const [first, second] = groupsOf(two)[0].tabs;
  const firstVisible = moveTab(two, first.id, { groupId: groupsOf(two)[0].id, index: 0 });

  const arrangement = openContent(firstVisible, file("src/App.tsx"));

  const [group] = groupsOf(arrangement);
  expect(group.tabs.map((tab) => tab.id)).toEqual([first.id, group.activeTab, second.id]);
  expect(activeTabOf(arrangement).content).toEqual(file("src/App.tsx"));
  expect(new Set(group.tabs.map((tab) => tab.id)).size).toBe(3);
});

test("ohne Gruppen entsteht für die Datei die erste Gruppe", () => {
  const arrangement = openContent(emptyArrangement, file("README.md"));

  const groups = groupsOf(arrangement);
  expect(groups).toHaveLength(1);
  expect(groups[0].tabs).toHaveLength(1);
  expect(arrangement.focusedGroup).toBe(groups[0].id);
  expect(activeTabOf(arrangement).content).toEqual(file("README.md"));
  // Danach vergebene Kennungen stoßen nicht mit den vorhandenen zusammen.
  const ids = [...tabsOf(openTab(arrangement)).map((tab) => tab.id), groups[0].id];
  expect(new Set(ids).size).toBe(3);
});

test("eine dauerhaft geöffnete Datei ist kein Vorschau-Tab", () => {
  const arrangement = openContent(single, file("a.ts"));

  expect(activeTabOf(arrangement).preview).toBeUndefined();
});

test("ein Vorschau-Tab wird von der nächsten Vorschau ersetzt", () => {
  const first = openContent(single, file("a.ts"), true);
  expect(activeTabOf(first).preview).toBe(true);

  const second = openContent(first, file("b.ts"), true);

  const files = tabsOf(second).filter((tab) => tab.content);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ content: file("b.ts"), preview: true });
  expect(activeTabOf(second)).toBe(files[0]);
});

test("ein dauerhafter Tab wird von einer Vorschau nicht ersetzt", () => {
  const kept = openContent(single, file("a.ts"));

  const arrangement = openContent(kept, file("b.ts"), true);

  expect(tabsOf(arrangement).map((tab) => tab.content?.path)).toEqual([undefined, "a.ts", "b.ts"]);
});

test("dauerhaft öffnen ersetzt den Vorschau-Tab nicht", () => {
  const preview = openContent(single, file("a.ts"), true);

  const arrangement = openContent(preview, file("b.ts"));

  const paths = tabsOf(arrangement).map((tab) => tab.content?.path);
  expect(paths).toContain("a.ts");
  expect(paths).toContain("b.ts");
});

test("eine bereits offene Datei wird angezeigt statt doppelt geöffnet", () => {
  const withFile = openContent(single, file("a.ts"));
  const fileTab = activeTabOf(withFile);
  const split = splitGroup(withFile, groupsOf(withFile)[0].id, "right");
  expect(activeTabOf(split).id).not.toBe(fileTab.id);

  const arrangement = openContent(split, file("a.ts"), true);

  expect(tabsOf(arrangement).filter((tab) => tab.content)).toHaveLength(1);
  expect(activeTabOf(arrangement).id).toBe(fileTab.id);
  // Die Vorschau einer dauerhaft offenen Datei macht sie nicht zur Vorschau.
  expect(activeTabOf(arrangement).preview).toBeUndefined();
});

test("Groß- und Kleinschreibung des Pfads unterscheidet unter Windows keine Dateien", () => {
  const withFile = openContent(single, file("src/App.tsx"));

  const arrangement = openContent(withFile, file("SRC/app.tsx"));

  expect(tabsOf(arrangement).filter((tab) => tab.content)).toHaveLength(1);
});

test("dauerhaft öffnen macht aus dem Vorschau-Tab derselben Datei einen dauerhaften", () => {
  const preview = openContent(single, file("a.ts"), true);

  const arrangement = openContent(preview, file("a.ts"));

  expect(tabsOf(arrangement).filter((tab) => tab.content)).toHaveLength(1);
  expect(activeTabOf(arrangement).preview).toBeUndefined();
});

test("ein Vorschau-Tab lässt sich dauerhaft machen", () => {
  const preview = openContent(single, file("a.ts"), true);
  const tab = activeTabOf(preview);

  const kept = keepTab(preview, tab.id);

  expect(activeTabOf(kept)).toEqual({ id: tab.id, content: file("a.ts") });
  const arrangement = openContent(kept, file("b.ts"), true);
  expect(tabsOf(arrangement).filter((tab) => tab.content)).toHaveLength(2);
  // Ein dauerhafter Tab bleibt unverändert.
  expect(keepTab(kept, tab.id)).toBe(kept);
});

test("jede Gruppe ersetzt nur ihren eigenen Vorschau-Tab", () => {
  const left = openContent(single, file("a.ts"), true);
  const split = splitGroup(left, groupsOf(left)[0].id, "right");

  const arrangement = openContent(split, file("b.ts"), true);

  const [first, second] = groupsOf(arrangement);
  expect(first.tabs.map((tab) => tab.content?.path)).toContain("a.ts");
  expect(second.tabs.map((tab) => tab.content?.path)).toContain("b.ts");
});

test("Dateiansichten lassen sich wie Terminals verschieben und schließen", () => {
  const withFile = openContent(single, file("a.ts"));
  const tab = activeTabOf(withFile);
  const [group] = groupsOf(withFile);

  const moved = moveTab(withFile, tab.id, { groupId: group.id, side: "right" });

  const [left, right] = groupsOf(moved);
  expect(left.tabs.every(isTerminal)).toBe(true);
  expect(right.tabs).toEqual([tab]);
  expect(groupsOf(closeTab(moved, tab.id))).toHaveLength(1);
});

test("nur Tabs ohne eigenen Inhalt sind Terminals", () => {
  const arrangement = openContent(single, file("a.ts"));

  expect(tabsOf(arrangement).map(isTerminal)).toEqual([true, false]);
});

test("die Aufteilung mit Dateiansichten übersteht Speichern und Laden als JSON", () => {
  const arrangement = openContent(openContent(single, file("a.ts")), file("b.ts"), true);

  expect(JSON.parse(JSON.stringify(arrangement))).toEqual(arrangement);
});
