import { expect, test } from "vitest";
import {
  closesFileText,
  focusedGroupOf,
  groupsOf,
  holdsFileText,
  openContent,
  openContentBeside,
  openTab,
  emptyArrangement,
  restoreArrangement,
  showInTab,
  tabsOf,
  type Arrangement,
  type Tab,
  type TabContent,
} from "./arrangement";

const source: TabContent = { kind: "file", path: "README.md" };
const rendered: TabContent = { kind: "markdown", path: "README.md" };

/** Eine Gruppe mit einem Terminal und der Dateiansicht von README.md. */
const withSource = openContent(openTab(emptyArrangement), source);

function activeTabOf(arrangement: Arrangement): Tab {
  const group = focusedGroupOf(arrangement)!;
  return group.tabs.find((tab) => tab.id === group.activeTab)!;
}

test("die Markdown-Vorschau einer Datei ist ein anderer Inhalt als ihre Dateiansicht", () => {
  const arrangement = openContent(withSource, rendered);

  expect(tabsOf(arrangement).map((tab) => tab.content?.kind)).toEqual([
    undefined,
    "file",
    "markdown",
  ]);
});

test("ein Tab schaltet an Ort und Stelle von Quelltext auf Vorschau und zurück", () => {
  const tab = activeTabOf(withSource);

  const preview = showInTab(withSource, tab.id, rendered);

  expect(tabsOf(preview)).toHaveLength(2);
  expect(activeTabOf(preview)).toEqual({ id: tab.id, content: rendered });
  expect(showInTab(preview, tab.id, source)).toEqual(withSource);
});

test("beim Umschalten bleibt ein Vorschau-Tab ein Vorschau-Tab", () => {
  const browsing = openContent(openTab(emptyArrangement), source, true);
  const tab = activeTabOf(browsing);

  const preview = showInTab(browsing, tab.id, rendered);

  expect(activeTabOf(preview)).toEqual({ id: tab.id, content: rendered, preview: true });
});

test("ist das Ziel des Umschaltens schon offen, wird jener Tab angezeigt", () => {
  const both = openContentBeside(withSource, rendered);
  const sourceTab = tabsOf(both).find((tab) => tab.content?.kind === "file")!;
  const previewTab = tabsOf(both).find((tab) => tab.content?.kind === "markdown")!;

  const arrangement = showInTab(both, sourceTab.id, rendered);

  expect(tabsOf(arrangement)).toEqual(tabsOf(both));
  expect(activeTabOf(arrangement).id).toBe(previewTab.id);
});

test("daneben öffnen legt rechts eine neue Gruppe an und lässt die Tastatur beim Quelltext", () => {
  const sourceTab = activeTabOf(withSource);

  const arrangement = openContentBeside(withSource, rendered);

  const [left, right] = groupsOf(arrangement);
  expect(arrangement.root).toMatchObject({ kind: "split", axis: "row", sizes: [0.5, 0.5] });
  expect(left.tabs).toEqual(groupsOf(withSource)[0].tabs);
  expect(left.activeTab).toBe(sourceTab.id);
  expect(right.tabs.map((tab) => tab.content)).toEqual([rendered]);
  expect(arrangement.focusedGroup).toBe(left.id);
});

test("daneben öffnen zeigt einen schon offenen Inhalt, statt ihn doppelt zu öffnen", () => {
  const once = openContentBeside(withSource, rendered);

  const twice = openContentBeside(once, rendered);

  expect(groupsOf(twice)).toHaveLength(2);
  expect(tabsOf(twice)).toEqual(tabsOf(once));
  expect(activeTabOf(twice).content).toEqual(rendered);
});

test("den Text einer Datei halten ihre Dateiansicht und ihre Markdown-Vorschau, ein Bild nicht", () => {
  expect(holdsFileText(source)).toBe(true);
  expect(holdsFileText(rendered)).toBe(true);
  expect(holdsFileText({ kind: "image", path: "logo.svg" })).toBe(false);
});

test("den Text einer Datei schließt erst der letzte Tab, der ihn hält", () => {
  const both = openContentBeside(withSource, rendered);
  const sourceTab = tabsOf(both).find((tab) => tab.content?.kind === "file")!;
  const previewTab = tabsOf(both).find((tab) => tab.content?.kind === "markdown")!;
  const terminal = tabsOf(both).find((tab) => !tab.content)!;

  expect(closesFileText(both, sourceTab.id)).toBe(false);
  expect(closesFileText(both, previewTab.id)).toBe(false);
  expect(closesFileText(withSource, sourceTab.id)).toBe(true);
  expect(closesFileText(showInTab(withSource, sourceTab.id, rendered), sourceTab.id)).toBe(true);
  expect(closesFileText(both, terminal.id)).toBe(false);
});

test("ein Bild schließt ohne Rückfrage, auch neben seinem Quelltext", () => {
  const picture: TabContent = { kind: "image", path: "logo.svg" };
  const svgSource: TabContent = { kind: "file", path: "LOGO.svg" };
  const both = openContent(openContent(emptyArrangement, picture), svgSource);
  const [pictureTab, sourceTab] = tabsOf(both);

  expect(closesFileText(both, pictureTab.id)).toBe(false);
  expect(closesFileText(both, sourceTab.id)).toBe(true);
});

test("Markdown-Vorschau und Bild überdauern das Speichern und Laden der Aufteilung", () => {
  const picture: TabContent = { kind: "image", path: "docs/logo.png" };
  const arrangement = openContent(openContentBeside(withSource, rendered), picture);

  const restored = restoreArrangement(JSON.parse(JSON.stringify(arrangement)));

  expect(restored).toEqual(arrangement);
});

test("Vorschau und Bild einer nicht mehr vorhandenen Datei fehlen nach dem Laden", () => {
  const picture: TabContent = { kind: "image", path: "docs/logo.png" };
  const arrangement = openContent(openContent(withSource, rendered), picture);

  const restored = restoreArrangement(JSON.parse(JSON.stringify(arrangement)), () => false);

  expect(tabsOf(restored).map((tab) => tab.content)).toEqual([undefined]);
});

test("eine gespeicherte Tab-Art, die es nicht gibt, fällt beim Laden weg", () => {
  const stored = JSON.parse(JSON.stringify(withSource).replace('"file"', '"hologramm"'));

  expect(tabsOf(restoreArrangement(stored)).map((tab) => tab.content)).toEqual([undefined]);
});
