import type { Statuses } from "./agentStatus";
import type { Translate } from "./i18n/i18n";

/**
 * Nach einer Benachrichtigung erscheint so lange keine weitere. Agenten, die
 * in dieser Zeit zu warten beginnen, kommen danach zusammen in eine einzige.
 */
export const QUIET_MS = 5_000;

/** Was ein Fenster über seine wartenden Agenten und seine Benachrichtigungen weiß. */
export interface Alerts {
  /** Seit wann jeder wartende Agent wartet; daran fällt ein neuer Wechsel auf. */
  readonly waitingSince: ReadonlyMap<string, number>;
  /**
   * Die Tabs der Agenten, die zu warten begannen, seit das Fenster zuletzt im
   * Vordergrund war, in der Reihenfolge ihres Wartens.
   */
  readonly unattended: readonly string[];
  /** Ob davon noch einer ungemeldet ist. */
  readonly pending: boolean;
  /** Vor diesem Zeitpunkt erscheint keine weitere Benachrichtigung. */
  readonly quietUntil: number;
}

export const noAlerts: Alerts = {
  waitingSince: new Map(),
  unattended: [],
  pending: false,
  quietUntil: 0,
};

export interface Situation {
  /** Der Agentenstatus des Fensters. */
  statuses: Statuses;
  /** Ob das Fenster im Vordergrund ist. */
  foreground: boolean;
  /** Der Schalter „Benachrichtigungen“ der Einstellungen. */
  enabled: boolean;
  /** Die aktuelle Zeit (Millisekunden wie `Date.now()`). */
  now: number;
}

export interface Decision {
  alerts: Alerts;
  /**
   * Die Tabs der Agenten, die die Benachrichtigung jetzt nennt; der erste
   * wartet am längsten. `null`: Es erscheint keine.
   */
  notify: readonly string[] | null;
  /** Wann erneut zu entscheiden ist, auch wenn sich bis dahin nichts ändert. */
  checkAgainAt: number | null;
}

/**
 * Entscheidet, ob sich Kredr jetzt wegen wartender Agenten meldet. Aufzurufen
 * bei jeder Änderung der Lage und zum Zeitpunkt `checkAgainAt`.
 */
export function decide(alerts: Alerts, situation: Situation): Decision {
  const { statuses, foreground, enabled, now } = situation;
  const waitingSince = new Map<string, number>();
  for (const [tabId, status] of statuses) {
    if (status.state === "waiting") waitingSince.set(tabId, status.since);
  }
  // Was der Nutzer vor Augen hat oder nicht gemeldet haben will, gilt als gesehen.
  if (foreground || !enabled) {
    return {
      alerts: { waitingSince, unattended: [], pending: false, quietUntil: alerts.quietUntil },
      notify: null,
      checkAgainAt: null,
    };
  }

  const started = [...waitingSince]
    .filter(([tabId, since]) => alerts.waitingSince.get(tabId) !== since)
    .sort(([, a], [, b]) => a - b)
    .map(([tabId]) => tabId);
  const unattended = [
    ...alerts.unattended.filter((tabId) => waitingSince.has(tabId) && !started.includes(tabId)),
    ...started,
  ];
  const pending = unattended.length > 0 && (alerts.pending || started.length > 0);
  if (pending && now >= alerts.quietUntil) {
    return {
      alerts: { waitingSince, unattended, pending: false, quietUntil: now + QUIET_MS },
      notify: unattended,
      checkAgainAt: null,
    };
  }
  return {
    alerts: { waitingSince, unattended, pending, quietUntil: alerts.quietUntil },
    notify: null,
    checkAgainAt: pending ? alerts.quietUntil : null,
  };
}

/** Der Text der Benachrichtigung für die Terminals mit diesen Namen. */
export function alertBody(terminals: readonly string[], t: Translate): string {
  if (terminals.length === 1) return t("notification.waiting.one", { terminal: terminals[0] });
  return t("notification.waiting.many", {
    count: String(terminals.length),
    // Unbenannte Agenten heißen alle gleich; ihr Name steht nur einmal da.
    terminals: [...new Set(terminals)].join(", "),
  });
}
