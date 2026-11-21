import { useEffect, useRef, type MouseEvent } from "react";
import type { Tab } from "./arrangement";
import type { RunningTerminals } from "./runningTerminals";

/**
 * Zeigt das Terminal eines Tabs an; seine Shell startet im Ordner `cwd`,
 * in einem Agenten-Tab samt einem Agenten.
 * Mit `focused` erhält es die Tastatureingaben, erneut bei jedem neuen
 * `focusRequest`. Ein Rechtsklick meldet sich über `onContextMenu`.
 */
export function TerminalView({
  terminals,
  tab,
  cwd,
  focused,
  focusRequest,
  onContextMenu,
}: {
  terminals: RunningTerminals;
  tab: Tab;
  cwd: string;
  focused: boolean;
  focusRequest: number;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { id, shell } = tab;
  const agent = tab.agent ?? false;

  useEffect(() => {
    const element = host.current!;
    const terminal = terminals.get(id, { cwd, shell, agent });
    terminal.attach(element);
    return () => terminal.detach(element);
  }, [terminals, id, cwd, shell, agent]);

  // Erst nach dem Einhängen: Ein Terminal außerhalb des Dokuments nimmt keinen Fokus an.
  useEffect(() => {
    if (focused) terminals.find(id)?.focus();
  }, [focused, focusRequest, terminals, id]);

  return <div className="terminal-view" ref={host} onContextMenu={onContextMenu} />;
}
