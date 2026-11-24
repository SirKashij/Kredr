import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppUpdatePort, AppUpdateState } from "./appUpdate";
import { openUrl } from "./openExternally";

/** Der Port zum Kern, der die Aktualisierung für alle Fenster hält. */
export function coreAppUpdatePort(): AppUpdatePort {
  return {
    current: () => invoke<AppUpdateState>("app_update_state"),
    onChange: (listener) => {
      listen<AppUpdateState>("app-update-changed", (event) => listener(event.payload)).catch(
        () => {},
      );
    },
    install: () => invoke("app_update_install"),
    later: () => invoke("app_update_later"),
    openUrl,
  };
}

/**
 * Unter diesem Schlüssel im `localStorage` nennt die Entwicklungsfassung die
 * Version, die sie als neu vorspielt, etwa `0.6.0`. Die Entwicklungsfassung
 * sucht selbst nie nach einer neuen Version.
 */
export const SIMULATED_VERSION_KEY = "kredr.simulierteAktualisierung";

/** So lange dauern Download und Installation im vorgespielten Ablauf. */
const SIMULATED_STEP = 1500;

/**
 * Ein Port, der eine neue Version nur vorspielt: Er bietet `version` an,
 * „lädt“ und „installiert“ sie und kehrt dann zum Angebot zurück, statt neu
 * zu starten. Er gilt nur für das Fenster, das ihn benutzt.
 */
export function simulatedAppUpdatePort(version: string): AppUpdatePort {
  let state: AppUpdateState = { phase: "offered", version, installed: "0.5.0", error: null };
  const listeners = new Set<(state: AppUpdateState) => void>();
  const announce = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, SIMULATED_STEP));
  return {
    current: async () => state,
    onChange: (listener) => {
      listeners.add(listener);
    },
    install: async () => {
      announce({ phase: "downloading" });
      await wait();
      announce({ phase: "installing" });
      await wait();
      announce({ phase: "offered" });
    },
    later: async () => announce({ phase: "later" }),
    openUrl: (url) => console.info(`Würde ${url} öffnen.`),
  };
}

/** Der Port dieses Fensters: in der Entwicklungsfassung auf Wunsch vorgespielt. */
export function appUpdatePort(): AppUpdatePort {
  if (import.meta.env.DEV) {
    let simulated: string | null = null;
    try {
      simulated = localStorage.getItem(SIMULATED_VERSION_KEY);
    } catch {
      // Ohne Speicher spielt nichts vor.
    }
    if (simulated) return simulatedAppUpdatePort(simulated);
  }
  return coreAppUpdatePort();
}
