/**
 * Die Aufteilung des Hauptbereichs als reines Zustandsmodell: ein Baum aus
 * Teilungen und Gruppen, jede Gruppe mit ihren Tabs. Jede Operation liefert
 * eine neue Aufteilung und lässt die alte unverändert. Der Zustand besteht
 * nur aus einfachen Daten und lässt sich deshalb als JSON speichern.
 */

export interface Tab {
  id: string;
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

/** Eine neue Gruppe mit einem neuen Tab; sie verbraucht zwei Kennungen. */
function newGroup(nextId: number): Group {
  const tab: Tab = { id: `t${nextId}` };
  return { kind: "group", id: `g${nextId + 1}`, tabs: [tab], activeTab: tab.id };
}

/**
 * Öffnet einen neuen Tab in der fokussierten Gruppe und zeigt ihn an. Ohne
 * Gruppen entsteht die erste; hat keine Gruppe den Fokus, nimmt ihn die erste.
 */
export function openTab(arrangement: Arrangement): Arrangement {
  const { root, nextId } = arrangement;
  if (!root) {
    const group = newGroup(nextId);
    return { ...arrangement, root: group, focusedGroup: group.id, nextId: nextId + 2 };
  }
  const target = focusedGroupOf(arrangement) ?? groupsOf(arrangement)[0];
  const tab: Tab = { id: `t${nextId}` };
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
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = group.tabs.filter((tab) => tab.id !== tabId);
  // Bleibt kein Tab übrig, räumt `tidy` die Gruppe ab.
  const successor = tabs[index] ?? tabs.at(-1);
  const activeTab = group.activeTab === tabId && successor ? successor.id : group.activeTab;
  const root = tidy(
    replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs, activeTab })),
  );
  if (tabs.length > 0 || arrangement.focusedGroup !== group.id) return { ...arrangement, root };

  // Die fokussierte Gruppe ist verschwunden: Der Fokus geht an die Gruppe
  // davor, sonst an die danach.
  const before = groupsOf(arrangement);
  const position = before.indexOf(group);
  const heir = before[position - 1] ?? before[position + 1];
  return { ...arrangement, root, focusedGroup: heir?.id ?? null };
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
