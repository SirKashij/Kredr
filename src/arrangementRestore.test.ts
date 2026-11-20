import { expect, test } from "vitest";
import {
  emptyArrangement,
  focusedGroupOf,
  groupsOf,
  moveDivider,
  openContent,
  openTab,
  openTabIn,
  renameTab,
  restoreArrangement,
  splitGroup,
  tabsOf,
  type Arrangement,
  type Split,
} from "./arrangement";

/** Speichern und Laden: der Weg über JSON, wie ihn der Aufteilungsspeicher geht. */
function stored(arrangement: unknown): unknown {
  return JSON.parse(JSON.stringify(arrangement));
}

/** Zwei Gruppen nebeneinander, links ein benanntes Terminal und eine Dateiansicht. */
function worked(): Arrangement {
  let arrangement = openTab(emptyArrangement, false, "gitBash");
  arrangement = renameTab(arrangement, tabsOf(arrangement)[0].id, "Server");
  arrangement = openContent(arrangement, { kind: "file", path: "src/App.tsx" });
  arrangement = splitGroup(arrangement, groupsOf(arrangement)[0].id, "right");
  arrangement = openTabIn(arrangement, "C:\\Projekt\\src");
  return moveDivider(arrangement, (arrangement.root as Split).id, 0, 0.3);
}

test("eine gespeicherte Aufteilung kommt mit Gruppen, Größen, Tabs und Reihenfolge zurück", () => {
  const arrangement = worked();

  expect(restoreArrangement(stored(arrangement))).toEqual(arrangement);
});

test("wiederhergestellte Terminals behalten Namen, Shell und Startordner", () => {
  const restored = restoreArrangement(stored(worked()));

  const [server, , , inFolder] = tabsOf(restored);
  expect(server).toMatchObject({ name: "Server", shell: "gitBash" });
  expect(inFolder.cwd).toBe("C:\\Projekt\\src");
});

test("ein Terminal mit Agent kommt als gewöhnliches Terminal zurück", () => {
  const withAgent = renameTab(openTab(emptyArrangement, true), "t1", "Prüfer");

  const [tab] = tabsOf(restoreArrangement(stored(withAgent)));

  expect(tab).toEqual({ id: "t1", name: "Prüfer" });
});

test("ein Vorschau-Tab bleibt ein Vorschau-Tab", () => {
  const preview = openContent(emptyArrangement, { kind: "file", path: "a.ts" }, true);

  expect(tabsOf(restoreArrangement(stored(preview)))[0].preview).toBe(true);
});

test("Dateiansichten nicht mehr vorhandener Dateien fehlen, alles andere bleibt", () => {
  let arrangement = openTab(emptyArrangement);
  arrangement = openContent(arrangement, { kind: "file", path: "weg.ts" });
  arrangement = openContent(arrangement, { kind: "file", path: "da.ts" });

  const restored = restoreArrangement(stored(arrangement), (path) => path !== "weg.ts");

  expect(tabsOf(restored).map((tab) => tab.content?.path)).toEqual([undefined, "da.ts"]);
});

test("fehlt der sichtbare Tab, rückt sein rechter Nachbar nach, sonst der linke", () => {
  let arrangement = openTab(emptyArrangement);
  arrangement = openContent(arrangement, { kind: "file", path: "weg.ts" });
  const terminalOnly = restoreArrangement(stored(arrangement), () => false);
  expect(groupsOf(terminalOnly)[0].activeTab).toBe("t1");

  arrangement = openTab(openContent(arrangement, { kind: "file", path: "weg.ts" }));
  const [group] = groupsOf(arrangement);
  const fileVisible = { ...arrangement, root: { ...group, activeTab: group.tabs[1].id } };
  const restored = restoreArrangement(stored(fileVisible), () => false);
  expect(groupsOf(restored)[0].activeTab).toBe(group.tabs[2].id);
});

test("eine Gruppe, deren Tabs alle fehlen, verschwindet; ihr Platz und der Fokus gehen an die übrigen", () => {
  let arrangement = openTab(emptyArrangement);
  arrangement = splitGroup(arrangement, groupsOf(arrangement)[0].id, "right");
  const added = focusedGroupOf(arrangement)!;
  // Die neue Gruppe zeigt nur noch eine Datei, die es nicht mehr gibt.
  arrangement = openContent(arrangement, { kind: "file", path: "weg.ts" });
  const split = arrangement.root as Split;
  const onlyFile: Arrangement = {
    ...arrangement,
    root: {
      ...split,
      children: [
        split.children[0],
        {
          ...added,
          tabs: [tabsOf(arrangement).at(-1)!],
          activeTab: tabsOf(arrangement).at(-1)!.id,
        },
      ],
    },
  };

  const restored = restoreArrangement(stored(onlyFile), () => false);

  expect(restored.root).toEqual(split.children[0]);
  expect(restored.focusedGroup).toBe(groupsOf(restored)[0].id);
});

test("ein Startordner, den es nicht mehr gibt, entfällt; das Terminal bleibt", () => {
  const arrangement = openTabIn(emptyArrangement, "C:\\Projekt\\weg");

  const [tab] = tabsOf(restoreArrangement(stored(arrangement), () => false));

  expect(tab).toEqual({ id: "t1" });
});

test("Tabs unbekannter Art fehlen, ohne die übrige Aufteilung zu verwerfen", () => {
  const arrangement = openContent(openTab(emptyArrangement), { kind: "file", path: "a.ts" });
  const raw = stored(arrangement) as { root: { tabs: { content?: unknown }[] } };
  raw.root.tabs[1].content = { kind: "hologramm", path: "a.ts" };

  const restored = restoreArrangement(raw);

  expect(tabsOf(restored)).toEqual([{ id: "t1" }]);
});

test("neue Tabs einer wiederhergestellten Aufteilung erhalten unverbrauchte Kennungen", () => {
  const raw = stored(worked()) as { nextId: unknown };
  raw.nextId = "kaputt";

  const restored = openTab(restoreArrangement(raw));

  const ids = [...tabsOf(restored), ...groupsOf(restored)].map((item) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("unbrauchbare Größen einer Teilung werden gleichmäßig verteilt", () => {
  const raw = stored(worked()) as { root: { sizes: unknown } };
  raw.root.sizes = [1, "viel"];

  expect((restoreArrangement(raw).root as Split).sizes).toEqual([0.5, 0.5]);
});

test.each([
  ["nichts", null],
  ["Text", "kaputt"],
  ["eine veraltete Version", { ...worked(), version: 0 }],
  ["eine spätere Version", { ...worked(), version: 2 }],
  ["ein Baum ohne Tabs", { ...worked(), root: { kind: "group", id: "g1" } }],
  ["ein unbekannter Knoten", { ...worked(), root: { kind: "stapel", id: "g1" } }],
  [
    "doppelte Kennungen",
    {
      ...worked(),
      root: { kind: "group", id: "g1", tabs: [{ id: "t1" }, { id: "t1" }], activeTab: "t1" },
    },
  ],
])("%s ergibt die leere Aufteilung", (_, raw) => {
  expect(restoreArrangement(stored(raw))).toEqual(emptyArrangement);
});
