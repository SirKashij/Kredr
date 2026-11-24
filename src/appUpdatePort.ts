import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { AppUpdatePort, AppUpdateState } from "./appUpdate";
import type { Translate } from "./i18n/i18n";
import { openUrl } from "./openExternally";
import { NO_REASONS, SILENT_WINDOW, updateQuestion, type UpdateReasons } from "./updateReasons";
import { pollAllWindows } from "./windowPoll";

/**
 * Was jeder Port vor der Installation braucht: die Rundfrage über alle
 * Fenster und die Rückfrage. `t` liefert die Sprache dieses Fensters.
 */
function beforeInstall(
  t: () => Translate,
): Pick<AppUpdatePort, "reasons" | "confirm" | "saveArrangements"> {
  return {
    reasons: async () => {
      const windows = await pollAllWindows<UpdateReasons>("updateReasons");
      return windows.map((reasons) => (reasons ? { ...NO_REASONS, ...reasons } : SILENT_WINDOW));
    },
    confirm: (reasons) =>
      confirm(updateQuestion(t(), reasons), {
        title: t()("appUpdate.confirm.title"),
        kind: "warning",
        okLabel: t()("appUpdate.confirm.ok"),
        cancelLabel: t()("appUpdate.later"),
      }),
    saveArrangements: async () => {
      await pollAllWindows("saveArrangement");
    },
  };
}

/** Der Port zum Kern, der die Aktualisierung für alle Fenster hält. */
export function coreAppUpdatePort(t: () => Translate): AppUpdatePort {
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
    ...beforeInstall(t),
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
 * fragt wie die echte Aktualisierung alle Fenster nach Anlässen, „lädt“ und
 * „installiert“ sie und kehrt dann zum Angebot zurück, statt neu zu starten.
 * Den Zustand hält nur das Fenster, das ihn benutzt.
 */
export function simulatedAppUpdatePort(version: string, t: () => Translate): AppUpdatePort {
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
    ...beforeInstall(t),
  };
}

/** Der Port dieses Fensters: in der Entwicklungsfassung auf Wunsch vorgespielt. */
export function appUpdatePort(t: () => Translate): AppUpdatePort {
  if (import.meta.env.DEV) {
    let simulated: string | null = null;
    try {
      simulated = localStorage.getItem(SIMULATED_VERSION_KEY);
    } catch {
      // Ohne Speicher spielt nichts vor.
    }
    if (simulated) return simulatedAppUpdatePort(simulated, t);
  }
  return coreAppUpdatePort(t);
}
