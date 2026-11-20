import { useRef, useState, type PointerEvent } from "react";
import { views, type View } from "./ActivityBar";
import { useAgentStatuses, type AgentStatuses } from "./agentStatus";
import { AgentCardStatus, AgentCardTop } from "./AgentStatusViews";
import { focusedGroupOf, isTerminal, tabsOf, type Arrangement, type Tab } from "./arrangement";
import { Explorer } from "./Explorer";
import { useT } from "./i18n/i18n";
import { SearchView, type SearchViewProps } from "./SearchView";
import { tabLabel } from "./tabLabel";

/** Zwischen diesen Breiten lässt sich die Seitenleiste ziehen (in Pixeln). */
const MIN_WIDTH = 170;
/** So viel Breite bleibt dem Hauptbereich mindestens. */
const MIN_MAIN_WIDTH = 300;

interface AgentsViewProps {
  arrangement: Arrangement;
  /** Der Agentenstatus der Terminals des Fensters. */
  statuses: AgentStatuses;
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
  /** Öffnet ein Terminal in diesem Ordner, mit `agent` samt einem Agenten. */
  onOpenTerminalIn: (folder: string, agent: boolean) => void;
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe. */
  activeFile: string | null;
  /** Öffnet eine Datei des Projekts als Dateiansicht, mit `preview` als Vorschau-Tab. */
  onOpenFile: (path: string, preview: boolean) => void;
  /** Öffnet eine Datei an einer Fundstelle der Suche. */
  onOpenMatch: SearchViewProps["onOpenFile"];
  /** Steigt, wenn die Suche aufgerufen wird. */
  searchFocus: number;
}

export function Sidebar({
  view,
  visible,
  project,
  onOpenTerminalIn,
  activeFile,
  onOpenFile,
  onOpenMatch,
  searchFocus,
  ...agents
}: SidebarProps) {
  const t = useT();
  const [width, setWidth] = useState(280);
  const sidebar = useRef<HTMLElement>(null);
  const title = views.find(({ id }) => id === view)!.label;
  const showsExplorer = view === "explorer" && project !== null;
  const showsSearch = view === "search" && project !== null;

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const left = sidebar.current!.getBoundingClientRect().left;
    const widest = Math.max(MIN_WIDTH, window.innerWidth - left - MIN_MAIN_WIDTH);
    setWidth(Math.min(widest, Math.max(MIN_WIDTH, event.clientX - left)));
  }

  return (
    <aside className="sidebar" ref={sidebar} hidden={!visible} style={{ width }}>
      <div className="side-title">{t(title)}</div>
      <div className="side-body" hidden={showsExplorer || showsSearch}>
        {view === "agents" ? (
          <AgentsView {...agents} />
        ) : (
          <p className="hint">
            {t(
              view === "explorer" || view === "search"
                ? "status.noProject"
                : "sidebar.notAvailable",
            )}
          </p>
        )}
      </div>
      {/* Der Explorer bleibt bestehen, damit er beim Wechsel der Ansicht nichts neu lesen muss. */}
      {project !== null && (
        <Explorer
          key={project}
          project={project}
          hidden={!showsExplorer}
          onOpenTerminalIn={onOpenTerminalIn}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
        />
      )}
      {/* Auch die Suche behält beim Wechsel der Ansicht Eingabe und Trefferliste. */}
      {project !== null && (
        <SearchView
          key={`search:${project}`}
          project={project}
          hidden={!showsSearch}
          focusRequest={searchFocus}
          onOpenFile={onOpenMatch}
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
 * Die Agenten-Ansicht: oben die Agenten des Fensters als Karten mit
 * Agentenstatus, Laufzeit und letzter Aktion, darunter die gewöhnlichen
 * Terminals. Ein wartender Agent ist hervorgehoben.
 */
function AgentsView({
  arrangement,
  statuses,
  onSelectTab,
  onNewAgent,
  onNewTerminal,
}: AgentsViewProps) {
  const t = useT();
  const known = useAgentStatuses(statuses);
  // Dateiansichten gehören nicht in die Agenten-Ansicht.
  const tabs = tabsOf(arrangement).filter(isTerminal);
  const agents = tabs.filter((tab) => tab.agent);
  const terminals = tabs.filter((tab) => !tab.agent);
  const selected = focusedGroupOf(arrangement)?.activeTab;
  const card = (tab: Tab) => {
    const status = known.get(tab.id);
    const classes = ["card", status?.state === "waiting" && "wait", tab.id === selected && "sel"];
    return (
      <button
        key={tab.id}
        className={classes.filter(Boolean).join(" ")}
        onClick={() => onSelectTab(tab.id)}
      >
        <AgentCardTop status={status} name={tabLabel(tab, t)} />
        {status && <AgentCardStatus status={status} />}
      </button>
    );
  };
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
