import { useEffect, type ReactNode } from "react";
import { useT } from "./i18n/i18n";

/** Eine Aktion eines stehenden Hinweises; die erste ist die vorgeschlagene. */
export interface NoticeAction {
  label: string;
  run: () => void;
  /** Als Link statt als Knopf, etwa für „Neuerungen“. */
  link?: boolean;
}

/**
 * Ein Hinweis unten rechts, der stehen bleibt, bis eine seiner Aktionen ihn
 * erledigt. Er trägt beliebig viele Aktionen, auch keine.
 */
export function PinnedNotice({
  children,
  actions,
}: {
  children: ReactNode;
  actions: NoticeAction[];
}) {
  return (
    <div className="notice pinned" role="status">
      <div className="notice-body">{children}</div>
      {actions.length > 0 && (
        <div className="notice-actions">
          {actions.map((action, index) => (
            <button
              key={action.label}
              className={action.link ? "link" : index === 0 ? "btn" : "btn ghost"}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ein kurzer Hinweis an die Person, wahlweise mit einer Aktion als Link. */
export interface NoticeContent {
  text: string;
  action?: { label: string; run: () => void };
}

/** So lange bleibt ein Hinweis stehen, wenn ihn niemand schließt (in Millisekunden). */
const VISIBLE_FOR = 8000;

/** Zeigt den Hinweis unten rechts im Fenster, bis er abläuft oder geschlossen wird. */
export function Notice({ notice, onClose }: { notice: NoticeContent; onClose: () => void }) {
  const t = useT();

  useEffect(() => {
    const timer = setTimeout(onClose, VISIBLE_FOR);
    return () => clearTimeout(timer);
  }, [notice, onClose]);

  return (
    <div className="notice" role="status">
      <p>
        {notice.text}
        {notice.action && (
          <>
            {" "}
            <button
              className="link"
              onClick={() => {
                onClose();
                notice.action!.run();
              }}
            >
              {notice.action.label}
            </button>
          </>
        )}
      </p>
      <button
        className="close"
        title={t("notice.close")}
        aria-label={t("notice.close")}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
