import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  offersActions,
  type AppUpdatePort,
  type AppUpdateState,
  type CheckResult,
  type FailureCause,
} from "./appUpdate";
import type { Translate } from "./i18n/translate";
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
    check: () => invoke<CheckResult>("app_update_check"),
    onChange: (listener) => {
      listen<AppUpdateState>("app-update-changed", (event) => listener(event.payload)).catch(
        () => {},
      );
    },
    ask: () => invoke<boolean>("app_update_ask"),
    cancel: () => invoke("app_update_cancel"),
    fail: (error) => invoke<boolean>("app_update_fail", { error }),
    download: () => invoke<boolean>("app_update_download"),
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

/**
 * Unter diesem Schlüssel nennt die Entwicklungsfassung den Grund, an dem die
 * vorgespielte Aktualisierung scheitert: `network` und `signature` beim
 * Download, `installer` bei der Installation.
 */
export const SIMULATED_FAILURE_KEY = "kredr.simulierterFehler";

/** So lange dauert die Installation im vorgespielten Ablauf. */
const SIMULATED_STEP = 1500;
/** Der vorgespielte Download wächst alle `SIMULATED_CHUNK_EVERY` ms um so viele Prozent. */
const SIMULATED_CHUNK = 10;
const SIMULATED_CHUNK_EVERY = 400;

/** Die Originaltexte des Updaters zu jedem vorgespielten Grund. */
const SIMULATED_ERRORS: Record<FailureCause, string> = {
  network:
    "error sending request for url (https://github.com/SirKashij/Kredr/releases/download/v0.6.0/Kredr_0.6.0_x64-setup.exe)",
  signature: "The signature verification failed: Signature verification failed",
  installer: "Das System kann die angegebene Datei nicht finden. (os error 2)",
  unknown: "Failed to format date",
};

/**
 * Ein Port, der eine neue Version nur vorspielt: Er bietet `version` an,
 * fragt wie die echte Aktualisierung alle Fenster nach Anlässen, „lädt“ sie,
 * fragt erneut, lässt alle Fenster ihre Aufteilung speichern, „installiert“
 * sie und kehrt dann zum Angebot zurück, statt neu zu starten.
 * Mit `failure` scheitert er an diesem Grund. Den Zustand hält nur das
 * Fenster, das ihn benutzt.
 */
export function simulatedAppUpdatePort(
  version: string,
  t: () => Translate,
  failure: FailureCause | null = null,
): AppUpdatePort {
  let state: AppUpdateState = {
    phase: "offered",
    version,
    installed: "0.5.0",
    progress: null,
    hidden: false,
    cause: null,
    error: null,
  };
  /** Der Zustand vor der Rückfrage; „Später“ in ihr kehrt zu ihm zurück. */
  let beforeConfirm = state;
  /** Ob die neue Version „geladen“ ist und auf die Installation wartet. */
  let installerReady = false;
  const listeners = new Set<(state: AppUpdateState) => void>();
  const announce = (patch: Partial<AppUpdateState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (cause: FailureCause) =>
    announce({
      phase: "failed",
      progress: null,
      hidden: false,
      cause,
      error: SIMULATED_ERRORS[cause],
    });
  return {
    current: async () => state,
    check: async () => {
      if (state.phase === "later") announce({ phase: "offered" });
      return { outcome: "found", version };
    },
    onChange: (listener) => {
      listeners.add(listener);
    },
    ask: async () => {
      if (!offersActions(state)) return false;
      beforeConfirm = state;
      announce({ phase: "confirm", hidden: state.phase === "later" });
      return true;
    },
    cancel: async () => {
      installerReady = false;
      if (state.phase === "confirm") announce(beforeConfirm);
    },
    fail: async (error) => {
      if (!["confirm", "installing"].includes(state.phase)) return false;
      installerReady = false;
      announce({ phase: "failed", progress: null, hidden: false, cause: "unknown", error });
      return true;
    },
    download: async () => {
      if (state.phase !== "confirm" || installerReady) return false;
      announce({
        phase: "downloading",
        progress: 0,
        cause: null,
        error: null,
      });
      for (let progress = SIMULATED_CHUNK; progress <= 100; progress += SIMULATED_CHUNK) {
        await wait(SIMULATED_CHUNK_EVERY);
        if (failure && failure !== "installer" && progress > 50) {
          fail(failure);
          return false;
        }
        announce({ progress });
      }
      installerReady = true;
      announce({ phase: "confirm", progress: null });
      return true;
    },
    install: async () => {
      if (state.phase !== "confirm" || !installerReady) return;
      installerReady = false;
      announce({ phase: "installing", progress: null });
      await wait(SIMULATED_STEP);
      if (failure) return fail(failure);
      announce({ phase: "offered" });
    },
    later: async () =>
      announce(state.phase === "downloading" ? { hidden: true } : { phase: "later" }),
    openUrl: (url) => console.info(`Würde ${url} öffnen.`),
    ...beforeInstall(t),
  };
}

/** Der Port dieses Fensters: in der Entwicklungsfassung auf Wunsch vorgespielt. */
export function appUpdatePort(t: () => Translate): AppUpdatePort {
  if (import.meta.env.DEV) {
    let simulated: string | null = null;
    let failure: string | null = null;
    try {
      simulated = localStorage.getItem(SIMULATED_VERSION_KEY);
      failure = localStorage.getItem(SIMULATED_FAILURE_KEY);
    } catch {
      // Ohne Speicher spielt nichts vor.
    }
    if (simulated) {
      const cause = failure && failure in SIMULATED_ERRORS ? (failure as FailureCause) : null;
      return simulatedAppUpdatePort(simulated, t, cause);
    }
  }
  return coreAppUpdatePort(t);
}
