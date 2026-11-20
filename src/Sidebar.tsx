import { useRef, useState, type PointerEvent } from "react";
import { views, type View } from "./ActivityBar";
import { focusedGroupOf, isTerminal, tabsOf, type Arrangement, type Tab } from "./arrangement";
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
  /** Öffnet ein Terminal und startet darin einen Agenten; fehlt ohne Projekt. */
  onNewAgent?: () => void;
  /** Öffnet ein gewöhnliches Terminal; fehlt ohne Projekt. */
  onNewTerminal?: () => void;
}

interface SidebarProps extends AgentsViewProps {
  view: View;
  /** Ob die Seitenleiste eingeblendet ist. Ausgeblendet behält sie ihren Zustand. */
  visible: boolean;
  /** Der Ordner des Projekts dieses Fensters. */
  project: string | null;
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe. */
  activeFile: string | null;
  /** Öffnet eine Datei des Projekts als Dateiansicht, mit `preview` als Vorschau-Tab. */
  onOpenFile: (path: string, preview: boolean) => void;
}

export function Sidebar({
  view,
  visible,
  project,
  activeFile,
  onOpenFile,
  ...agents
}: SidebarProps) {
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
      {project !== null && (
        <Explorer
          key={project}
          project={project}
          hidden={!showsExplorer}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
        />
      )}
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

/**
 * Die Agenten-Ansicht: oben die Agenten des Fensters als Karten, darunter die
 * gewöhnlichen Terminals. Der Agentenstatus folgt in einem eigenen Schritt.
 */
function AgentsView({ arrangement, onSelectTab, onNewAgent, onNewTerminal }: AgentsViewProps) {
  const t = useT();
  // Dateiansichten gehören nicht in die Agenten-Ansicht.
  const tabs = tabsOf(arrangement).filter(isTerminal);
  const agents = tabs.filter((tab) => tab.agent);
  const terminals = tabs.filter((tab) => !tab.agent);
  const selected = focusedGroupOf(arrangement)?.activeTab;
  const card = (tab: Tab) => (
    <button
      key={tab.id}
      className={tab.id === selected ? "card sel" : "card"}
      onClick={() => onSelectTab(tab.id)}
    >
      <span className="dot" />
      <span>{t(tab.agent ? "agent.name" : "terminal.powershell")}</span>
    </button>
  );
  return (
    <div className="cards">
      <div className="side-actions">
        <button
          className="btn"
          title={t("agent.newTooltip")}
          disabled={!onNewAgent}
          onClick={onNewAgent}
        >
          {t("agent.new")}
        </button>
        <button
          className="btn ghost"
          title={t("terminal.newTooltip")}
          disabled={!onNewTerminal}
          onClick={onNewTerminal}
        >
          {t("terminal.new")}
        </button>
      </div>
      {agents.map(card)}
      {tabs.length === 0 && <p className="hint">{t("terminal.none")}</p>}
      {terminals.length > 0 && <div className="sect">{t("sidebar.terminals")}</div>}
      {terminals.map(card)}
    </div>
  );
}
