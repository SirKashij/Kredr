import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Ein Eingabefeld mit Trefferliste über dem Fenster, oben mittig wie in
 * VS Code. Pfeiltasten wählen, die Eingabetaste oder ein Klick nimmt die
 * Zeile, Esc oder ein Klick daneben schließt. Was die Eingabe findet und was
 * eine gewählte Zeile auslöst, bestimmt der Aufrufer.
 *
 * Ein Knopf, der die Liste ein- und ausblendet, trägt das Attribut
 * `data-quick-pick-toggle`: Der Klick auf ihn schließt nicht von selbst,
 * sonst öffnete derselbe Klick die Liste gleich wieder.
 */
export function QuickPick<Row>({
  placeholder,
  title,
  query,
  onQuery,
  rows,
  rowKey,
  rowTitle,
  renderRow,
  empty,
  onPick,
  onClose,
  children,
}: {
  placeholder: string;
  /** Steht klein unter dem Eingabefeld, etwa wofür die Liste gilt. */
  title?: ReactNode;
  query: string;
  onQuery: (query: string) => void;
  /** Die Zeilen zur Eingabe, die beste zuerst. */
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  rowTitle?: (row: Row) => string;
  renderRow: (row: Row) => ReactNode;
  /** Steht statt der Liste da, wenn es keine Zeile gibt. */
  empty: ReactNode;
  onPick: (row: Row) => void;
  onClose: () => void;
  /** Steht unter der Liste, etwa eine Meldung. */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  // Ändern sich die Zeilen im Hintergrund, bleibt die Auswahl in der Liste.
  const chosen = Math.min(selected, rows.length - 1);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (box.current!.contains(target) || target.closest?.("[data-quick-pick-toggle]")) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    list.current?.children[chosen]?.scrollIntoView({ block: "nearest" });
  }, [chosen, rows]);

  function onKeyDown(event: React.KeyboardEvent) {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      // Am Ende der Liste geht es am anderen Ende weiter.
      if (rows.length > 0) setSelected((chosen + step + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      if (rows[chosen] !== undefined) onPick(rows[chosen]);
    } else if (event.key === "Escape") {
      onClose();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className="quick-open" ref={box}>
      <input
        className="quick-open-input"
        autoFocus
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        value={query}
        onChange={(event) => {
          onQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      {title && <div className="quick-open-title">{title}</div>}
      {rows.length > 0 ? (
        <div className="quick-open-list" role="listbox" ref={list}>
          {rows.map((row, position) => (
            <div
              key={rowKey(row)}
              className={position === chosen ? "quick-open-row sel" : "quick-open-row"}
              role="option"
              aria-selected={position === chosen}
              title={rowTitle?.(row)}
              onClick={() => onPick(row)}
            >
              {renderRow(row)}
            </div>
          ))}
        </div>
      ) : (
        <div className="quick-open-empty">{empty}</div>
      )}
      {children}
    </div>
  );
}
