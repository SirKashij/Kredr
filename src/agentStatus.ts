import { useSyncExternalStore } from "react";
import type { Conversation } from "./arrangement";
import type { MessageKey } from "./i18n/i18n";

/** Die Zustände eines erkannten Agenten; ohne Eintrag ist der Status „unbekannt“. */
export type AgentState = "working" | "done" | "waiting";

/** Der Agentenstatus eines Terminals. */
export interface AgentStatus {
  state: AgentState;
  /** Was der Agent zuletzt getan, gefragt oder gesagt hat. */
  lastAction: string | null;
  /** Seit wann der Zustand gilt (Millisekunden wie `Date.now()`). */
  since: number;
  /** Die Subagenten des Agenten in der Reihenfolge ihres Starts. */
  subagents: readonly SubagentStatus[];
}

/** Die Zustände eines Subagenten. */
export type SubagentState = "working" | "waiting" | "done";

/** Ein Subagent, wie der Kern ihn meldet. */
export interface SubagentUpdate {
  /** Die Kennung, mit der Claude Code ihn meldet; eindeutig je Agent. */
  id: string;
  /** Sein Typ, etwa `Explore`. */
  kind: string;
  /** Die Beschreibung, die der Agent ihm mitgegeben hat, falls bekannt. */
  description: string | null;
  state: SubagentState;
  /** Was der Subagent zuletzt getan oder am Ende gesagt hat. */
  lastAction: string | null;
}

/** Ein Subagent in der Agenten-Ansicht. */
export interface SubagentStatus extends SubagentUpdate {
  /** Seit wann er bekannt ist (Millisekunden wie `Date.now()`). */
  started: number;
  /** Wann er fertig wurde; `null`, solange er arbeitet oder wartet. */
  ended: number | null;
}

/** Was eine Zeile eines Subagenten nennt: die Beschreibung, ohne sie den Typ. */
export function subagentLabel(subagent: SubagentUpdate): string {
  return subagent.description ?? subagent.kind;
}

/** Der Tooltip einer Zeile eines Subagenten: Typ und letzte Aktion. */
export function subagentTooltip(subagent: SubagentUpdate): string {
  return [subagent.kind, subagent.lastAction].filter(Boolean).join(" · ");
}

/** Die Subagenten nach `update`; Zeitpunkte bekannter Subagenten bleiben. */
function nextSubagents(
  previous: readonly SubagentStatus[],
  update: readonly SubagentUpdate[],
  now: number,
): SubagentStatus[] {
  const known = new Map(previous.map((subagent) => [subagent.id, subagent]));
  return update.map((subagent) => {
    const before = known.get(subagent.id);
    const started = before?.started ?? now;
    const ended = subagent.state === "done" ? (before?.ended ?? now) : null;
    return { ...subagent, started, ended };
  });
}

/** Was der Kern bei jeder Änderung des Agentenstatus eines Terminals meldet. */
export interface StatusUpdate {
  state: AgentState | "unknown";
  lastAction: string | null;
  /** Ob sich der Zustand geändert hat und nicht nur die letzte Aktion. */
  stateChanged: boolean;
  /** Der erste Prompt seit dem Start des Agenten oder dem letzten Leeren des Gesprächs. */
  assignment: string | null;
  /** Die Kennung des laufenden Gesprächs; `null`, sobald der Agent sich beendet hat. */
  conversation: string | null;
  /** Ob sich das Gespräch, mit dem der Agent startete, nicht fortsetzen ließ. */
  resumeFailed: boolean;
  /** Die laufenden und die seit dem letzten Prompt der Person fertigen Subagenten. */
  subagents: readonly SubagentUpdate[];
}

/**
 * Das Gespräch, das sich die Aufteilung nach der Meldung `update` merkt,
 * samt Auftrag und ob der Agent gerade arbeitet. Ohne Gespräch `undefined`.
 */
export function conversationOf(update: StatusUpdate): Conversation | undefined {
  if (update.conversation === null) return undefined;
  const conversation: Conversation = { agent: "claudeCode", id: update.conversation };
  if (update.assignment) conversation.assignment = update.assignment;
  if (update.state === "working") conversation.working = true;
  return conversation;
}

/** Der Agentenstatus aller Terminals eines Fensters, nach der Kennung ihres Tabs. */
export type Statuses = ReadonlyMap<string, AgentStatus>;

/**
 * Hält den Agentenstatus der Terminals eines Fensters. Jede Änderung ergibt
 * einen neuen Stand und benachrichtigt die Abonnenten.
 */
export class AgentStatuses {
  private statuses: Statuses = new Map();
  private readonly listeners = new Set<() => void>();

  /** Der aktuelle Stand; er wird nie verändert, nur ersetzt. */
  snapshot = (): Statuses => this.statuses;

  /** Ruft `listener` nach jeder Änderung auf; liefert die Abmeldung. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Übernimmt eine Meldung des Kerns für das Terminal des Tabs. */
  report(tabId: string, update: StatusUpdate, now = Date.now()) {
    const next = new Map(this.statuses);
    if (update.state === "unknown") {
      if (!next.delete(tabId)) return;
    } else {
      const previous = this.statuses.get(tabId);
      const since = previous?.state === update.state ? previous.since : now;
      const subagents = nextSubagents(previous?.subagents ?? [], update.subagents, now);
      next.set(tabId, { state: update.state, lastAction: update.lastAction, since, subagents });
    }
    this.replace(next);
  }

  /** Vergisst den Status aller Tabs, die es nicht mehr gibt. */
  retain(tabIds: ReadonlySet<string>) {
    const next = new Map([...this.statuses].filter(([tabId]) => tabIds.has(tabId)));
    if (next.size !== this.statuses.size) this.replace(next);
  }

  private replace(statuses: Statuses) {
    this.statuses = statuses;
    for (const listener of this.listeners) listener();
  }
}

/** Der Agentenstatus des Fensters; zeichnet die Komponente bei jeder Änderung neu. */
export function useAgentStatuses(statuses: AgentStatuses): Statuses {
  return useSyncExternalStore(statuses.subscribe, statuses.snapshot);
}

/** Wie viele Agenten arbeiten, auf Eingabe warten und fertig sind. */
export function countStates(statuses: Statuses): Record<AgentState, number> {
  const counts = { working: 0, waiting: 0, done: 0 };
  for (const { state } of statuses.values()) counts[state]++;
  return counts;
}

/** Eine Laufzeit von `milliseconds` als Text der Sprachdatei samt Werten. */
export function duration(milliseconds: number): {
  key: MessageKey;
  values: Record<string, string>;
} {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return { key: "duration.seconds", values: { count: String(seconds) } };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "duration.minutes", values: { count: String(minutes) } };
  return {
    key: "duration.hours",
    values: { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) },
  };
}
