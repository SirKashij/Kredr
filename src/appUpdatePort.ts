import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { AppUpdatePort, AppUpdateState, CheckResult } from "./appUpdate";
import type { Translate } from "./i18n/translate";
import { openUrl } from "./openExternally";
import { updateQuestion } from "./updateReasons";

/**
 * Der Port zum Kern, der die Aktualisierung für alle Fenster hält und
 * führt. `t` liefert die Sprache dieses Fensters für den Dialog der
 * Rückfrage; er gehört diesem Fenster, damit er mit ihm endet. In der
 * Entwicklungsfassung spielt der Kern die Aktualisierung auf Wunsch vor
 * (`KREDR_SIMULATED_UPDATE`, `KREDR_SIMULATED_FAILURE`).
 */
export function coreAppUpdatePort(t: () => Translate): AppUpdatePort {
  return {
    window: () => getCurrentWindow().label,
    current: () => invoke<AppUpdateState>("app_update_state"),
    check: () => invoke<CheckResult>("app_update_check"),
    onChange: (listener) => {
      listen<AppUpdateState>("app-update-changed", (event) => listener(event.payload)).catch(
        () => {},
      );
    },
    updateNow: () => invoke("app_update_now"),
    confirm: (reasons) =>
      confirm(updateQuestion(t(), reasons), {
        title: t()("appUpdate.confirm.title"),
        kind: "warning",
        okLabel: t()("appUpdate.confirm.ok"),
        cancelLabel: t()("appUpdate.later"),
      }),
    answer: (proceed) => invoke("app_update_answer", { proceed }),
    cancel: () => invoke("app_update_cancel"),
    fail: (error) => invoke<boolean>("app_update_fail", { error }),
    later: () => invoke("app_update_later"),
    openUrl,
  };
}
