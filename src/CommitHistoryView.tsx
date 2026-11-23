import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  PAGE_SIZE,
  appendPage,
  commitDate,
  commitTime,
  historyMayHaveChanged,
  reloadCount,
  sameCommitFile,
  summaryOf,
  type Commit,
  type CommitFile,
  type ShownCommitFile,
} from "./commitHistory";
import { useLanguage, useT } from "./i18n/i18n";
import { projectName } from "./project";
import { watchProjectFiles } from "./projectFiles";
import { historyRepository, repositoriesOf } from "./repositories";
import {
  loadCommitFiles,
  loadCommits,
  useVersionControls,
  useVersionControlsSnapshot,
} from "./versionControl";
import { ChangeRow } from "./ChangeRow";
import { GitError } from "./VersionControlView";
import type { VersionControlError } from "./versionControlState";

/**
 * Die Spalte „Verlauf“ rechts im Tab „Versionskontrolle“: die letzten Commits
 * des aktuellen Branches. Es gibt einen Verlauf für alle Repositories des
 * Fensters; ab zweien wählt eine Auswahl im Kopf, welches er zeigt. Ohne
 * eigene Wahl zeigt er das Repository des aktiven Projekts. Ohne Repository
 * erscheint er nicht.
 */
export function CommitHistory() {
  const t = useT();
  const controls = useVersionControls();
  const { projects, active, historyChoice } = useVersionControlsSnapshot();
  const repositories = repositoriesOf(projects);
  const project = historyRepository(
    repositories.map((entry) => entry.project),
    historyChoice,
    active,
  );
  const entry = repositories.find((candidate) => candidate.project === project);
  if (!entry || entry.snapshot.state?.kind !== "repository") return null;
  const { state, commitFile } = entry.snapshot;
  return (
    <div className="vc-history">
      <div className="side-title">
        <span className="vc-history-title">{t("versionControl.history.title")}</span>
        {repositories.length > 1 && (
          <select
            className="vc-history-repository"
            aria-label={t("versionControl.history.repository")}
            value={historyChoice === entry.project ? entry.project : ""}
            // Die leere Wahl folgt wieder dem aktiven Tab.
            onChange={(event) => controls.chooseHistory(event.target.value || null)}
          >
            <option value="">
              {t("versionControl.history.followActive", {
                project: projectName(
                  historyRepository(
                    repositories.map((other) => other.project),
                    null,
                    active,
                  )!,
                ),
              })}
            </option>
            {repositories.map(({ project }) => (
              <option key={project} value={project} title={project}>
                {projectName(project)}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* Mit dem Repository beginnt der Verlauf von vorn. */}
      <CommitList
        key={entry.project}
        project={entry.project}
        head={state.commit}
        branch={state.branch}
        commitFile={commitFile}
        onShowCommitFile={(shown) => controls.showCommitFile(entry.project, shown)}
      />
    </div>
  );
}

/** Was der Verlauf geladen hat. */
interface Loaded {
  commits: Commit[];
  /** Es gibt keine älteren Commits mehr. */
  ended: boolean;
}

/** Die Dateien eines Commits oder warum sie sich nicht lesen ließen. */
type Files = CommitFile[] | VersionControlError;

/**
 * Die Liste der Commits. Sie liest sich neu, sobald sich der aktuelle Commit
 * oder Branch ändert (`head`, `branch`) oder Git seine Verweise schreibt
 * (Push, Pull, Fetch), und lädt ältere Commits nach, wenn ihr Ende in Sicht
 * kommt.
 */
function CommitList({
  project,
  head,
  branch,
  commitFile,
  onShowCommitFile,
}: {
  project: string;
  head: string | null;
  branch: string | null;
  /** Die Datei eines Commits, deren Diff der Tab gerade zeigt. */
  commitFile: ShownCommitFile | null;
  onShowCommitFile: (shown: ShownCommitFile) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<VersionControlError | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, Files>>({});
  const body = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  // Nur die Antwort auf die jüngste Anfrage zählt.
  const request = useRef(0);
  const current = useRef(loaded);
  useLayoutEffect(() => {
    current.current = loaded;
  });

  const reloading = useRef(0);

  const reload = useCallback(() => {
    const id = (request.current += 1);
    reloading.current = id;
    const count = reloadCount(current.current?.commits.length ?? 0);
    loadCommits(project, 0, count)
      .then(
        (commits) => {
          if (request.current !== id) return;
          setLoaded({ commits, ended: commits.length < count });
          setError(null);
        },
        (reason: VersionControlError) => {
          if (request.current === id) setError(reason);
        },
      )
      .finally(() => {
        if (reloading.current === id) reloading.current = 0;
      });
  }, [project]);

  const loadMore = useCallback(() => {
    const before = current.current;
    // Wird gerade neu gelesen, kommt danach ohnehin die nächste Prüfung.
    if (!before || before.ended || reloading.current) return;
    const id = (request.current += 1);
    loadCommits(project, before.commits.length, PAGE_SIZE).then(
      (page) => {
        if (request.current === id) setLoaded(appendPage(before.commits, page, PAGE_SIZE));
      },
      (reason: VersionControlError) => {
        if (request.current === id) setError(reason);
      },
    );
  }, [project]);

  // Commit oder Branch-Wechsel, auch im Terminal: Der Zustand nennt einen anderen Commit.
  useEffect(reload, [reload, head, branch]);

  // Push, Pull und Fetch ändern den Zustand nicht unbedingt, wohl aber die Verweise in `.git`.
  useEffect(() => {
    let timer: number | undefined;
    const stop = watchProjectFiles(project, (changes) => {
      if (!historyMayHaveChanged(changes)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 300);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [project, reload]);

  // Kommt das Ende der Liste in Sicht, folgen ältere Commits. Nach jedem
  // Laden wird neu geprüft, falls die Liste die Spalte noch nicht füllt.
  useEffect(() => {
    if (!loaded || loaded.ended || error || !end.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: body.current, rootMargin: "200px" },
    );
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [loaded, error, loadMore]);

  function toggle(commit: Commit) {
    if (expanded === commit.id) {
      setExpanded(null);
      return;
    }
    setExpanded(commit.id);
    // Ein Commit ändert sich nicht; seine Dateien werden nur einmal gelesen.
    if (Array.isArray(files[commit.id])) return;
    loadCommitFiles(project, commit.id).then(
      (list) => setFiles((known) => ({ ...known, [commit.id]: list })),
      (reason: VersionControlError) => setFiles((known) => ({ ...known, [commit.id]: reason })),
    );
  }

  const now = Date.now();
  const unpushed = t("versionControl.history.unpushed");

  return (
    <div className="side-body" ref={body}>
      {error && <GitError error={error} />}
      {loaded?.commits.length === 0 && !error && (
        <p className="hint">{t("versionControl.history.empty")}</p>
      )}
      <div role="list">
        {loaded?.commits.map((commit) => {
          const open = expanded === commit.id;
          const changed = files[commit.id];
          return (
            <div key={commit.id} role="listitem" className={open ? "commit open" : "commit"}>
              <div
                className="commit-row"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                title={commit.message}
                onClick={() => toggle(commit)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  toggle(commit);
                }}
              >
                <span className="commit-summary">{summaryOf(commit.message)}</span>
                <small>
                  <span className="commit-author">{commit.author}</span>
                  <span title={commitDate(commit.time, language)}>
                    {commitTime(commit.time, now, language)}
                  </span>
                  {!commit.pushed && <span className="pill">{unpushed}</span>}
                </small>
              </div>
              {open && (
                <div className="commit-details">
                  <pre className="commit-message">{commit.message}</pre>
                  <div className="commit-meta">
                    {commit.id.slice(0, 7)} · {commit.author} · {commitDate(commit.time, language)}
                  </div>
                  {changed &&
                    (Array.isArray(changed) ? (
                      <CommitFiles
                        files={changed}
                        isShown={(file) => sameCommitFile(commitFile, commit, file)}
                        onShow={(file) => onShowCommitFile({ commit, file })}
                      />
                    ) : (
                      <GitError error={changed} />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div ref={end} />
    </div>
  );
}

/** Die Dateien, die ein Commit geändert hat; ein Klick zeigt den Diff im Tab. */
function CommitFiles({
  files,
  isShown,
  onShow,
}: {
  files: CommitFile[];
  isShown: (file: CommitFile) => boolean;
  onShow: (file: CommitFile) => void;
}) {
  const t = useT();
  if (files.length === 0) return <p className="hint">{t("versionControl.history.noFiles")}</p>;
  return (
    <div role="list">
      {files.map((file) => (
        <ChangeRow
          key={file.path}
          file={file}
          selected={isShown(file)}
          onShow={() => onShow(file)}
        />
      ))}
    </div>
  );
}
