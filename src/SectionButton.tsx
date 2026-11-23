/**
 * Ein Symbolknopf im Kopf eines aufklappbaren Abschnitts der Seitenleiste,
 * etwa „Neuer Agent“ in der Agenten-Ansicht oder „Commit“ in der
 * Versionskontrolle. `path` zeichnet das Symbol in einem 16er-Raster.
 */
export function SectionButton({
  label,
  path,
  popup = false,
  disabled = false,
  strokeWidth,
  onClick,
}: {
  label: string;
  path: string;
  popup?: boolean;
  disabled?: boolean;
  strokeWidth?: number;
  onClick: (bounds: DOMRect) => void;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      aria-haspopup={popup ? "menu" : undefined}
      disabled={disabled}
      onClick={(event) => onClick(event.currentTarget.getBoundingClientRect())}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={path} strokeWidth={strokeWidth} />
      </svg>
    </button>
  );
}

/** Das Symbol „…“ für weitere Aktionen, mit der Strichstärke, die es braucht. */
export const moreIcon = { path: "M3.5 8h.01M8 8h.01M12.5 8h.01", strokeWidth: 2.4 };
