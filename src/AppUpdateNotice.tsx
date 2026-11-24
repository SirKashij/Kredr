import { useSyncExternalStore } from "react";
import { AppUpdate, showsNotice } from "./appUpdate";
import { appUpdatePort } from "./appUpdatePort";
import { useT } from "./i18n/i18n";
import { PinnedNotice } from "./Notice";

let forThisWindow: AppUpdate | null = null;

/** Der Ablauf dieses Fensters; er hört dem Kern zu, solange das Fenster lebt. */
function windowAppUpdate(): AppUpdate {
  forThisWindow ??= new AppUpdate(appUpdatePort());
  return forThisWindow;
}

/**
 * Der Hinweis unten rechts, der eine neue Version anbietet und zeigt, wie weit
 * die Aktualisierung ist. Er erscheint in jedem Fenster; eine Aktion in einem
 * Fenster gilt für alle.
 */
export function AppUpdateNotice() {
  const t = useT();
  const update = windowAppUpdate();
  const state = useSyncExternalStore(update.subscribe, update.snapshot);
  if (!showsNotice(state) || !state.version) return null;
  const version = { version: state.version };

  switch (state.phase) {
    case "offered":
      return (
        <PinnedNotice
          actions={[
            { label: t("appUpdate.updateNow"), run: () => void update.updateNow() },
            { label: t("appUpdate.later"), run: () => void update.later() },
            {
              label: t("appUpdate.releaseNotes"),
              run: () => update.showReleaseNotes(),
              link: true,
            },
          ]}
        >
          <strong>{t("appUpdate.available", version)}</strong>
          <div className="dim">{t("appUpdate.installed", { version: state.installed })}</div>
        </PinnedNotice>
      );
    case "downloading":
      return <PinnedNotice actions={[]}>{t("appUpdate.downloading", version)}</PinnedNotice>;
    case "installing":
      return <PinnedNotice actions={[]}>{t("appUpdate.installing", version)}</PinnedNotice>;
    case "failed":
      return (
        <PinnedNotice
          actions={[
            { label: t("appUpdate.retry"), run: () => void update.updateNow() },
            { label: t("appUpdate.later"), run: () => void update.later() },
          ]}
        >
          <strong>{t("appUpdate.failed", version)}</strong>
          {state.error && <div className="details">{state.error}</div>}
        </PinnedNotice>
      );
    default:
      return null;
  }
}
