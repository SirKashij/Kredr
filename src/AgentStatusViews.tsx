import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  countStates,
  duration,
  stateCounters as counters,
  subagentLabel,
  subagentsInOrder,
  subagentSummary,
  subagentTooltip,
  useAgentStatuses,
  type AgentState,
  type AgentStatus,
  type AgentStatuses,
  type BackgroundTaskStatus,
  type SubagentStatus,
  type SummaryPart,
} from "./agentStatus";
import { plural, useT, type MessageKey } from "./i18n/i18n";

const labels: Record<AgentState, MessageKey> = {
  working: "agentStatus.working",
  waiting: "agentStatus.waiting",
  background: "agentStatus.background",
  done: "agentStatus.done",
};

const tooltips: Record<AgentState, MessageKey> = {
  working: "agentStatus.workingTooltip",
  waiting: "agentStatus.waitingTooltip",
  background: "agentStatus.backgroundTooltip",
  done: "agentStatus.doneTooltip",
};

/** Die Reihenfolge der Zähler in der Statusleiste und in den Abschnitten der Agenten-Ansicht. */
export const stateOrder: AgentState[] = ["working", "waiting", "background", "done"];

/** Der Farbpunkt eines Zustands mit Kurzbeschreibung beim Überfahren. */
function Dot({ state, small = false }: { state: AgentState; small?: boolean }) {
  const t = useT();
  return (
    <span
      className={small ? `dot small ${state}` : `dot ${state}`}
      role="img"
      title={t(tooltips[state])}
      aria-label={t(tooltips[state])}
    />
  );
}

/**
 * Der Farbpunkt für den Agentenstatus des Tabs. Bei „unbekannt“ erscheint
 * stattdessen `fallback`.
 */
export function AgentDot({
  statuses,
  tabId,
  fallback,
}: {
  statuses: AgentStatuses;
  tabId: string;
  fallback: ReactNode;
}) {
  const status = useAgentStatuses(statuses).get(tabId);
  return status ? <Dot state={status.state} /> : fallback;
}

/** Die Laufzeit seit `since`; zählt sichtbar weiter, bis `until` sie anhält. */
function Runtime({ since, until = null }: { since: number; until?: number | null }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (until !== null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since, until]);
  const { key, values } = duration((until ?? now) - since);
  return <small>{t(key, values)}</small>;
}

/** Wie viele Subagenten eine Karte zeigt, bis „+ N weitere“ sie aufklappt. */
const VISIBLE_SUBAGENTS = 3;

/**
 * Der Abschnitt „Subagenten“ auf der Karte eines Agenten: je Subagent
 * Farbpunkt, Beschreibung und Laufzeit, Typ und letzte Aktion im Tooltip.
 * Wartende stehen vor arbeitenden, diese vor fertigen. Von mehr als
 * {@link VISIBLE_SUBAGENTS} Subagenten zeigt „+ N weitere“ den Rest
 * (`showsAll`). Der Pfeil an der Überschrift klappt den Abschnitt zu einer
 * Zusammenfassung ein (`collapsed`). Jede Zeile ist ein Knopf, der wie ein
 * Klick auf die Karte wirkt, Pfeil und „weitere“ nicht. Ohne Subagenten
 * erscheint nichts.
 */
export function SubagentSection({
  subagents,
  collapsed,
  onToggleCollapsed,
  showsAll,
  onToggleShowsAll,
}: {
  subagents: readonly SubagentStatus[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  showsAll: boolean;
  onToggleShowsAll: () => void;
}) {
  const t = useT();
  if (subagents.length === 0) return null;
  const ordered = subagentsInOrder(subagents);
  const shown = showsAll ? ordered : ordered.slice(0, VISIBLE_SUBAGENTS);
  const hidden = ordered.length - shown.length;
  return (
    <span className="subagents">
      <span className="subagents-head">
        <button
          className="toggle"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "agent.subagents.expand" : "agent.subagents.collapse")}
          title={t(collapsed ? "agent.subagents.expand" : "agent.subagents.collapse")}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {collapsed ? <Summary parts={subagentSummary(t, subagents)} /> : t("agent.subagents")}
      </span>
      {!collapsed &&
        shown.map((subagent) => (
          // Ohne eigenen Klick: Er geht an die Karte und wählt ihr Terminal.
          <button
            key={subagent.id}
            className={`subagent ${subagent.state}`}
            title={subagentTooltip(subagent)}
          >
            <Dot state={subagent.state} small />
            <span className="description">{subagentLabel(subagent)}</span>
            <Runtime since={subagent.started} until={subagent.ended} />
          </button>
        ))}
      {!collapsed && ordered.length > VISIBLE_SUBAGENTS && (
        <button
          className="more"
          onClick={(event) => {
            event.stopPropagation();
            onToggleShowsAll();
          }}
        >
          {showsAll
            ? t("agent.subagents.less")
            : t("agent.subagents.more", { count: String(hidden) })}
        </button>
      )}
    </span>
  );
}

/**
 * Der Abschnitt „Hintergrundaufgaben“ auf der Karte eines Agenten, unter den
 * Subagenten und in ihrem Stil: je laufender Aufgabe ein kleiner Ring, die
 * Beschreibung (ohne sie der Befehl), der Befehl im Tooltip und die Laufzeit
 * seit `started`. Jede Zeile ist ein Knopf, der wie ein Klick auf die Karte
 * wirkt. Ohne laufende Aufgaben erscheint nichts.
 */
export function BackgroundTaskSection({ tasks }: { tasks: readonly BackgroundTaskStatus[] }) {
  const t = useT();
  if (tasks.length === 0) return null;
  return (
    <span className="subagents background-tasks">
      <span className="subagents-head">{t("agent.backgroundTasks")}</span>
      {tasks.map((task) => (
        // Ohne eigenen Klick: Er geht an die Karte und wählt ihr Terminal.
        <button
          key={task.id}
          className="subagent background-task"
          title={task.command ?? undefined}
        >
          {/* Ohne eigenen Tooltip: Über der ganzen Zeile steht der Befehl. */}
          <span className="dot small background" aria-hidden="true" />
          <span className="description">{task.description ?? task.command ?? task.kind}</span>
          <Runtime since={task.started} />
        </button>
      ))}
    </span>
  );
}

/** Die Zusammenfassung eingeklappter Subagenten, Teile durch „·“ getrennt. */
function Summary({ parts }: { parts: readonly SummaryPart[] }) {
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && " · "}
      <span className={part.state ?? undefined}>{part.text}</span>
    </Fragment>
  ));
}

/**
 * Die Kopfzeile einer Karte der Agenten-Ansicht: Farbpunkt, Name und
 * Laufzeit. Mit `kicker` steht der Name klein über dem Auftrag, als
 * „AGENT“ oder als eigener Name.
 */
export function AgentCardTop({
  status,
  name,
  kicker,
}: {
  status?: AgentStatus;
  name: string;
  kicker?: "agent" | "named";
}) {
  return (
    <span className={kicker ? `top kicker ${kicker}` : "top"}>
      {status ? <Dot state={status.state} /> : <span className="dot" />}
      <span className="name">{name}</span>
      {status && <Runtime since={status.since} />}
    </span>
  );
}

/** Zustand und letzte Aktion eines Agenten auf seiner Karte. */
export function AgentCardStatus({ status }: { status: AgentStatus }) {
  const t = useT();
  return (
    <>
      <span className={`state ${status.state}`}>{t(labels[status.state])}</span>
      {status.lastAction && (
        <span className="last" title={status.lastAction}>
          {status.lastAction}
        </span>
      )}
    </>
  );
}

/** Die Zahl der wartenden Agenten am Symbol der Agenten-Ansicht. */
export function WaitingBadge({ statuses }: { statuses: AgentStatuses }) {
  const t = useT();
  const { waiting } = countStates(useAgentStatuses(statuses).values());
  if (waiting === 0) return null;
  const text = plural(t, waiting, ...counters.waiting);
  return (
    <span className="badge" title={text} aria-label={text}>
      {waiting}
    </span>
  );
}

/** Die Zähler für arbeitende, wartende und fertige Agenten in der Statusleiste. */
export function AgentCounters({ statuses }: { statuses: AgentStatuses }) {
  const t = useT();
  const counts = countStates(useAgentStatuses(statuses).values());
  return (
    <>
      {stateOrder
        .filter((state) => counts[state] > 0)
        .map((state) => (
          <span key={state} className="agent-count">
            <span className={`dot ${state}`} />
            {plural(t, counts[state], ...counters[state])}
          </span>
        ))}
    </>
  );
}
