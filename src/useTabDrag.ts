import { useEffect, useRef, useState, type PointerEvent } from "react";
import { moveTab, tabsOf, type Arrangement } from "./arrangement";
import { dropAt, type Drop, type GroupRects, type Rect } from "./tabDrop";

/** Erst ab dieser Strecke gilt ein gedrückter Tab als gezogen (in Pixeln). */
const DRAG_THRESHOLD = 5;

/** Das Ziehen eines Tabs mit der Maus. */
export interface TabDrag {
  /** Der Tab, der gerade gezogen wird. */
  tabId: string | null;
  /** Wo der Tab landet, wenn er jetzt losgelassen wird. */
  drop: Drop | null;
  /** Die Zeigerereignisse, die ein Tab dafür braucht. */
  handlers: (tabId: string) => {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: () => void;
  };
  /** Ob der Klick, der gerade ankommt, nur das Loslassen nach einem Ziehen ist. */
  justEndedDrag: () => boolean;
}

function rectOf(element: Element): Rect {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}

/** Die Flächen aller Gruppen, wie sie gerade auf dem Bildschirm liegen. */
function readGroupRects(): GroupRects[] {
  const groups = [...document.querySelectorAll<HTMLElement>("[data-group]")];
  // Von einer maximierten Gruppe verdeckte Gruppen sind kein Ziel.
  const visible = groups.filter((section) => section.getClientRects().length > 0);
  return visible.map((section) => {
    const box = rectOf(section);
    const bar = rectOf(section.querySelector(".tabs")!);
    return {
      id: section.dataset.group!,
      bar,
      body: { ...box, top: bar.bottom },
      tabs: [...section.querySelectorAll<HTMLElement>("[data-tab]")].map((tab) => ({
        id: tab.dataset.tab!,
        rect: rectOf(tab),
      })),
    };
  });
}

/**
 * Tabs mit der Maus ziehen: Die Aufteilung ändert sich erst beim Loslassen,
 * bis dahin zeigt `drop` nur, wo der Tab landen würde. Escape bricht ab.
 * Gruppen und Tabs erkennt das Ziehen an `data-group` und `data-tab`.
 */
export function useTabDrag(
  arrangement: Arrangement,
  update: (change: (arrangement: Arrangement) => Arrangement) => void,
  onRefocus: () => void,
): TabDrag {
  const [state, setState] = useState<{ tabId: string; drop: Drop | null } | null>(null);
  /** Der gedrückte Tab, solange die Maustaste unten ist. */
  const press = useRef<{
    tabId: string;
    x: number;
    y: number;
    dragging: boolean;
    cancelled: boolean;
  } | null>(null);
  const dragEnded = useRef(false);
  // Schließt sich der Tab während des Ziehens (etwa per Tastenkürzel), endet es.
  const drag = state && tabsOf(arrangement).some((tab) => tab.id === state.tabId) ? state : null;
  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (press.current) press.current.cancelled = true;
      setState(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dragging]);

  return {
    tabId: drag?.tabId ?? null,
    drop: drag?.drop ?? null,
    justEndedDrag: () => dragEnded.current,
    handlers: (tabId) => ({
      onPointerDown(event) {
        dragEnded.current = false;
        press.current = null;
        // Nur die linke Taste zieht, und nicht am Knopf zum Schließen.
        if (event.button !== 0 || (event.target as Element).closest("button")) return;
        press.current = {
          tabId,
          x: event.clientX,
          y: event.clientY,
          dragging: false,
          cancelled: false,
        };
        // Die Bewegung kommt weiter beim Tab an, auch über dem Terminal.
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event) {
        const pressed = press.current;
        if (!pressed || pressed.cancelled) return;
        const distance = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
        if (!pressed.dragging && distance < DRAG_THRESHOLD) return;
        pressed.dragging = true;
        setState({ tabId, drop: dropAt(event.clientX, event.clientY, tabId, readGroupRects()) });
      },
      onPointerUp(event) {
        const pressed = press.current;
        press.current = null;
        if (!pressed?.dragging) return;
        // Der Klick, der dem Loslassen folgt, kommt noch in diesem Durchlauf an.
        dragEnded.current = true;
        setTimeout(() => (dragEnded.current = false));
        setState(null);
        const drop = pressed.cancelled
          ? null
          : dropAt(event.clientX, event.clientY, tabId, readGroupRects());
        if (drop) update((current) => moveTab(current, tabId, drop.target));
        else onRefocus();
      },
      onLostPointerCapture() {
        press.current = null;
        setState(null);
      },
    }),
  };
}
