import type { Shell, Tab } from "./arrangement";
import type { MessageKey, Translate } from "./i18n/i18n";

const shellNames: Record<Shell, MessageKey> = {
  powershell: "terminal.powershell",
  gitBash: "terminal.gitBash",
};

export function shellLabel(shell: Shell | undefined, t: Translate): string {
  return t(shellNames[shell ?? "powershell"]);
}

/** Was am Tab eines Terminals steht: sein eigener Name, sonst der seiner Shell. */
export function tabLabel(tab: Tab, t: Translate): string {
  return tab.name ?? shellLabel(tab.shell, t);
}
