import type { ReactNode } from "react";
import { openContentBeside, showInTab, showsFile, type Arrangement } from "./arrangement";
import { alternateView } from "./fileKinds";
import { useT } from "./i18n/i18n";
import type { ContentTab } from "./tabViews";
import "./preview.css";

/**
 * Die Fläche eines Tabs, dessen Datei zwei Ansichten hat (Markdown:
 * Quelltext und Vorschau; SVG: Bild und Quelltext): darüber eine schmale
 * Leiste, die den Tab umschaltet oder die andere Ansicht daneben öffnet.
 * Dateien mit nur einer Ansicht bleiben ohne Leiste.
 */
export function ViewSwitch({
  tab,
  update,
  children,
}: {
  tab: ContentTab;
  update: (change: (arrangement: Arrangement) => Arrangement) => void;
  children: ReactNode;
}) {
  const t = useT();
  const { content } = tab;
  const other = showsFile(content) ? alternateView(content) : null;
  if (!other || !showsFile(content)) return children;
  const toSource = other.kind === "file";
  return (
    <div className="switched-view">
      <div className="view-switch">
        <span className="view-path" title={content.path}>
          {content.path}
        </span>
        <button onClick={() => update((current) => showInTab(current, tab.id, other))}>
          {t(toSource ? "view.showSource" : "view.showPreview")}
        </button>
        <button onClick={() => update((current) => openContentBeside(current, other))}>
          {t(toSource ? "view.showSourceBeside" : "view.showPreviewBeside")}
        </button>
      </div>
      {children}
    </div>
  );
}
