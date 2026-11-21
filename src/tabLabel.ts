import type { Tab } from "./arrangement";
import type { Translate } from "./i18n/i18n";
import { shellLabels, type Shell } from "./settingsStore";

export function shellLabel(shell: Shell | undefined, t: Translate): string {
  return t(shellLabels[shell ?? "powershell"]);
}

/**
 * Was am Tab eines Terminals steht: sein eigener Name, sonst „Agent“ oder
 * der Name seiner Shell.
 */
export function tabLabel(tab: Tab, t: Translate): string {
  return tab.name ?? (tab.agent ? t("agent.name") : shellLabel(tab.shell, t));
}

/** Die Beschriftung am Tab eines Terminals, ein- oder zweizeilig. */
export interface TerminalTabLabel {
  /** Klein über der großen Zeile („Agent“); `null` bei einzeiliger Beschriftung. */
  kicker: string | null;
  /** Die große Zeile. */
  text: string;
  /** Der volle Auftrag für den Tooltip, wenn er gezeigt wird. */
  assignment: string | null;
}

/**
 * Was am Tab eines Terminals steht, wenn sein Agent den Auftrag
 * `assignment` hat und `showAssignment` aus den Einstellungen gilt.
 */
export function terminalTabLabel(
  tab: Tab,
  assignment: string | null,
  showAssignment: boolean,
  t: Translate,
): TerminalTabLabel {
  const shown = visibleAssignment(tab, assignment, showAssignment);
  if (shown === null) return { kicker: null, text: tabLabel(tab, t), assignment: null };
  // Ein eigener Name geht immer vor.
  return { kicker: t("agent.name"), text: tab.name ?? firstLine(shown), assignment: shown };
}

/** Der Auftrag, wenn Tab und Karte ihn zeigen; sonst `null`. */
export function visibleAssignment(
  tab: Tab,
  assignment: string | null,
  showAssignment: boolean,
): string | null {
  return tab.agent && showAssignment ? assignment : null;
}

/** So viele Zeichen des Auftrags passen in die große Zeile am Tab. */
const ASSIGNMENT_LIMIT = 32;

/** Die erste Zeile von `text`, gekürzt mit „…“. */
function firstLine(text: string): string {
  const line = [...(text.trim().split("\n")[0] ?? "").trim()];
  if (line.length <= ASSIGNMENT_LIMIT) return line.join("");
  return `${line.slice(0, ASSIGNMENT_LIMIT - 1).join("")}…`;
}
