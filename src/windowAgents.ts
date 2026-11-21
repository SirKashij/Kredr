/**
 * Die Agenten des Fensters: was nötig ist, damit ein Agent mit seinem
 * Gespräch zurückkommt. Das Modul baut aus einem Tab den Start seines
 * Terminals, empfängt die Signale seines Agenten und gibt sie an den
 * Agentenstatus und an die Aufteilung weiter. Die Aufteilung selbst hält
 * es nicht; es ändert sie nur über `change`.
 */

import type { AgentStatuses, Statuses, StatusUpdate } from "./agentStatus";
import {
  endAgent,
  recordConversation,
  tabsOf,
  type Arrangement,
  type Conversation,
  type Tab,
} from "./arrangement";
import type { AgentSignals, TerminalStart } from "./runningTerminals";
import type { Settings } from "./settingsStore";

/** Die Terminals eines Fensters, soweit die Agenten sie brauchen, nach der Kennung ihres Tabs. */
export interface AgentTerminals<T> {
  /** Das Terminal des Tabs, falls es schon eines gibt. */
  find(tabId: string): T | undefined;
  /**
   * Legt das Terminal des Tabs an. Seine Shell startet mit `start` beim
   * ersten Anzeigen oder mit `startNow`; was sein Agent meldet, geht an `signals`.
   */
  open(tabId: string, start: TerminalStart, signals: AgentSignals): T;
  /** Startet die Shell des Tabs sofort, auch wenn er gerade verdeckt ist. */
  startNow(tabId: string): void;
}

/** Was die Agenten des Fensters zum Entstehen brauchen. */
export interface WindowAgentsOptions<T> {
  /** Darüber starten die Tabs, und darüber kommen die Signale ihrer Agenten. */
  terminals: AgentTerminals<T>;
  /** Nimmt den Agentenstatus der Terminals auf. */
  statuses: AgentStatuses;
  /** Wendet eine Operation auf die Aufteilung an; in der App `setArrangement`. */
  change: (op: (arrangement: Arrangement) => Arrangement) => void;
  /** Die aktuellen Einstellungen. */
  settings: () => Pick<Settings, "resumeAgents" | "defaultShell">;
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

/**
 * Ob der Agent des Tabs als beim Schließen unterbrochen gilt: Er arbeitete,
 * als das Fenster schloss, und hat sich seit dem Fortsetzen noch nicht gemeldet.
 */
export function isInterrupted(tab: Tab, statuses: Statuses): boolean {
  return !statuses.has(tab.id) && tab.conversation?.working === true;
}

/**
 * Die Agenten eines Fensters. `T` ist das Terminal, das `AgentTerminals`
 * liefert: in der App ein `RunningTerminal`, im Test eine Fälschung.
 */
export class WindowAgents<T> {
  private readonly terminals: AgentTerminals<T>;
  private readonly statuses: AgentStatuses;
  private readonly change: WindowAgentsOptions<T>["change"];
  private readonly settings: WindowAgentsOptions<T>["settings"];

  constructor(options: WindowAgentsOptions<T>) {
    this.terminals = options.terminals;
    this.statuses = options.statuses;
    this.change = options.change;
    this.settings = options.settings;
  }

  /**
   * Das Terminal des Tabs; gibt es noch keines, entsteht es mit Ordner, Shell
   * und Gespräch des Tabs. Nur das Gespräch beim Entstehen zählt: Es
   * entscheidet, ob der Agent es fortsetzt. Spätere Gespräche ändern den Tab,
   * ohne das Terminal neu zu starten.
   */
  terminal(tab: Tab, project: string): T {
    return this.terminals.find(tab.id) ?? this.open(tab, project);
  }

  /** Startet jeden Tab der gespeicherten Aufteilung, der ein Gespräch hat, sofort; er setzt es fort. */
  resumeAll(stored: Arrangement, project: string) {
    for (const tab of tabsOf(stored)) {
      if (!tab.conversation) continue;
      this.terminal(tab, project);
      this.terminals.startNow(tab.id);
    }
  }

  /**
   * Die Tabs, deren Agenten beim nächsten Öffnen mit ihrem Gespräch
   * zurückkommen; ohne die Einstellung `resumeAgents` keiner.
   */
  returning(arrangement: Arrangement): string[] {
    if (!this.settings().resumeAgents) return [];
    return tabsOf(arrangement).flatMap((tab) => (tab.conversation ? [tab.id] : []));
  }

  /** Ob Schließen einen Agenten unterbräche: Er kommt zurück, arbeitet aber gerade. */
  closingInterrupts(arrangement: Arrangement): boolean {
    const statuses = this.statuses.snapshot();
    return this.returning(arrangement).some((tabId) => statuses.get(tabId)?.state === "working");
  }

  private open(tab: Tab, project: string): T {
    const start: TerminalStart = {
      cwd: tab.cwd ?? project,
      shell: tab.shell ?? this.settings().defaultShell,
      agent: tab.agent ?? false,
      resume: tab.conversation,
    };
    const tabId = tab.id;
    return this.terminals.open(tabId, start, {
      onStatus: (update) => {
        // Claude Code fand das Gespräch nicht; die Shell läuft ohne Agenten weiter.
        if (update.resumeFailed) return this.endAgent(tabId);
        this.statuses.report(tabId, update);
        // Das Gespräch wird gespeichert, sobald Kredr es kennt, nicht erst beim Schließen.
        this.change((current) => recordConversation(current, tabId, conversationOf(update)));
      },
      onOpened: (agentStarted) => {
        // Ohne `claude` im Startbefehl lässt sich das Gespräch nicht fortsetzen.
        if (start.resume && !agentStarted) this.endAgent(tabId);
      },
    });
  }

  /** Der Tab wird ein gewöhnliches Terminal am selben Platz. */
  private endAgent(tabId: string) {
    this.change((current) => endAgent(current, tabId));
  }
}
