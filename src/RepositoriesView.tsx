import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { Arrangement } from "./arrangement";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { plural, useT } from "./i18n/i18n";
import { projectName } from "./project";
import {
  isRepositoryCollapsed,
  isRepositoryHidden,
  repositoriesOf,
  revealRepository,
  toggleRepositoryCollapsed,
  toggleRepositoryHidden,
} from "./repositories";
import { moreIcon, SectionButton } from "./SectionButton";
import {
  RepositoryScope,
  useVersionControl,
  useVersionControlStore,
  useVersionControlsSnapshot,
  type ProjectVersionControl,
} from "./versionControl";
import {
  branchLabel,
  canCommit,
  canPull,
  canPush,
  changedFileCount,
  syncCounts,
  type ChangedFile,
} from "./versionControlState";
import { GitError, VersionControlView } from "./VersionControlView";
import type { WindowContent } from "./workspace";

interface RepositoriesViewProps {
  content: WindowContent;
  /** Die Aufteilung; sie merkt sich ausgeblendete und zugeklappte Repositories. */
  arrangement: Arrangement;
  /** Zeigt den Diff einer Änderung des Projekts im Tab „Versionskontrolle“. */
  onShowChange: (project: string, file: ChangedFile) => void;
  /** Ändert die Aufteilung, etwa um ein Repository auszublenden. */
  onArrange: (change: (arrangement: Arrangement) => Arrangement) => void;
  onAddProject: () => void;
  onRemoveProject: (folder: string) => void;
}

/**
 * Die Versionskontrolle in der Seitenleiste, für alle Projekte des Fensters.
 * Projekte ohne Git fehlen. Mit einem Repository sieht sie aus wie für ein
 * einzelnes Projekt; ab zwei stehen oben „Repositories“ und darunter ein
 * aufklappbarer Abschnitt je Repository mit eigenem Commit-Feld (wie VS Code).
 */
export function RepositoriesView({
  content,
  arrangement,
  onShowChange,
  onArrange,
  onAddProject,
  onRemoveProject,
}: RepositoriesViewProps) {
  const t = useT();
  const { projects } = useVersionControlsSnapshot();
  const [menu, setMenu] = useState<{ x: number; y: number; project: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const sections = useRef(new Map<string, HTMLElement>());
  /** Das Repository, zu dessen Abschnitt nach dem Zeichnen gesprungen wird. */
  const [jump, setJump] = useState<{ project: string } | null>(null);

  useEffect(() => {
    if (jump) sections.current.get(jump.project)?.scrollIntoView?.({ block: "start" });
  }, [jump]);

  const repositories = repositoriesOf(projects);
  const single = (entry: ProjectVersionControl) => (
    <RepositoryScope store={entry.store}>
      <VersionControlView onShowChange={(file) => onShowChange(entry.project, file)} />
    </RepositoryScope>
  );

  if (repositories.length === 0) {
    // Ein einzelnes Projekt erklärt selbst, warum es keine Versionskontrolle hat.
    if (content.kind !== "workspace") return projects[0] ? single(projects[0]) : null;
    if (projects.some((entry) => entry.snapshot.state === null)) return null;
    const missing = projects.find(
      (entry) =>
        entry.snapshot.state?.kind === "unavailable" &&
        entry.snapshot.state.reason === "gitMissing",
    )?.snapshot.state;
    if (missing?.kind === "unavailable") return <GitError error={missing} />;
    return <p className="hint">{t("versionControl.noRepositoryInWorkspace")}</p>;
  }
  if (repositories.length === 1) return single(repositories[0]);

  const openMenu = (project: string) => (event: MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, project });
  };

  return (
    <div className="repositories">
      <div className="sect repositories-title">{t("versionControl.repositories")}</div>
      <div role="list" className="repo-list">
        {repositories.map((entry) => (
          <RepositoryRow
            key={entry.project}
            entry={entry}
            hidden={isRepositoryHidden(arrangement, entry.project)}
            onJump={() => {
              onArrange((current) => revealRepository(current, entry.project));
              setJump({ project: entry.project });
            }}
            onToggleHidden={() =>
              onArrange((current) => toggleRepositoryHidden(current, entry.project))
            }
            onContextMenu={openMenu(entry.project)}
          />
        ))}
      </div>
      {repositories
        .filter((entry) => !isRepositoryHidden(arrangement, entry.project))
        .map((entry) => (
          <RepositoryScope key={entry.project} store={entry.store}>
            <RepositorySection
              project={entry.project}
              collapsed={isRepositoryCollapsed(arrangement, entry.project)}
              element={(element) => {
                if (element) sections.current.set(entry.project, element);
                else sections.current.delete(entry.project);
              }}
              onToggle={() =>
                onArrange((current) => toggleRepositoryCollapsed(current, entry.project))
              }
              onShowChange={(file) => onShowChange(entry.project, file)}
              onMenu={(x, y) => setMenu({ x, y, project: entry.project })}
              onContextMenu={openMenu(entry.project)}
            />
          </RepositoryScope>
        ))}
      {menu && (
        <RepositoryMenu
          {...menu}
          content={content}
          onAddProject={onAddProject}
          onRemoveProject={onRemoveProject}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/**
 * Eine Zeile unter „Repositories“: Name, Branch, Stand gegenüber GitHub und
 * Zahl der Änderungen. Ein Klick springt zum Abschnitt, das Auge blendet ihn
 * aus und wieder ein.
 */
function RepositoryRow({
  entry,
  hidden,
  onJump,
  onToggleHidden,
  onContextMenu,
}: {
  entry: ProjectVersionControl;
  hidden: boolean;
  onJump: () => void;
  onToggleHidden: () => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const t = useT();
  const { project, snapshot } = entry;
  const name = projectName(project);
  const branch = branchLabel(snapshot.state);
  const counts = syncCounts(snapshot.state);
  const syncText = counts
    ? t("versionControl.repository.sync", {
        ahead: String(counts.ahead),
        behind: String(counts.behind),
      })
    : undefined;
  const count = changedFileCount(snapshot.state);
  const countText = plural(
    t,
    count,
    "versionControl.changeCount.one",
    "versionControl.changeCount.other",
  );
  const eye = t(hidden ? "versionControl.repository.show" : "versionControl.repository.hide", {
    project: name,
  });
  return (
    <div
      role="listitem"
      className={hidden ? "repo-row hidden" : "repo-row"}
      onClick={onJump}
      onContextMenu={onContextMenu}
    >
      <button className="repo-name" title={project}>
        {name}
      </button>
      {branch !== null && (
        <span className="repo-branch" title={branch}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="7" cy="5" r="2.2" />
            <circle cx="7" cy="19" r="2.2" />
            <circle cx="17" cy="9" r="2.2" />
            <path d="M7 7.2v9.6M17 11.2c0 3-4 3.3-10 4.3" />
          </svg>
          {branch}
        </span>
      )}
      {counts && (
        <span className="repo-sync" role="img" aria-label={syncText} title={syncText}>
          {counts.ahead}↑ {counts.behind}↓
        </span>
      )}
      <span className="repo-count" title={countText}>
        {count}
      </span>
      <button
        className="repo-eye"
        title={eye}
        aria-label={eye}
        aria-pressed={!hidden}
        onClick={(event) => {
          // Das Auge springt nicht zum Abschnitt.
          event.stopPropagation();
          onToggleHidden();
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
          <circle cx="8" cy="8" r="2" />
          {hidden && <path d="M2.5 13.5 13.5 2.5" />}
        </svg>
      </button>
    </div>
  );
}

/**
 * Der Abschnitt eines Repositorys: im Kopf Commit, Synchronisieren und „…“
 * für genau dieses Repository, darunter Commit-Feld und Änderungen.
 */
function RepositorySection({
  project,
  collapsed,
  element,
  onToggle,
  onShowChange,
  onMenu,
  onContextMenu,
}: {
  project: string;
  collapsed: boolean;
  element: (element: HTMLElement | null) => void;
  onToggle: () => void;
  onShowChange: (file: ChangedFile) => void;
  onMenu: (x: number, y: number) => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const t = useT();
  const store = useVersionControlStore();
  const { state, message, busy } = useVersionControl();
  const name = projectName(project);
  const publishes = state?.kind === "repository" && state.upstream === null;
  const classes = ["agent-section", "repo-section", collapsed && "collapsed"];
  return (
    <section className={classes.filter(Boolean).join(" ")} ref={element}>
      <div className="agent-section-head" onContextMenu={onContextMenu}>
        <button
          className="agent-section-toggle"
          aria-expanded={!collapsed}
          title={project}
          onClick={onToggle}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" />
          </svg>
          <span className="agent-section-name">{name}</span>
        </button>
        <span className="agent-section-actions">
          <SectionButton
            label={t("versionControl.repository.commit", { project: name })}
            disabled={!canCommit(state, message, busy)}
            onClick={() => void store.commit()}
            path="m3 8.5 3 3 7-7"
          />
          <SectionButton
            // Gibt es den Branch auf GitHub noch nicht, legt der Knopf ihn an (wie VS Code).
            label={t(
              publishes
                ? "versionControl.repository.publish"
                : "versionControl.repository.syncAction",
              { project: name },
            )}
            disabled={publishes ? !canPush(state, busy) : !canPull(state, busy)}
            onClick={() => void (publishes ? store.push() : store.pullAndPush())}
            path="M13 8a5 5 0 0 1-9 3M3 8a5 5 0 0 1 9-3M12 2v3H9M4 14v-3h3"
          />
          <SectionButton
            label={t("explorer.more")}
            popup
            onClick={(bounds) => onMenu(bounds.left, bounds.bottom)}
            {...moreIcon}
          />
        </span>
      </div>
      {!collapsed && <VersionControlView onShowChange={onShowChange} />}
    </section>
  );
}

/** Das Menü „…“ eines Repositorys: Abgleich und die Befehle für sein Projekt. */
function RepositoryMenu({
  x,
  y,
  project,
  content,
  onAddProject,
  onRemoveProject,
  onClose,
}: {
  x: number;
  y: number;
  project: string;
  content: WindowContent;
  onAddProject: () => void;
  onRemoveProject: (folder: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { projects } = useVersionControlsSnapshot();
  const entry = projects.find((candidate) => candidate.project === project);
  if (!entry) return null;
  const { store, snapshot } = entry;
  const { state, message, busy } = snapshot;
  const items: MenuItem[] = [];
  if (canCommit(state, message, busy)) {
    items.push({
      label: t("versionControl.commitAndPush"),
      onSelect: () => void store.commitAndPush(),
    });
  }
  if (canPull(state, busy)) {
    items.push({ label: t("versionControl.pull"), onSelect: () => void store.pull() });
  }
  if (canPush(state, busy)) {
    items.push({ label: t("versionControl.push"), onSelect: () => void store.push() });
  }
  items.push({
    label: t("workspace.addProject"),
    separator: items.length > 0,
    onSelect: onAddProject,
  });
  if (content.kind === "workspace") {
    items.push({ label: t("workspace.removeProject"), onSelect: () => onRemoveProject(project) });
  }
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
