import { views, type View } from "./ActivityBar";
import { focusedGroupOf, groupsOf, type Arrangement } from "./arrangement";
import { useT } from "./i18n/i18n";

interface AgentsViewProps {
  arrangement: Arrangement;
  /** Zeigt den Tab im Hauptbereich an und gibt ihm den Fokus. */
  onSelectTab: (tabId: string) => void;
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

/** Die Agenten-Ansicht; zeigt vorerst nur die gewöhnlichen Terminals. */
function AgentsView({ arrangement, onSelectTab }: AgentsViewProps) {
  const t = useT();
  const tabs = groupsOf(arrangement).flatMap((group) => group.tabs);
  const selected = focusedGroupOf(arrangement)?.activeTab;
  return (
    <div className="cards">
      <div className="sect">{t("sidebar.terminals")}</div>
      {tabs.length === 0 && <p className="hint">{t("sidebar.noTerminals")}</p>}
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
