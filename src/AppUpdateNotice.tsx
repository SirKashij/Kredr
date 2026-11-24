import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  AppUpdate,
  downloadingText,
  failureSentence,
  showsIcon,
  showsNotice,
  type AppUpdateState,
} from "./appUpdate";
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

  if (state.phase === "downloading") {
    const title = downloadingText(t, state);
    return (
      <div className="app-update downloading" title={title} role="img" aria-label={title}>
        <ProgressRing progress={state.progress} />
        <svg viewBox="0 0 24 24">
          <path d="M12 16V6M7.5 10.5 12 6l4.5 4.5M7 19h10" />
        </svg>
      </div>
    );
  }

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

/** Umfang des Rings um das Symbol: Kreis mit Radius 20 im Rahmen 48 × 48. */
const RING = 2 * Math.PI * 20;

/** Der Fortschritt des Downloads als Ring; ohne bekannte Größe ein Viertel, das kreist. */
function ProgressRing({ progress }: { progress: number | null }) {
  const filled = progress === null ? 0.25 : progress / 100;
  return (
    <svg
      className={progress === null ? "ring indeterminate" : "ring"}
      viewBox="0 0 48 48"
      aria-hidden
    >
      <circle className="track" cx="24" cy="24" r="20" />
      <circle
        className="value"
        cx="24"
        cy="24"
        r="20"
        strokeDasharray={RING}
        strokeDashoffset={RING * (1 - filled)}
      />
    </svg>
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
      return (
        <PinnedNotice
          actions={[{ label: t("appUpdate.hide"), run: () => void update.later(), link: true }]}
        >
          {downloadingText(t, state)}
          <div
            className={state.progress === null ? "progress indeterminate" : "progress"}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.progress ?? undefined}
          >
            <div style={{ width: `${state.progress ?? 100}%` }} />
          </div>
        </PinnedNotice>
      );
    case "installing":
      return <PinnedNotice actions={[]}>{t("appUpdate.installing", version)}</PinnedNotice>;
    case "failed":
      return <FailedNotice update={update} state={state} />;
    default:
      return null;
  }
}

/**
 * Der Hinweis nach einem Fehlschlag: „Erneut versuchen“ startet Download und
 * Installation neu, „Mehr Infos“ nennt den Grund in einem Satz und klappt den
 * Originaltext auf.
 */
function FailedNotice({ update, state }: { update: AppUpdate; state: AppUpdateState }) {
  const t = useT();
  const [moreInfo, setMoreInfo] = useState(false);
  return (
    <PinnedNotice
      actions={[
        { label: t("appUpdate.retry"), run: () => void update.updateNow() },
        { label: t("appUpdate.later"), run: () => void update.later() },
        { label: t("appUpdate.moreInfo"), run: () => setMoreInfo((open) => !open), link: true },
      ]}
    >
      <strong>{t("appUpdate.failed")}</strong>
      {moreInfo && (
        <div className="details">
          {failureSentence(t, state)}
          {state.error && (
            <details>
              <summary>{t("appUpdate.originalError")}</summary>
              <pre>{state.error}</pre>
            </details>
          )}
        </div>
      )}
    </PinnedNotice>
  );
}
