import { fileName } from "./filePath";
import { useT } from "./i18n/i18n";
import { useVersionControl } from "./versionControl";
import {
  branchLabel,
  changedFileCount,
  changeSections,
  errorMessages,
  sameChange,
  statusLabels,
  statusLetter,
  type ChangedFile,
  type VersionControlError,
} from "./versionControlState";

/**
 * Eine Meldung der Versionskontrolle in der Sprache des Fensters. Bei einem
 * Git-Fehler lässt sich darunter der Originaltext von Git aufklappen, etwa um
 * ihn an einen Agenten weiterzugeben.
 */
export function GitError({ error }: { error: VersionControlError }) {
  const t = useT();
  // Fehlendes Git und ein Ordner ohne Repository sind Hinweise, keine Fehler.
  const expected = error.reason === "gitMissing" || error.reason === "notARepository";
  return (
    <div
      className={expected ? "git-notice" : "git-notice error"}
      role={expected ? "note" : "alert"}
    >
      <p>{t(errorMessages[error.reason])}</p>
      {!expected && (
        <details>
          <summary>{t("versionControl.error.details")}</summary>
          <pre>{error.details}</pre>
        </details>
      )}
    </div>
  );
}

/** Die Zahl der geänderten Dateien am Symbol der Versionskontrolle. */
export function ChangesBadge() {
  const t = useT();
  const count = changedFileCount(useVersionControl().state);
  if (count === 0) return null;
  const key = count === 1 ? "versionControl.changeCount.one" : "versionControl.changeCount.other";
  const text = t(key, { count: String(count) });
  return (
    <span className="badge changes" title={text} aria-label={text}>
      {count}
    </span>
  );
}

/**
 * Der aktuelle Branch in der Statusleiste; ohne Repository erscheint nichts.
 * Ein Klick öffnet die Branch-Liste zum Wechseln und Anlegen.
 */
export function BranchStatus({ onSwitch }: { onSwitch: () => void }) {
  const t = useT();
  const branch = branchLabel(useVersionControl().state);
  if (branch === null) return null;
  return (
    <button
      type="button"
      className="branch"
      title={t("branches.tooltip", { branch })}
      onClick={onSwitch}
    >
      <svg viewBox="0 0 24 24">
        <circle cx="7" cy="5" r="2.2" />
        <circle cx="7" cy="19" r="2.2" />
        <circle cx="17" cy="9" r="2.2" />
        <path d="M7 7.2v9.6M17 11.2c0 3-4 3.3-10 4.3" />
      </svg>
      {branch}
    </button>
  );
}

/** Der Ordner einer Datei, wie er neben ihrem Namen steht. */
function folderOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/**
 * Die Versionskontrolle in der Seitenleiste: alle geänderten Dateien des
 * Projekts mit ihrem Status, getrennt nach ausgewählt und nicht ausgewählt.
 * Ein Klick zeigt den Diff im Tab „Versionskontrolle“.
 */
export function VersionControlView({
  onShowChange,
}: {
  onShowChange: (file: ChangedFile) => void;
}) {
  const t = useT();
  const { state, selected } = useVersionControl();
  if (!state) return null;
  if (state.kind === "unavailable") return <GitError error={state} />;
  const { staged, unstaged } = changeSections(state);

  const section = (title: string, files: ChangedFile[]) =>
    files.length > 0 && (
      <>
        <div className="sect changes-title">
          {title}
          <span className="count">{files.length}</span>
        </div>
        <div role="list">
          {files.map((file) => {
            const status = t(statusLabels[file.status]);
            const moved = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
            return (
              <div
                key={file.path}
                role="listitem"
                className={sameChange(file, selected) ? "change-row sel" : "change-row"}
                title={`${moved} · ${status}`}
                onClick={() => onShowChange(file)}
              >
                <span className={`change-name git-${file.status}`}>{fileName(file.path)}</span>
                <span className="change-folder">{folderOf(file.path)}</span>
                <span className={`change-status git-${file.status}`} aria-label={status}>
                  {statusLetter(file.status)}
                </span>
              </div>
            );
          })}
        </div>
      </>
    );

  return (
    <div className="changes">
      {/* Über der Liste folgen Nachrichtenfeld und „Commit & Push“ (#15). */}
      {state.files.length === 0 && <p className="hint">{t("versionControl.noChanges")}</p>}
      {section(t("versionControl.stagedChanges"), staged)}
      {section(t("versionControl.changes"), unstaged)}
    </div>
  );
}
