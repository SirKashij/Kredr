import { useRef, useState, type PointerEvent } from "react";
import { views, type View } from "./ActivityBar";
import { focusedGroupOf, tabsOf, type Arrangement } from "./arrangement";
import { Explorer } from "./Explorer";
import { useT } from "./i18n/i18n";

/** Zwischen diesen Breiten lässt sich die Seitenleiste ziehen (in Pixeln). */
const MIN_WIDTH = 170;
/** So viel Breite bleibt dem Hauptbereich mindestens. */
const MIN_MAIN_WIDTH = 300;

interface AgentsViewProps {
  arrangement: Arrangement;
  /** Zeigt den Tab im Hauptbereich an und gibt ihm den Fokus. */
  onSelectTab: (tabId: string) => void;
}

interface SidebarProps extends AgentsViewProps {
  view: View;
  /** Ob die Seitenleiste eingeblendet ist. Ausgeblendet behält sie ihren Zustand. */
  visible: boolean;
  /** Der Ordner des Projekts dieses Fensters. */
  project: string | null;
}

export function Sidebar({ view, visible, project, ...agents }: SidebarProps) {
  const t = useT();
  const [width, setWidth] = useState(280);
  const sidebar = useRef<HTMLElement>(null);
  const title = views.find(({ id }) => id === view)!.label;
  const showsExplorer = view === "explorer" && project !== null;

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const left = sidebar.current!.getBoundingClientRect().left;
    const widest = Math.max(MIN_WIDTH, window.innerWidth - left - MIN_MAIN_WIDTH);
    setWidth(Math.min(widest, Math.max(MIN_WIDTH, event.clientX - left)));
  }

  return (
    <aside className="sidebar" ref={sidebar} hidden={!visible} style={{ width }}>
      <div className="side-title">{t(title)}</div>
      <div className="side-body" hidden={showsExplorer}>
        {view === "agents" ? (
          <AgentsView {...agents} />
        ) : (
          <p className="hint">
            {t(view === "explorer" ? "status.noProject" : "sidebar.notAvailable")}
          </p>
        )}
      </div>
      {/* Der Explorer bleibt bestehen, damit er beim Wechsel der Ansicht nichts neu lesen muss. */}
      {project !== null && <Explorer key={project} project={project} hidden={!showsExplorer} />}
      <div
        className="sash"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={resize}
      />
    </aside>
  );
}

/** Die Agenten-Ansicht; zeigt vorerst nur die gewöhnlichen Terminals. */
function AgentsView({ arrangement, onSelectTab }: AgentsViewProps) {
  const t = useT();
  const tabs = tabsOf(arrangement);
  const selected = focusedGroupOf(arrangement)?.activeTab;
  return (
    <div className="cards">
      <div className="sect">{t("sidebar.terminals")}</div>
      {tabs.length === 0 && <p className="hint">{t("terminal.none")}</p>}
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={tab.id === selected ? "card sel" : "card"}
          onClick={() => onSelectTab(tab.id)}
        >
          <span className="dot" />
          <span>{t("terminal.powershell")}</span>
        </button>
      ))}
    </div>
  );
}
