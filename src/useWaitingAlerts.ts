import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { AgentStatuses } from "./agentStatus";
import { decide, noAlerts } from "./waitingAlerts";

interface WaitingAlerts {
  statuses: AgentStatuses;
  /** Der Schalter „Benachrichtigungen“ der Einstellungen; er gilt nur der Windows-Benachrichtigung. */
  enabled: boolean;
  /** Titel und Text der Benachrichtigung für die Agenten in diesen Tabs. */
  describe: (tabIds: readonly string[]) => { title: string; body: string };
  /** Der Nutzer hat die Benachrichtigung angeklickt; sie führt zu diesem Tab. */
  onSelect: (tabId: string) => void;
}

/**
 * Meldet wartende Agenten dieses Fensters am Taskleisten-Symbol und, wenn
 * eingeschaltet, mit einer Windows-Benachrichtigung. Wann, entscheidet `decide`; hier kommen nur
 * Agentenstatus, Vordergrund und Uhr zusammen.
 */
export function useWaitingAlerts({ statuses, enabled, describe, onSelect }: WaitingAlerts) {
  const alerts = useRef(noAlerts);
  // Bis Windows es anders meldet, gilt das Fenster als im Vordergrund.
  const foreground = useRef(true);
  const latest = useRef({ describe, onSelect });
  useLayoutEffect(() => {
    latest.current = { describe, onSelect };
  });

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      const decision = decide(alerts.current, {
        statuses: statuses.snapshot(),
        foreground: foreground.current,
        enabled,
        now: Date.now(),
      });
      alerts.current = decision.alerts;
      if (decision.checkAgainAt !== null) {
        timer = window.setTimeout(check, decision.checkAgainAt - Date.now());
      }
      if (!decision.notify) return;
      const tabId = decision.notify[0];
      const { notification } = decision;
      // Scheitert das Melden, bleiben Tab und Agenten-Ansicht der Hinweis.
      invoke("waiting_alert", {
        ...latest.current.describe(decision.notify),
        tabId,
        notification,
      }).catch(() => {});
    };
    const attend = (focused: boolean) => {
      foreground.current = focused;
      if (focused) invoke("waiting_alert_clear").catch(() => {});
      check();
    };

    const unsubscribe = statuses.subscribe(check);
    const listening = appWindow.onFocusChanged((event) => attend(event.payload));
    appWindow
      .isFocused()
      .then(attend)
      .catch(() => {});
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      listening.then((stop) => stop());
    };
  }, [statuses, enabled]);

  useEffect(() => {
    const listening = getCurrentWindow().listen<string>("waiting-agent-selected", (event) =>
      latest.current.onSelect(event.payload),
    );
    return () => {
      listening.then((stop) => stop());
    };
  }, []);
}
