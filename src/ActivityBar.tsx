import type { ReactNode } from "react";
import type { AgentStatuses } from "./agentStatus";
import { WaitingBadge } from "./AgentStatusViews";
import { AppUpdateButton } from "./AppUpdateNotice";
import { useT, type MessageKey } from "./i18n/i18n";
import { ChangesBadge } from "./VersionControlView";

export type View = "agents" | "explorer" | "search" | "versionControl";

const icons: Record<View | "settings", ReactNode> = {
  agents: (
    <>
      <rect x="5" y="8" width="14" height="10" rx="2.5" />
      <path d="M12 8V4.5M9.5 12.5v1.5M14.5 12.5v1.5M2.5 12v3M21.5 12v3" />
      <circle cx="12" cy="3.5" r="1" />
    </>
  ),
  explorer: (
    <>
      <path d="M14 3H7a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6z" />
      <path d="M14 3v3h3M9 21h9a2 2 0 0 0 2-2V9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  versionControl: (
    <>
      <circle cx="7" cy="5" r="2.2" />
      <circle cx="7" cy="19" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 7.2v9.6M17 11.2c0 3-4 3.3-10 4.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </>
  ),
};

/** Die Ansichten der Symbolleiste in ihrer festgelegten Reihenfolge. */
export const views: { id: View; label: MessageKey; tooltip?: MessageKey }[] = [
  { id: "agents", label: "activity.agents" },
  { id: "explorer", label: "activity.explorer", tooltip: "activity.explorerTooltip" },
  { id: "search", label: "activity.search", tooltip: "activity.searchTooltip" },
  {
    id: "versionControl",
    label: "activity.versionControl",
    tooltip: "activity.versionControlTooltip",
  },
];

export function ActivityBar({
  view,
  onSelect,
  settingsOpen,
  onToggleSettings,
  statuses,
}: {
  /** Die gezeigte Ansicht; `null`, solange die Seitenleiste ausgeblendet ist. */
  view: View | null;
  onSelect: (view: View) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  /** Am Symbol der Agenten-Ansicht steht die Zahl der wartenden Agenten. */
  statuses: AgentStatuses;
}) {
  const t = useT();
  return (
    <nav className="actbar">
      {views.map(({ id, label, tooltip }) => (
        <button
          key={id}
          className={id === view ? "on" : ""}
          title={t(tooltip ?? label)}
          aria-label={t(label)}
          aria-pressed={id === view}
          onClick={() => onSelect(id)}
        >
          <svg viewBox="0 0 24 24">{icons[id]}</svg>
          {id === "agents" && <WaitingBadge statuses={statuses} />}
          {id === "versionControl" && <ChangesBadge />}
        </button>
      ))}
      <div className="spacer" />
      <AppUpdateButton />
      <button
        className={settingsOpen ? "on" : ""}
        title={t("activity.settingsTooltip")}
        aria-label={t("activity.settings")}
        aria-pressed={settingsOpen}
        onClick={onToggleSettings}
      >
        <svg viewBox="0 0 24 24">{icons.settings}</svg>
      </button>
    </nav>
  );
}
