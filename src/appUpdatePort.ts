import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { AppUpdatePort, AppUpdateState, CheckResult } from "./appUpdate";
import type { Translate } from "./i18n/translate";
import { openUrl } from "./openExternally";
import { NO_REASONS, SILENT_WINDOW, updateQuestion, type UpdateReasons } from "./updateReasons";
import { pollAllWindows } from "./windowPoll";

/**
 * Was der Port vor der Installation braucht: die Rundfrage über alle
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

/**
 * Der Port zum Kern, der die Aktualisierung für alle Fenster hält. In der
 * Entwicklungsfassung spielt der Kern sie auf Wunsch vor
 * (`KREDR_SIMULATED_UPDATE`, `KREDR_SIMULATED_FAILURE`).
 */
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
