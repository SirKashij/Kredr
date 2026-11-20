import { useEffect, useRef, type RefObject } from "react";

/**
 * Gibt einer Ansicht ohne Eingabefeld (Markdown-Vorschau, Bild) die
 * Tastatureingaben, solange ihre Gruppe den Fokus hat, erneut bei jedem neuen
 * `focusRequest`. So scrollen die Pfeiltasten, und die Eingaben landen nicht
 * in einem Terminal, das gar nicht mehr zu sehen ist.
 */
export function useViewFocus(
  view: RefObject<HTMLElement | null>,
  focused: boolean,
  focusRequest: number,
) {
  const requestAtMount = useRef(focusRequest);
  useEffect(() => {
    const element = view.current;
    if (!focused || !element) return;
    const active = document.activeElement;
    if (element.contains(active)) return;
    // Beim Durchklicken in der Seitenleiste (Vorschau-Tab) bleibt die Tastatur dort.
    const browsing = active?.closest(".sidebar") && focusRequest === requestAtMount.current;
    if (!browsing) element.focus();
  }, [view, focused, focusRequest]);
}
