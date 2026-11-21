import { useT } from "./i18n/i18n";
import { useVersionControl } from "./versionControl";
import { operationLabels, syncCounts } from "./versionControlState";

/**
 * Der Stand gegenüber GitHub in der Statusleiste: wie viele Commits noch
 * nicht gepusht sind und wie viele GitHub voraus ist. Während eines
 * Abgleichs dreht sich davor ein Zeichen.
 */
export function SyncStatus() {
  const t = useT();
  const { state, busy } = useVersionControl();
  if (state?.kind !== "repository") return null;
  const counts = syncCounts(state);
  const spinner = busy !== null && (
    <span className="spinner" role="status" aria-label={t(operationLabels[busy])} />
  );
  if (counts === null) {
    // Ohne Branch gibt es nichts, was sich auf GitHub anlegen ließe.
    if (state.branch === null) return null;
    return (
      <span className="sync" title={t("status.unpublishedTooltip")}>
        {spinner}
        {t("status.unpublished")}
      </span>
    );
  }
  const ahead = String(counts.ahead);
  const behind = String(counts.behind);
  return (
    <span className="sync" title={t("status.sync", { ahead, behind })}>
      {spinner}
      <span className={counts.ahead > 0 ? "pending" : undefined}>↑ {ahead}</span>
      <span className={counts.behind > 0 ? "pending" : undefined}>↓ {behind}</span>
    </span>
  );
}
