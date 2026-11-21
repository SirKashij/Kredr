import { useEffect, useState, type ReactNode } from "react";
import {
  countStates,
  duration,
  useAgentStatuses,
  type AgentState,
  type AgentStatus,
  type AgentStatuses,
} from "./agentStatus";
import { plural, useT, type MessageKey } from "./i18n/i18n";

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

/** Die Laufzeit seit `since`; zählt sichtbar weiter. */
function Runtime({ since }: { since: number }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const { key, values } = duration(now - since);
  return <small>{t(key, values)}</small>;
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
