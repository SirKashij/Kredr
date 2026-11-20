import { views, type View } from "./ActivityBar";
import { useT } from "./i18n/i18n";

export function Sidebar({ view, hasTerminal }: { view: View; hasTerminal: boolean }) {
  const t = useT();
  const title = views.find(({ id }) => id === view)!.label;
  return (
    <aside className="sidebar">
      <div className="side-title">{t(title)}</div>
      <div className="side-body">
        {view === "agents" ? (
          <AgentsView hasTerminal={hasTerminal} />
        ) : (
          <p className="hint">{t("sidebar.notAvailable")}</p>
        )}
      </div>
    </aside>
  );
}

/** Die Agenten-Ansicht; zeigt vorerst nur die gewöhnlichen Terminals. */
function AgentsView({ hasTerminal }: { hasTerminal: boolean }) {
  const t = useT();
  return (
    <div className="cards">
      <div className="sect">{t("sidebar.terminals")}</div>
      {hasTerminal ? (
        <div className="card sel">
          <span className="dot" />
          <span>{t("terminal.powershell")}</span>
        </div>
      ) : (
        <p className="hint">{t("sidebar.noTerminals")}</p>
      )}
    </div>
  );
}
