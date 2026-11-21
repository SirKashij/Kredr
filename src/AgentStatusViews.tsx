import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  countStates,
  duration,
  subagentLabel,
  subagentsInOrder,
  subagentTooltip,
  useAgentStatuses,
  type AgentState,
  type AgentStatus,
  type AgentStatuses,
  type SubagentStatus,
} from "./agentStatus";
import { plural, useT, type MessageKey, type Translate } from "./i18n/i18n";

const labels: Record<AgentState, MessageKey> = {
  working: "agentStatus.working",
  waiting: "agentStatus.waiting",
  done: "agentStatus.done",
};

const tooltips: Record<AgentState, MessageKey> = {
  working: "agentStatus.workingTooltip",
  waiting: "agentStatus.waitingTooltip",
  done: "agentStatus.doneTooltip",
};

/** Die Texte der Zähler, je für genau einen und für mehrere Agenten. */
const counters: Record<AgentState, [one: MessageKey, other: MessageKey]> = {
  working: ["agentStatus.count.working.one", "agentStatus.count.working.other"],
  waiting: ["agentStatus.count.waiting.one", "agentStatus.count.waiting.other"],
  done: ["agentStatus.count.done.one", "agentStatus.count.done.other"],
};

/** Die Reihenfolge der Zähler in der Statusleiste. */
const states: AgentState[] = ["working", "waiting", "done"];

/** Der Farbpunkt eines Zustands mit Kurzbeschreibung beim Überfahren. */
function Dot({ state }: { state: AgentState }) {
  const t = useT();
  return (
    <span
      className={`dot ${state}`}
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

/** Ein Teil der Zusammenfassung; mit `state` in der Farbe dieses Zustands. */
export interface SummaryPart {
  text: string;
  state: AgentState | null;
}

/**
 * Die Zusammenfassung eingeklappter Subagenten, etwa „6 Subagenten · 3
 * arbeiten“: die Anzahl, dann die wartenden und die arbeitenden, ohne beide
 * „alle fertig“.
 */
export function subagentSummary(t: Translate, subagents: readonly SubagentStatus[]): SummaryPart[] {
  const counts: Record<AgentState, number> = { working: 0, waiting: 0, done: 0 };
  for (const { state } of subagents) counts[state]++;
  const parts: SummaryPart[] = [
    {
      text: plural(t, subagents.length, "agent.subagents.count.one", "agent.subagents.count.other"),
      state: null,
    },
  ];
  for (const state of ["waiting", "working"] as const) {
    if (counts[state] > 0)
      parts.push({ text: plural(t, counts[state], ...counters[state]), state });
  }
  if (parts.length === 1) parts.push({ text: t("agent.subagents.allDone"), state: null });
  return parts;
}

/**
 * Der Abschnitt „Subagenten“ auf der Karte eines Agenten: je Subagent
 * Farbpunkt, Beschreibung und Laufzeit, Typ und letzte Aktion im Tooltip.
 * Wartende stehen vor arbeitenden, diese vor fertigen. Von mehr als drei
 * Subagenten zeigt „+ N weitere“ den Rest. Der Pfeil an der Überschrift
 * klappt den Abschnitt zu einer Zusammenfassung ein. Ein Klick auf eine
 * Zeile wirkt wie ein Klick auf die Karte, Pfeil und „weitere“ nicht. Ohne
 * Subagenten erscheint nichts.
 */
export function SubagentSection({
  subagents,
  collapsed,
  onToggleCollapsed,
}: {
  subagents: readonly SubagentStatus[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (subagents.length === 0) return null;
  const ordered = subagentsInOrder(subagents);
  const shown = all ? ordered : ordered.slice(0, VISIBLE_SUBAGENTS);
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
          <span
            key={subagent.id}
            className={`subagent ${subagent.state}`}
            title={subagentTooltip(subagent)}
          >
            <span className={`dot small ${subagent.state}`} />
            <span className="description">{subagentLabel(subagent)}</span>
            <Runtime since={subagent.started} until={subagent.ended} />
          </span>
        ))}
      {!collapsed && (hidden > 0 || all) && ordered.length > VISIBLE_SUBAGENTS && (
        <button
          className="more"
          onClick={(event) => {
            event.stopPropagation();
            setAll(!all);
          }}
        >
          {all ? t("agent.subagents.less") : t("agent.subagents.more", { count: String(hidden) })}
        </button>
      )}
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
  const { waiting } = countStates(useAgentStatuses(statuses));
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
  const counts = countStates(useAgentStatuses(statuses));
  return (
    <>
      {states
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
