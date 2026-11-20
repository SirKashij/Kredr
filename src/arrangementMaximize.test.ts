import { expect, test } from "vitest";
import {
  activateTab,
  closeTab,
  emptyArrangement,
  filePathOf,
  focusedGroupOf,
  focusGroupAt,
  groupsOf,
  maximizedGroupOf,
  maximizeTab,
  openContent,
  openTab,
  restoreGroups,
  showVersionControl,
  splitGroup,
  tabsOf,
  type Arrangement,
  type Tab,
} from "./arrangement";

/** Zwei Gruppen mit je einem Terminal; die rechte hat den Fokus. */
const single = openTab(emptyArrangement);
const two = splitGroup(single, groupsOf(single)[0].id, "right");

function versionControlTabs(arrangement: Arrangement): Tab[] {
  return tabsOf(arrangement).filter((tab) => tab.content?.kind === "versionControl");
}

test("die Versionskontrolle öffnet sich als Tab der fokussierten Gruppe und ist maximiert", () => {
  const arrangement = showVersionControl(two, false);

  const [tab] = versionControlTabs(arrangement);
  const group = focusedGroupOf(arrangement)!;
  expect(group.id).toBe(groupsOf(two)[1].id);
  expect(group.activeTab).toBe(tab.id);
  expect(maximizedGroupOf(arrangement)).toBe(group);
});

test("es gibt nur einen Tab der Versionskontrolle", () => {
  const opened = showVersionControl(two, false);
  const elsewhere = focusGroupAt(opened, 0);

  const arrangement = showVersionControl(elsewhere, false);

  expect(versionControlTabs(arrangement)).toHaveLength(1);
  expect(focusedGroupOf(arrangement)!.activeTab).toBe(versionControlTabs(arrangement)[0].id);
});

test("„Terminals einblenden“ zeigt wieder alle Gruppen und lässt den Tab offen", () => {
  const arrangement = restoreGroups(showVersionControl(two, false));

  expect(maximizedGroupOf(arrangement)).toBeNull();
  expect(versionControlTabs(arrangement)).toHaveLength(1);
  expect(groupsOf(arrangement)).toHaveLength(2);
});

test("ein Klick auf eine Änderung zeigt den Tab, ohne ihn erneut zu maximieren", () => {
  const restored = restoreGroups(showVersionControl(two, false));
  const elsewhere = focusGroupAt(restored, 0);

  const arrangement = showVersionControl(elsewhere, false);

  expect(maximizedGroupOf(arrangement)).toBeNull();
  expect(focusedGroupOf(arrangement)!.activeTab).toBe(versionControlTabs(arrangement)[0].id);
});

test("das Symbol der Versionskontrolle maximiert den Tab erneut", () => {
  const restored = restoreGroups(showVersionControl(two, false));

  const arrangement = showVersionControl(restored, true);

  expect(maximizedGroupOf(arrangement)).toBe(focusedGroupOf(arrangement));
});

test("ein Tab lässt sich von Hand maximieren", () => {
  const restored = restoreGroups(showVersionControl(two, false));
  const [tab] = versionControlTabs(restored);

  const arrangement = maximizeTab(focusGroupAt(restored, 0), tab.id);

  expect(maximizedGroupOf(arrangement)?.activeTab).toBe(tab.id);
  expect(arrangement.focusedGroup).toBe(maximizedGroupOf(arrangement)!.id);
});

test("ein unbekannter Tab lässt sich nicht maximieren", () => {
  expect(maximizeTab(two, "gibt-es-nicht")).toBe(two);
});

test("wer ein Terminal einer anderen Gruppe nach vorn holt, sieht wieder alle Gruppen", () => {
  const maximized = showVersionControl(two, false);
  const terminal = groupsOf(maximized)[0].tabs[0];

  const arrangement = activateTab(maximized, terminal.id);

  expect(maximizedGroupOf(arrangement)).toBeNull();
  // Zurück beim Tab der Versionskontrolle verdeckt er die Terminals wieder.
  const back = activateTab(arrangement, versionControlTabs(arrangement)[0].id);
  expect(maximizedGroupOf(back)).toBe(focusedGroupOf(back));
});

test("ein anderer Tab derselben Gruppe verdeckt die übrigen Gruppen nicht", () => {
  const maximized = showVersionControl(two, false);

  const arrangement = openTab(maximized);

  expect(maximizedGroupOf(arrangement)).toBeNull();
});

test("mit dem Schließen des Tabs endet das Maximieren", () => {
  const maximized = showVersionControl(two, false);

  const arrangement = closeTab(maximized, versionControlTabs(maximized)[0].id);

  expect(arrangement.maximized).toBeUndefined();
  expect(maximizedGroupOf(arrangement)).toBeNull();
  expect(groupsOf(arrangement)).toHaveLength(2);
});

test("eine Datei und die Versionskontrolle sind verschiedene Inhalte", () => {
  const arrangement = openContent(showVersionControl(single, false), {
    kind: "file",
    path: "a.ts",
  });

  expect(tabsOf(arrangement).map(filePathOf)).toEqual([undefined, undefined, "a.ts"]);
});
