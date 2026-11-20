import type { Side, TabTarget } from "./arrangement";

/**
 * Wo ein gezogener Tab landet: reine Geometrie über den Flächen der Gruppen,
 * ohne Zugriff auf die Oberfläche.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Die Flächen einer Gruppe auf dem Bildschirm. */
export interface GroupRects {
  id: string;
  /** Die Tab-Leiste. */
  bar: Rect;
  /** Die Fläche unter der Tab-Leiste. */
  body: Rect;
  /** Die Tabs in ihrer Reihenfolge. */
  tabs: { id: string; rect: Rect }[];
}

export interface Drop {
  target: TabTarget;
  /** Die Fläche, die das Ziel während des Ziehens markiert. */
  marker: Rect;
}

/** Näher als diesen Anteil an einem Rand bildet der Tab dort eine neue Gruppe. */
const EDGE_SHARE = 0.25;
/** Breite des Strichs, der eine Lücke in der Tab-Leiste markiert (in Pixeln). */
const GAP_MARKER = 2;

const contains = (rect: Rect, x: number, y: number) =>
  x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

/**
 * Das Ziel für den Tab `tabId`, wenn er an der Stelle (`x`, `y`) losgelassen
 * wird: über einer Tab-Leiste die Lücke neben dem Zeiger, am Rand einer Gruppe
 * eine neue Gruppe, in ihrer Mitte das Ende ihrer Tab-Leiste. `null`, wo das
 * Ablegen nichts ändern würde.
 */
export function dropAt(x: number, y: number, tabId: string, groups: GroupRects[]): Drop | null {
  for (const group of groups) {
    const own = group.tabs.some((tab) => tab.id === tabId);

    if (contains(group.bar, x, y)) {
      const index = group.tabs.filter((tab) => (tab.rect.left + tab.rect.right) / 2 < x).length;
      // Die Lücken links und rechts des Tabs selbst lassen ihn, wo er ist.
      const ownIndex = group.tabs.findIndex((tab) => tab.id === tabId);
      if (own && (index === ownIndex || index === ownIndex + 1)) return null;
      const gap = index > 0 ? group.tabs[index - 1].rect.right : group.bar.left;
      const left = Math.max(group.bar.left, gap - GAP_MARKER / 2);
      return {
        target: { groupId: group.id, index },
        marker: { ...group.bar, left, right: left + GAP_MARKER },
      };
    }

    if (contains(group.body, x, y)) {
      const { left, top, right, bottom } = group.body;
      const distances: [Side, number][] = [
        ["left", (x - left) / (right - left)],
        ["right", (right - x) / (right - left)],
        ["up", (y - top) / (bottom - top)],
        ["down", (bottom - y) / (bottom - top)],
      ];
      const [side, distance] = distances.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (distance >= EDGE_SHARE) {
        if (own) return null;
        return { target: { groupId: group.id, index: group.tabs.length }, marker: group.body };
      }
      if (own && group.tabs.length === 1) return null;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const halves: Record<Side, Rect> = {
        left: { ...group.body, right: centerX },
        right: { ...group.body, left: centerX },
        up: { ...group.body, bottom: centerY },
        down: { ...group.body, top: centerY },
      };
      return { target: { groupId: group.id, side }, marker: halves[side] };
    }
  }
  return null;
}
