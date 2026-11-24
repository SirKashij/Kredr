import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AppUpdate, showsIcon, showsNotice } from "./appUpdate";
import { appUpdatePort } from "./appUpdatePort";
import { ContextMenu } from "./ContextMenu";
import { translate, useT, type Translate } from "./i18n/i18n";
import { PinnedNotice } from "./Notice";

let forThisWindow: AppUpdate | null = null;
/** Die Sprache dieses Fensters für die Rückfrage vor der Aktualisierung. */
let windowTranslate: Translate = (key, values) => translate("en", key, values);

/** Der Ablauf dieses Fensters; er hört dem Kern zu, solange das Fenster lebt. */
function windowAppUpdate(): AppUpdate {
  forThisWindow ??= new AppUpdate(appUpdatePort(() => windowTranslate));
  return forThisWindow;
}

/**
 * So kurz nach dem Schließen des Menüs gilt ein Klick auf das Symbol noch dem
 * Schließen: Das Menü schließt schon beim Drücken der Maustaste.
 */
const CLOSING_CLICK = 300;

/** Der Zustand der Aktualisierung in diesem Fenster. */
function useAppUpdate() {
  const t = useT();
  useEffect(() => {
    windowTranslate = t;
  }, [t]);
  const update = windowAppUpdate();
  const state = useSyncExternalStore(update.subscribe, update.snapshot);
  return { update, state };
}

/**
 * Das Symbol über dem Zahnrad der Aktivitätsleiste: Nach „Später“ bleibt es
 * stehen, bis aktualisiert ist. Ein Klick öffnet daneben ein Menü, aus dem
 * sich die Aktualisierung anstoßen lässt.
 */
export function AppUpdateButton() {
  const t = useT();
  const { update, state } = useAppUpdate();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // Ein Klick auf das Symbol bei offenem Menü schließt es nur.
  const closedAt = useRef(-Infinity);
  const closeMenu = useCallback(() => {
    closedAt.current = performance.now();
    setMenuAt(null);
  }, []);
  if (!showsIcon(state) || !state.version) return null;
  const version = { version: state.version };
  const title = t("appUpdate.menuTitle", version);

  return (
    <>
      <button
        className="app-update"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={(event) => {
          if (performance.now() - closedAt.current < CLOSING_CLICK) return;
          const box = event.currentTarget.getBoundingClientRect();
          setMenuAt({ x: box.right + 4, y: box.top });
        }}
      >
        <svg viewBox="0 0 24 24">
          <path d="M12 16V6M7.5 10.5 12 6l4.5 4.5M7 19h10" />
        </svg>
        <span className="badge dot" />
      </button>
      {menuAt &&
        // Außerhalb der Aktivitätsleiste, deren Regeln sonst für die Einträge gälten.
        createPortal(
          <ContextMenu
            x={menuAt.x}
            y={menuAt.y}
            onClose={closeMenu}
            header={
              <>
                <strong>{t("appUpdate.menuTitle", version)}</strong>
                <div className="dim">
                  {t("appUpdate.menuInstalled", { version: state.installed })}
                </div>
              </>
            }
            items={[
              { label: t("appUpdate.menuUpdate"), onSelect: () => void update.updateNow() },
              { label: t("appUpdate.menuNews"), onSelect: () => update.showReleaseNotes() },
            ]}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * Der Hinweis unten rechts, der eine neue Version anbietet und zeigt, wie weit
 * die Aktualisierung ist. Er erscheint in jedem Fenster; eine Aktion in einem
 * Fenster gilt für alle.
 */
export function AppUpdateNotice() {
  const t = useT();
  const { update, state } = useAppUpdate();
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
