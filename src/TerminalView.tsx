import { useEffect, useRef } from "react";
import type { RunningTerminals } from "./runningTerminals";

/**
 * Zeigt das Terminal eines Tabs an; die Shell startet im Ordner `cwd`,
 * mit `agent` samt einem Agenten.
 * Mit `focused` erhält es die Tastatureingaben, erneut bei jedem neuen
 * `focusRequest`.
 */
export function TerminalView({
  terminals,
  tabId,
  cwd,
  agent,
  focused,
  focusRequest,
}: {
  terminals: RunningTerminals;
  tabId: string;
  cwd: string;
  agent: boolean;
  focused: boolean;
  focusRequest: number;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current!;
    const terminal = terminals.get(tabId, cwd, agent);
    terminal.attach(element);
    return () => terminal.detach(element);
  }, [terminals, tabId, cwd, agent]);

  // Erst nach dem Einhängen: Ein Terminal außerhalb des Dokuments nimmt keinen Fokus an.
  useEffect(() => {
    if (focused) terminals.get(tabId, cwd, agent).focus();
  }, [focused, focusRequest, terminals, tabId, cwd, agent]);

  return <div className="terminal-view" ref={host} />;
}
