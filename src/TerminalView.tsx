import { useEffect, useRef, type MouseEvent } from "react";
import type { Tab } from "./arrangement";
import type { RunningTerminal } from "./runningTerminals";
import type { WindowAgents } from "./windowAgents";

/**
 * Zeigt das Terminal eines Tabs an; wie es startet, entscheiden die Agenten
 * des Fensters. Mit `focused` erhält es die Tastatureingaben, erneut bei
 * jedem neuen `focusRequest`. Ein Rechtsklick meldet sich über `onContextMenu`.
 */
export function TerminalView({
  agents,
  tab,
  project,
  focused,
  focusRequest,
  onContextMenu,
}: {
  agents: WindowAgents<RunningTerminal>;
  tab: Tab;
  /** Der Ordner des Projekts. */
  project: string;
  focused: boolean;
  focusRequest: number;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { id } = tab;
  const terminal = useRef<RunningTerminal | null>(null);

  // Nur das Terminal des Tabs zählt, nicht wie sich der Tab später ändert:
  // Neu eingehängt würde das Terminal seinen Fokus verlieren.
  useEffect(() => {
    const element = host.current!;
    const shown = agents.terminal(tab, project);
    terminal.current = shown;
    shown.attach(element);
    return () => shown.detach(element);
  }, [agents, id, project]);

  // Erst nach dem Einhängen: Ein Terminal außerhalb des Dokuments nimmt keinen Fokus an.
  useEffect(() => {
    if (focused) terminal.current?.focus();
  }, [focused, focusRequest, id]);

  return <div className="terminal-view" ref={host} onContextMenu={onContextMenu} />;
}
