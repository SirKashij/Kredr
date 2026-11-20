/**
 * Die Aufteilung des Hauptbereichs als reines Zustandsmodell: ein Baum aus
 * Teilungen und Gruppen, jede Gruppe mit ihren Tabs. Jede Operation liefert
 * eine neue Aufteilung und lässt die alte unverändert. Der Zustand besteht
 * nur aus einfachen Daten und lässt sich deshalb als JSON speichern.
 */

import type { Shell } from "./settingsStore";

export interface Tab {
  id: string;
  /** Der selbst vergebene Name; ohne ihn heißt das Terminal wie seine Shell. */
  name?: string;
  /** Die Shell des Terminals; fehlt nur, bis `assignShell` die Standard-Shell einträgt. */
  shell?: Shell;
  /** Gesetzt, wenn in diesem Terminal ein Agent gestartet wurde. */
  agent?: true;
  /** Der Startordner des Terminals, wenn es nicht im Projektordner startet. */
  cwd?: string;
  /** Was der Tab zeigt; fehlt bei einem Terminal. */
  content?: TabContent;
  /** Gesetzt bei einem Vorschau-Tab: Die nächste Vorschau seiner Gruppe ersetzt ihn. */
  preview?: true;
}

/**
 * Der Inhalt eines Tabs, der kein Terminal ist. Jede weitere Tab-Art (Diff,
 * Versionskontrolle, Bild …) ist ein weiterer Fall mit eigenem `kind`.
 */
export type TabContent = {
  /** Eine Dateiansicht. */
  kind: "file";
  /** Relativ zum Projektordner und mit `/` getrennt; außerhalb des Projekts der volle Pfad. */
  path: string;
};

/** Ob der Tab ein Terminal ist (gewöhnlich oder mit Agent). */
export function isTerminal(tab: Tab): boolean {
  return !tab.content;
}

/** Ob beide dasselbe zeigen; ein Inhalt ist im Hauptbereich nur einmal offen. */
export function sameContent(a: TabContent, b: TabContent): boolean {
  // Windows unterscheidet bei Pfaden keine Groß- und Kleinschreibung.
  return a.kind === b.kind && a.path.toLowerCase() === b.path.toLowerCase();
}

/** Eine Gruppe: ein Teilstück des Hauptbereichs mit eigener Tab-Leiste. */
export interface Group {
  kind: "group";
  id: string;
  /** Nie leer; eine Gruppe ohne Tabs verschwindet. */
  tabs: Tab[];
  /** Kennung des sichtbaren Tabs. */
  activeTab: string;
}

/** Eine Teilung: mindestens zwei Teilstücke neben- oder untereinander. */
export interface Split {
  kind: "split";
  id: string;
  /** `row`: nebeneinander, `column`: untereinander. */
  axis: "row" | "column";
  children: TreeNode[];
  /** Anteil jedes Teilstücks an der Teilung; zusammen 1. */
  sizes: number[];
}

export type TreeNode = Group | Split;

export interface Arrangement {
  /** Version des gespeicherten Formats. */
  version: 1;
  /** `null`, solange kein Tab offen ist. */
  root: TreeNode | null;
  /** Die Gruppe, die Tastatureingaben erhält. */
  focusedGroup: string | null;
  /** Zähler für die nächste vergebene Kennung. */
  nextId: number;
}

export const emptyArrangement: Arrangement = {
  version: 1,
  root: null,
  focusedGroup: null,
  nextId: 1,
};

/** Alle Gruppen in Lesereihenfolge: von links nach rechts, von oben nach unten. */
export function groupsOf(arrangement: Arrangement): Group[] {
  const groups: Group[] = [];
  const collect = (node: TreeNode) => {
    if (node.kind === "group") groups.push(node);
    else node.children.forEach(collect);
  };
  if (arrangement.root) collect(arrangement.root);
  return groups;
}

/** Alle Tabs in der Reihenfolge ihrer Gruppen. */
export function tabsOf(arrangement: Arrangement): Tab[] {
  return groupsOf(arrangement).flatMap((group) => group.tabs);
}

function groupOfTab(arrangement: Arrangement, tabId: string): Group | undefined {
  return groupsOf(arrangement).find((group) => group.tabs.some((tab) => tab.id === tabId));
}

function newTab(nextId: number, agent: boolean, shell?: Shell): Tab {
  const tab: Tab = { id: `t${nextId}` };
  if (agent) tab.agent = true;
  if (shell) tab.shell = shell;
  return tab;
}

/** Eine neue Gruppe mit einem neuen Tab; sie verbraucht zwei Kennungen. */
function newGroup(nextId: number, agent = false, shell?: Shell): Group {
  const tab = newTab(nextId, agent, shell);
  return { kind: "group", id: `g${nextId + 1}`, tabs: [tab], activeTab: tab.id };
}

/**
 * Öffnet einen neuen Tab in der fokussierten Gruppe und zeigt ihn an. Ohne
 * Gruppen entsteht die erste; hat keine Gruppe den Fokus, nimmt ihn die erste.
 * Mit `agent` ist es ein Terminal, in dem ein Agent startet; mit `shell`
 * läuft darin diese Shell statt der Standard-Shell.
 */
export function openTab(arrangement: Arrangement, agent = false, shell?: Shell): Arrangement {
  const { root, nextId } = arrangement;
  if (!root) {
    const group = newGroup(nextId, agent, shell);
    return { ...arrangement, root: group, focusedGroup: group.id, nextId: nextId + 2 };
  }
  const target = focusedGroupOf(arrangement) ?? groupsOf(arrangement)[0];
  const tab = newTab(nextId, agent, shell);
  return {
    ...arrangement,
    root: replaceGroup(root, target.id, (group) => ({
      ...group,
      tabs: [...group.tabs, tab],
      activeTab: tab.id,
    })),
    focusedGroup: target.id,
    nextId: nextId + 1,
  };
}

/**
 * Öffnet wie `openTab` einen neuen Tab, dessen Terminal aber im Ordner `cwd`
 * startet („Terminal hier öffnen“, „Agent hier starten“).
 */
export function openTabIn(arrangement: Arrangement, cwd: string, agent = false): Arrangement {
  const opened = openTab(arrangement, agent);
  const target = focusedGroupOf(opened);
  if (!opened.root || !target) return opened;
  const root = replaceGroup(opened.root, target.id, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) => (tab.id === group.activeTab ? { ...tab, cwd } : tab)),
  }));
  return { ...opened, root };
}

/**
 * Teilt die Gruppe: rechts von ihr oder unter ihr entsteht eine neue Gruppe
 * mit einem neuen Tab, die die Hälfte ihres Platzes übernimmt und den Fokus erhält.
 */
export function splitGroup(
  arrangement: Arrangement,
  groupId: string,
  direction: "right" | "down",
): Arrangement {
  if (!arrangement.root || !groupsOf(arrangement).some((group) => group.id === groupId)) {
    return arrangement;
  }
  const { nextId } = arrangement;
  const added = newGroup(nextId);
  const root = replaceGroup(arrangement.root, groupId, (group) => ({
    kind: "split",
    id: `s${nextId + 2}`,
    axis: direction === "right" ? "row" : "column",
    children: [group, added],
    sizes: [0.5, 0.5],
  }));
  return { ...arrangement, root: tidy(root), focusedGroup: added.id, nextId: nextId + 3 };
}

/** Schließt den Tab. War er sichtbar, rückt sein rechter Nachbar nach, sonst der linke. */
export function closeTab(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  const root = tidy(replaceGroup(arrangement.root, group.id, () => withoutTab(group, tabId)));
  if (group.tabs.length > 1 || arrangement.focusedGroup !== group.id) {
    return { ...arrangement, root };
  }

  // Die fokussierte Gruppe ist verschwunden: Der Fokus geht an die Gruppe
  // davor, sonst an die danach.
  const before = groupsOf(arrangement);
  const position = before.indexOf(group);
  const heir = before[position - 1] ?? before[position + 1];
  return { ...arrangement, root, focusedGroup: heir?.id ?? null };
}

/**
 * Gibt dem Tab einen eigenen Namen. Ein leerer Name nimmt ihn wieder weg;
 * der Tab heißt dann wie seine Shell.
 */
export function renameTab(arrangement: Arrangement, tabId: string, name: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  const trimmed = name.trim();
  const rename = ({ name: _, ...tab }: Tab): Tab => (trimmed ? { ...tab, name: trimmed } : tab);
  const tabs = group.tabs.map((tab) => (tab.id === tabId ? rename(tab) : tab));
  const root = replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs }));
  return { ...arrangement, root };
}

/**
 * Trägt bei jedem Terminal, für das keine Shell gewählt wurde, `shell` ein: die
 * Standard-Shell zum Zeitpunkt seines Entstehens. Eine spätere Änderung der
 * Standard-Shell lässt bestehende Terminals damit unberührt.
 */
export function assignShell(arrangement: Arrangement, shell: Shell): Arrangement {
  const settled = (tab: Tab) => tab.shell !== undefined || !isTerminal(tab);
  if (!arrangement.root || tabsOf(arrangement).every(settled)) return arrangement;
  const assign = (node: TreeNode): TreeNode =>
    node.kind === "group"
      ? { ...node, tabs: node.tabs.map((tab) => (settled(tab) ? tab : { ...tab, shell })) }
      : { ...node, children: node.children.map(assign) };
  return { ...arrangement, root: assign(arrangement.root) };
}

/** Wohin ein Tab verschoben wird. */
export type TabTarget =
  | {
      /** In die Tab-Leiste dieser Gruppe. */
      groupId: string;
      /** Lücke der Tab-Leiste, wie sie vor dem Verschieben aussieht: 0 vor dem ersten Tab, die Anzahl der Tabs nach dem letzten. */
      index: number;
    }
  | {
      /** An den Rand dieser Gruppe; dort entsteht eine neue Gruppe. */
      groupId: string;
      side: Side;
    };

/**
 * Verschiebt den Tab an das Ziel. Dort wird er sichtbar, und seine neue Gruppe
 * erhält den Fokus. In der alten Gruppe rückt ein Nachbar nach wie beim
 * Schließen; verliert sie ihren letzten Tab, verschwindet sie. An einem Rand
 * übernimmt die neue Gruppe die Hälfte des Platzes der Zielgruppe.
 */
export function moveTab(arrangement: Arrangement, tabId: string, target: TabTarget): Arrangement {
  const source = groupOfTab(arrangement, tabId);
  const destination = groupsOf(arrangement).find((group) => group.id === target.groupId);
  if (!arrangement.root || !source || !destination) return arrangement;
  const sourceIndex = source.tabs.findIndex((tab) => tab.id === tabId);
  const tab = source.tabs[sourceIndex];
  const without = replaceGroup(arrangement.root, source.id, (group) => withoutTab(group, tabId));

  if ("side" in target) {
    // Der einzige Tab einer Gruppe hätte neben sich nur eine leere Gruppe.
    if (source === destination && source.tabs.length === 1) return arrangement;
    const { nextId } = arrangement;
    const added: Group = { kind: "group", id: `g${nextId}`, tabs: [tab], activeTab: tab.id };
    const addedFirst = target.side === "left" || target.side === "up";
    const root = replaceGroup(without, destination.id, (group) => ({
      kind: "split",
      id: `s${nextId + 1}`,
      axis: target.side === "left" || target.side === "right" ? "row" : "column",
      children: addedFirst ? [added, group] : [group, added],
      sizes: [0.5, 0.5],
    }));
    return { ...arrangement, root: tidy(root), focusedGroup: added.id, nextId: nextId + 2 };
  }

  // Fehlt der Tab links von der Lücke, liegt sie eine Stelle weiter vorn.
  const shift = source === destination && sourceIndex < target.index ? 1 : 0;
  const root = replaceGroup(without, destination.id, (group) => {
    const tabs = [...group.tabs];
    tabs.splice(target.index - shift, 0, tab);
    return { ...group, tabs, activeTab: tab.id };
  });
  return { ...arrangement, root: tidy(root), focusedGroup: destination.id };
}

/** Die Gruppe ohne den Tab. War er sichtbar, rückt sein rechter Nachbar nach, sonst der linke. */
function withoutTab(group: Group, tabId: string): Group {
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = group.tabs.filter((tab) => tab.id !== tabId);
  // Bleibt kein Tab übrig, räumt `tidy` die Gruppe ab.
  const successor = tabs[index] ?? tabs.at(-1);
  const activeTab = group.activeTab === tabId && successor ? successor.id : group.activeTab;
  return { ...group, tabs, activeTab };
}

/**
 * Stellt die Regeln des Baums wieder her: Eine Gruppe ohne Tabs verschwindet,
 * ihre Nachbarn teilen sich ihren Platz im bisherigen Verhältnis. Eine Teilung
 * in derselben Richtung wie die umgebende geht in dieser auf, und eine Teilung
 * mit nur einem Teilstück wird durch dieses ersetzt.
 */
function tidy(node: TreeNode): TreeNode | null {
  if (node.kind === "group") return node.tabs.length > 0 ? node : null;
  const children: TreeNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((original, index) => {
    const child = tidy(original);
    if (!child) return;
    if (child.kind === "split" && child.axis === node.axis) {
      children.push(...child.children);
      sizes.push(...child.sizes.map((size) => size * node.sizes[index]));
    } else {
      children.push(child);
      sizes.push(node.sizes[index]);
    }
  });
  if (children.length < 2) return children[0] ?? null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { ...node, children, sizes: sizes.map((size) => size / total) };
}

/** Ersetzt die Gruppe mit der Kennung `id` durch das Ergebnis von `change`. */
function replaceGroup(
  node: TreeNode,
  id: string | null,
  change: (group: Group) => TreeNode,
): TreeNode {
  if (node.kind === "group") return node.id === id ? change(node) : node;
  return { ...node, children: node.children.map((child) => replaceGroup(child, id, change)) };
}

/**
 * Öffnet einen Inhalt (etwa eine Dateiansicht) als Tab der fokussierten
 * Gruppe, rechts neben ihrem sichtbaren Tab, und zeigt ihn an. Ist der Inhalt
 * schon irgendwo offen, wird stattdessen jener Tab angezeigt. Mit `preview`
 * entsteht ein Vorschau-Tab, der den bisherigen Vorschau-Tab der Gruppe
 * ersetzt; ohne `preview` ist der Tab dauerhaft, auch wenn er zuvor Vorschau war.
 */
export function openContent(
  arrangement: Arrangement,
  content: TabContent,
  preview = false,
): Arrangement {
  const existing = tabsOf(arrangement).find(
    (tab) => tab.content && sameContent(tab.content, content),
  );
  if (existing) {
    const shown = activateTab(arrangement, existing.id);
    return preview ? shown : keepTab(shown, existing.id);
  }

  const { root, nextId } = arrangement;
  const added: Tab = preview
    ? { id: `t${nextId}`, content, preview }
    : { id: `t${nextId}`, content };
  if (!root) {
    const group: Group = {
      kind: "group",
      id: `g${nextId + 1}`,
      tabs: [added],
      activeTab: added.id,
    };
    return { ...arrangement, root: group, focusedGroup: group.id, nextId: nextId + 2 };
  }
  const target = focusedGroupOf(arrangement) ?? groupsOf(arrangement)[0];
  const replaced = preview ? target.tabs.find((tab) => tab.preview) : undefined;
  if (replaced) {
    // Der Vorschau-Tab behält Platz und Kennung und zeigt nur etwas anderes.
    const tabs = target.tabs.map((tab) => (tab === replaced ? { ...tab, content } : tab));
    return {
      ...arrangement,
      root: replaceGroup(root, target.id, (group) => ({ ...group, tabs, activeTab: replaced.id })),
      focusedGroup: target.id,
    };
  }
  const tabs = [...target.tabs];
  tabs.splice(tabs.findIndex((tab) => tab.id === target.activeTab) + 1, 0, added);
  return {
    ...arrangement,
    root: replaceGroup(root, target.id, (group) => ({ ...group, tabs, activeTab: added.id })),
    focusedGroup: target.id,
    nextId: nextId + 1,
  };
}

/** Macht aus einem Vorschau-Tab einen dauerhaften. */
export function keepTab(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group?.tabs.some((tab) => tab.id === tabId && tab.preview)) {
    return arrangement;
  }
  const keep = ({ preview: _, ...tab }: Tab): Tab => tab;
  const tabs = group.tabs.map((tab) => (tab.id === tabId ? keep(tab) : tab));
  return {
    ...arrangement,
    root: replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs })),
  };
}

/**
 * Verschiebt die Trennlinie hinter dem Teilstück `index` einer Teilung an die
 * Stelle `position` (0 bis 1 entlang der Teilung). Nur die beiden Nachbarn der
 * Trennlinie ändern ihre Größe; jedem bleibt mindestens `minSize`.
 */
export function moveDivider(
  arrangement: Arrangement,
  splitId: string,
  index: number,
  position: number,
  minSize = 0.05,
): Arrangement {
  let found = false;
  const move = (node: TreeNode): TreeNode => {
    if (node.kind === "group") return node;
    if (node.id !== splitId) return { ...node, children: node.children.map(move) };
    if (index < 0 || index >= node.children.length - 1) return node;
    found = true;
    const start = node.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
    const both = node.sizes[index] + node.sizes[index + 1];
    const min = Math.min(minSize, both / 2);
    const first = Math.min(Math.max(position - start, min), both - min);
    const sizes = [...node.sizes];
    sizes[index] = first;
    sizes[index + 1] = both - first;
    return { ...node, sizes };
  };
  const root = arrangement.root && move(arrangement.root);
  return found ? { ...arrangement, root } : arrangement;
}

/** Gibt der Gruppe den Fokus. */
export function focusGroup(arrangement: Arrangement, groupId: string): Arrangement {
  if (arrangement.focusedGroup === groupId) return arrangement;
  if (!groupsOf(arrangement).some((group) => group.id === groupId)) return arrangement;
  return { ...arrangement, focusedGroup: groupId };
}

/** Gibt der nächsten (`1`) oder vorigen (`-1`) Gruppe in Lesereihenfolge den Fokus, reihum. */
export function focusAdjacentGroup(arrangement: Arrangement, offset: 1 | -1): Arrangement {
  const groups = groupsOf(arrangement);
  const index = groups.findIndex((group) => group.id === arrangement.focusedGroup);
  if (index < 0) return arrangement;
  return focusGroupAt(arrangement, (index + offset + groups.length) % groups.length);
}

export type Side = "left" | "right" | "up" | "down";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Die Fläche jeder Gruppe im Hauptbereich; dieser reicht von 0 bis 1 in beiden Richtungen. */
function boxesOf(arrangement: Arrangement): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const place = (node: TreeNode, box: Box) => {
    if (node.kind === "group") {
      boxes.set(node.id, box);
      return;
    }
    let start = node.axis === "row" ? box.left : box.top;
    const extent = node.axis === "row" ? box.right - box.left : box.bottom - box.top;
    node.children.forEach((child, index) => {
      const end = start + node.sizes[index] * extent;
      const part =
        node.axis === "row"
          ? { ...box, left: start, right: end }
          : { ...box, top: start, bottom: end };
      place(child, part);
      start = end;
    });
  };
  if (arrangement.root) place(arrangement.root, { left: 0, top: 0, right: 1, bottom: 1 });
  return boxes;
}

/**
 * Gibt der Gruppe den Fokus, die auf der Seite `side` an die fokussierte
 * angrenzt; von mehreren die oberste bzw. die am weitesten links. Grenzt
 * dort keine an, bleibt der Fokus.
 */
export function focusGroupToward(arrangement: Arrangement, side: Side): Arrangement {
  const boxes = boxesOf(arrangement);
  const from = arrangement.focusedGroup && boxes.get(arrangement.focusedGroup);
  if (!from) return arrangement;
  // Rechenungenauigkeit der Anteile; weit unter jeder sichtbaren Größe.
  const touches = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const overlaps = (start: number, end: number, otherStart: number, otherEnd: number) =>
    start < otherEnd - 1e-6 && otherStart < end - 1e-6;
  const horizontal = side === "left" || side === "right";
  const neighbors = [...boxes].filter(([, box]) => {
    const beside = overlaps(box.top, box.bottom, from.top, from.bottom);
    const stacked = overlaps(box.left, box.right, from.left, from.right);
    if (side === "left") return beside && touches(box.right, from.left);
    if (side === "right") return beside && touches(box.left, from.right);
    if (side === "up") return stacked && touches(box.bottom, from.top);
    return stacked && touches(box.top, from.bottom);
  });
  neighbors.sort(([, a], [, b]) => (horizontal ? a.top - b.top : a.left - b.left));
  return neighbors.length > 0 ? focusGroup(arrangement, neighbors[0][0]) : arrangement;
}

/** Gibt der Gruppe an der Stelle `index` (ab 0, in Lesereihenfolge) den Fokus. */
export function focusGroupAt(arrangement: Arrangement, index: number): Arrangement {
  const group = groupsOf(arrangement)[index];
  return group ? focusGroup(arrangement, group.id) : arrangement;
}

/** Zeigt den Tab an und gibt seiner Gruppe den Fokus. */
export function activateTab(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  if (group.activeTab === tabId) return focusGroup(arrangement, group.id);
  const root = replaceGroup(arrangement.root, group.id, () => ({ ...group, activeTab: tabId }));
  return { ...arrangement, root, focusedGroup: group.id };
}

/** Zeigt in der fokussierten Gruppe den nächsten (`1`) oder vorigen (`-1`) Tab an, reihum. */
export function activateAdjacentTab(arrangement: Arrangement, offset: 1 | -1): Arrangement {
  const group = focusedGroupOf(arrangement);
  if (!group) return arrangement;
  const index = group.tabs.findIndex((tab) => tab.id === group.activeTab);
  const next = group.tabs[(index + offset + group.tabs.length) % group.tabs.length];
  return activateTab(arrangement, next.id);
}

/** Die Gruppe, die den Fokus hat. */
export function focusedGroupOf(arrangement: Arrangement): Group | null {
  return groupsOf(arrangement).find((group) => group.id === arrangement.focusedGroup) ?? null;
}
