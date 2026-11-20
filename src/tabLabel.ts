import type { Tab } from "./arrangement";
import type { MessageKey, Translate } from "./i18n/i18n";
import type { Shell } from "./settingsStore";

const shellNames: Record<Shell, MessageKey> = {
  powershell: "terminal.powershell",
  gitBash: "terminal.gitBash",
};

export function shellLabel(shell: Shell | undefined, t: Translate): string {
  return t(shellNames[shell ?? "powershell"]);
}

/**
 * Was am Tab eines Terminals steht: sein eigener Name, sonst „Agent“ oder
 * der Name seiner Shell.
 */
export function tabLabel(tab: Tab, t: Translate): string {
  return tab.name ?? (tab.agent ? t("agent.name") : shellLabel(tab.shell, t));
}
