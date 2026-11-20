import { useEffect, useRef } from "react";
import type { RunningTerminals } from "./runningTerminals";

/**
 * Zeigt das Terminal eines Tabs an; die Shell startet im Ordner `cwd`.
 * Mit `focused` erhält es die Tastatureingaben, erneut bei jedem neuen
 * `focusRequest`.
 */
export function TerminalView({
  terminals,
  tabId,
  cwd,
  focused,
  focusRequest,
}: {
  terminals: RunningTerminals;
  tabId: string;
  cwd: string;
  focused: boolean;
  focusRequest: number;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current!;
    const terminal = terminals.get(tabId, cwd);
    terminal.attach(element);
    return () => terminal.detach(element);
  }, [terminals, tabId, cwd]);

  // Erst nach dem Einhängen: Ein Terminal außerhalb des Dokuments nimmt keinen Fokus an.
  useEffect(() => {
    if (focused) terminals.get(tabId, cwd).focus();
  }, [focused, focusRequest, terminals, tabId, cwd]);

  return <div className="terminal-view" ref={host} />;
}
