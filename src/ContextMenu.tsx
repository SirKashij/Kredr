import { useEffect, useLayoutEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

/** Ein Kontextmenü an der Stelle des Rechtsklicks. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);

  // Am Fensterrand rückt das Menü so weit herein, dass es ganz sichtbar ist.
  useLayoutEffect(() => {
    const element = menu.current!;
    element.style.left = `${Math.max(0, Math.min(x, window.innerWidth - element.offsetWidth))}px`;
    element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - element.offsetHeight))}px`;
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current!.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      className="menu"
      role="menu"
      ref={menu}
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}>
      {items.map(({ label, onSelect }) => (
        <button
          key={label}
          role="menuitem"
          onClick={() => {
            onClose();
            onSelect();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
