import { useEffect, useRef } from "react";
import type { TerminalSessions } from "./terminalSessions";

/**
 * Zeigt das Terminal eines Tabs an; die Shell startet im Ordner `cwd`.
 * Mit `focused` erhält es die Tastatureingaben, erneut bei jedem neuen
 * `focusRequest`.
 */
export function TerminalView({
  sessions,
  tabId,
  cwd,
  focused,
  focusRequest,
}: {
  sessions: TerminalSessions;
  tabId: string;
  cwd: string;
  focused: boolean;
  focusRequest: number;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current!;
    const session = sessions.get(tabId, cwd);
    session.attach(element);
    return () => session.detach(element);
  }, [sessions, tabId, cwd]);

  // Erst nach dem Einhängen: Ein Terminal außerhalb des Dokuments nimmt keinen Fokus an.
  useEffect(() => {
    if (focused) sessions.get(tabId, cwd).focus();
  }, [focused, focusRequest, sessions, tabId, cwd]);

  return <div className="terminal-view" ref={host} />;
}
