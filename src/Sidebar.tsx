import { views, type View } from "./ActivityBar";
import { useAgentStatuses, type AgentStatuses } from "./agentStatus";
import { AgentCardStatus, AgentCardTop } from "./AgentStatusViews";
import { focusedGroupOf, tabsOf, type Arrangement, type Tab } from "./arrangement";
import { useT } from "./i18n/i18n";

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

export function Sidebar({ view, ...agents }: { view: View } & AgentsViewProps) {
  const t = useT();
  const title = views.find(({ id }) => id === view)!.label;
  return (
    <aside className="sidebar">
      <div className="side-title">{t(title)}</div>
      <div className="side-body">
        {view === "agents" ? (
          <AgentsView {...agents} />
        ) : (
          <p className="hint">{t("sidebar.notAvailable")}</p>
        )}
      </div>
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
  const tabs = tabsOf(arrangement);
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
        <AgentCardTop status={status} name={t(tab.agent ? "agent.name" : "terminal.powershell")} />
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
