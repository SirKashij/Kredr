import { confirm } from "@tauri-apps/plugin-dialog";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { fileName } from "./filePath";
import { useT } from "./i18n/i18n";
import { useVersionControl, useVersionControlStore } from "./versionControl";
import {
  branchLabel,
  canCommit,
  canPull,
  canPush,
  changedFileCount,
  changeSections,
  commitsEverything,
  errorMessages,
  offersPullAndPush,
  operationLabels,
  sameChange,
  statusLabels,
  statusLetter,
  type ChangedFile,
  type RepositoryState,
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

/** Ein kleiner Knopf an einer Zeile oder Überschrift der Liste. */
function RowAction({
  label,
  disabled,
  onAction,
  children,
}: {
  label: string;
  disabled: boolean;
  onAction: () => void;
  children: ReactNode;
}) {
  function act(event: MouseEvent) {
    // Der Klick gilt dem Knopf, nicht der Zeile darunter.
    event.stopPropagation();
    onAction();
  }
  return (
    <button
      type="button"
      className="change-action"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={act}
    >
      {children}
    </button>
  );
}

/**
 * Nachrichtenfeld und die Knöpfe zum Festschreiben und Abgleichen. Darunter
 * steht, was gerade läuft, oder warum der letzte Versuch scheiterte.
 */
function CommitBox({ state }: { state: RepositoryState }) {
  const t = useT();
  const store = useVersionControlStore();
  const { message, busy, failure } = useVersionControl();
  const commit = canCommit(state, message, busy);
  const scope = commitsEverything(state)
    ? "versionControl.commitScope.all"
    : "versionControl.commitScope.staged";

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.ctrlKey && commit) {
      event.preventDefault();
      void store.commitAndPush();
    }
  }

  return (
    <div className="commit-box">
      <textarea
        rows={3}
        value={message}
        placeholder={t("versionControl.messagePlaceholder")}
        aria-label={t("versionControl.message")}
        spellCheck={false}
        onChange={(event) => store.setMessage(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="btn"
        title={t("versionControl.commitAndPushTooltip")}
        disabled={!commit}
        onClick={() => void store.commitAndPush()}
      >
        {t("versionControl.commitAndPush")}
      </button>
      <div className="commit-more">
        <button
          type="button"
          className="btn ghost"
          title={t("versionControl.commitOnlyTooltip")}
          disabled={!commit}
          onClick={() => void store.commit()}
        >
          {t("versionControl.commitOnly")}
        </button>
        <button
          type="button"
          className="btn ghost"
          title={t("versionControl.pullTooltip")}
          disabled={!canPull(state, busy)}
          onClick={() => void store.pull()}
        >
          {t("versionControl.pull")}
        </button>
        <button
          type="button"
          className="btn ghost"
          title={t(
            state.upstream === null
              ? "versionControl.publishTooltip"
              : "versionControl.pushTooltip",
          )}
          disabled={!canPush(state, busy)}
          onClick={() => void store.push()}
        >
          {t("versionControl.push")}
        </button>
      </div>
      {busy !== null ? (
        <div className="commit-busy" role="status">
          <span className="spinner" />
          {t(operationLabels[busy])}
        </div>
      ) : (
        state.files.length > 0 && <div className="commit-scope">{t(scope)}</div>
      )}
      {failure && (
        <div className="commit-failure">
          <button
            type="button"
            className="change-action"
            title={t("versionControl.dismiss")}
            aria-label={t("versionControl.dismiss")}
            onClick={() => store.dismissFailure()}
          >
            ×
          </button>
          <GitError error={failure} />
          {offersPullAndPush(failure) && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void store.pullAndPush()}
            >
              {t("versionControl.pullAndPush")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Die Versionskontrolle in der Seitenleiste: Nachrichtenfeld mit „Commit &
 * Push“ und darunter alle geänderten Dateien des Projekts mit ihrem Status,
 * getrennt nach ausgewählt und nicht ausgewählt. Ein Klick zeigt den Diff im
 * Tab „Versionskontrolle“.
 */
export function VersionControlView({
  onShowChange,
}: {
  onShowChange: (file: ChangedFile) => void;
}) {
  const t = useT();
  const store = useVersionControlStore();
  const { state, selected, busy } = useVersionControl();
  if (!state) return null;
  if (state.kind === "unavailable") return <GitError error={state} />;
  const { staged, unstaged } = changeSections(state);
  const locked = busy !== null;

  async function discard(file: ChangedFile) {
    const name = fileName(file.path);
    const text =
      file.status === "untracked"
        ? "versionControl.discardConfirm.untracked"
        : "versionControl.discardConfirm.message";
    const confirmed = await confirm(t(text, { name }), {
      title: t("versionControl.discardConfirm.title"),
      kind: "warning",
      okLabel: t("versionControl.discardConfirm.ok"),
      cancelLabel: t("dialog.cancel"),
    });
    if (confirmed) await store.discard(file);
  }

  const section = (title: string, files: ChangedFile[], all: ReactNode) =>
    files.length > 0 && (
      <>
        <div className="sect changes-title">
          {title}
          {all}
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
                <span className="change-actions">
                  {file.staged ? (
                    <RowAction
                      label={t("versionControl.unstage")}
                      disabled={locked}
                      onAction={() => void store.unstage([file])}
                    >
                      −
                    </RowAction>
                  ) : (
                    <>
                      {file.status !== "conflicted" && (
                        <RowAction
                          label={t("versionControl.discard")}
                          disabled={locked}
                          onAction={() => void discard(file)}
                        >
                          ↶
                        </RowAction>
                      )}
                      <RowAction
                        label={t("versionControl.stage")}
                        disabled={locked}
                        onAction={() => void store.stage([file])}
                      >
                        +
                      </RowAction>
                    </>
                  )}
                </span>
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
      <CommitBox state={state} />
      {state.files.length === 0 && <p className="hint">{t("versionControl.noChanges")}</p>}
      {section(
        t("versionControl.stagedChanges"),
        staged,
        <RowAction
          label={t("versionControl.unstageAll")}
          disabled={locked}
          onAction={() => void store.unstage()}
        >
          −
        </RowAction>,
      )}
      {section(
        t("versionControl.changes"),
        unstaged,
        <RowAction
          label={t("versionControl.stageAll")}
          disabled={locked}
          onAction={() => void store.stage()}
        >
          +
        </RowAction>,
      )}
    </div>
  );
}
