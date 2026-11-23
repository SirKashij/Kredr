import { message } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { views, type View } from "./ActivityBar";
import {
  countStates,
  stateCounters,
  useAgentStatuses,
  type AgentStatuses,
  type Statuses,
} from "./agentStatus";
import { AgentCardStatus, AgentCardTop, stateOrder, SubagentSection } from "./AgentStatusViews";
import { focusedGroupOf, isTerminal, tabsOf, type Arrangement, type Tab } from "./arrangement";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Explorer } from "./Explorer";
import { copyText, errorMessage, revealEntry } from "./fileOperations";
import { plural, useT } from "./i18n/i18n";
import { projectName } from "./project";
import { RepositoriesView } from "./RepositoriesView";
import { SearchView, type SearchViewProps } from "./SearchView";
import { moreIcon, SectionButton } from "./SectionButton";
import { useSettings } from "./settings";
import { tabLabel, visibleAssignment } from "./tabLabel";
import type { ChangedFile } from "./versionControlState";
import { isInterrupted } from "./windowAgents";
import { agentSections, isSectionCollapsed, projectsOf, type WindowContent } from "./workspace";

/** Zwischen diesen Breiten lässt sich die Seitenleiste ziehen (in Pixeln). */
const MIN_WIDTH = 170;
/** So viel Breite bleibt dem Hauptbereich mindestens. */
const MIN_MAIN_WIDTH = 300;

interface AgentsViewProps {
  arrangement: Arrangement;
  /** Der Agentenstatus der Terminals des Fensters. */
  statuses: AgentStatuses;
  /** Zeigt den Tab im Hauptbereich an und gibt ihm den Fokus. */
  onSelectTab: (tabId: string) => void;
  /** Öffnet ein Terminal und startet darin einen Agenten; fehlt ohne Projekt. */
  onNewAgent?: () => void;
  /** Öffnet ein gewöhnliches Terminal; fehlt ohne Projekt. */
  onNewTerminal?: () => void;
  /** Klappt den Abschnitt des Projekts zu oder auf; `null` steht für „Außerhalb der Projekte“. */
  onToggleSection: (project: string | null) => void;
}

/** Was die Agenten-Ansicht zusätzlich von der Seitenleiste bekommt. */
interface AgentsViewContext {
  content: WindowContent;
  onOpenTerminalIn: (folder: string, agent: boolean) => void;
  onAddProject: () => void;
  onRemoveProject: (folder: string) => void;
}

/** Wie die Agenten ihre Subagenten zeigen, nach Tab. */
interface SubagentFolding {
  /** Die Agenten, deren Subagenten eingeklappt sind. */
  collapsed: TabSet;
  /** Die Agenten, die mit „+ N weitere“ alle Subagenten zeigen. */
  showingAll: TabSet;
}

/** Eine Menge von Tabs samt Umschalten eines Tabs. */
interface TabSet {
  has: (tabId: string) => boolean;
  toggle: (tabId: string) => void;
}

/**
 * Eine Menge von Tabs, die nur im Speicher lebt: Sie gehört nicht zur
 * Aufteilung und wird nicht gespeichert. Geschlossene Tabs fallen heraus.
 */
function useTabSet(arrangement: Arrangement): TabSet {
  const [tabIds, setTabIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const open = new Set(tabsOf(arrangement).map((tab) => tab.id));
    setTabIds((current) =>
      [...current].every((tabId) => open.has(tabId))
        ? current
        : new Set([...current].filter((tabId) => open.has(tabId))),
    );
  }, [arrangement]);
  return {
    has: (tabId) => tabIds.has(tabId),
    toggle: (tabId) =>
      setTabIds((current) => {
        const next = new Set(current);
        if (!next.delete(tabId)) next.add(tabId);
        return next;
      }),
  };
}

interface SidebarProps extends AgentsViewProps {
  view: View;
  /** Ob die Seitenleiste eingeblendet ist. Ausgeblendet behält sie ihren Zustand. */
  visible: boolean;
  /** Der Ordner des ersten Projekts dieses Fensters; ihm folgen Suche und Versionskontrolle. */
  project: string | null;
  /** Was das Fenster zeigt; der Explorer zeigt alle Projekte. */
  content: WindowContent;
  /** Fügt dem Fenster ein weiteres Projekt hinzu. */
  onAddProject: () => void;
  /** Nimmt das Projekt mit diesem Ordner aus dem Workspace. */
  onRemoveProject: (folder: string) => void;
  /** Setzt das Projekt im Workspace an die Stelle `index` (gezählt vor dem Verschieben). */
  onMoveProject: (folder: string, index: number) => void;
  /** Gibt dem Workspace einen neuen Namen. */
  onRenameWorkspace: (name: string) => void;
  /** Steigt, wenn der Name des Workspace bearbeitet werden soll. */
  renameRequest: number;
  /** „Workspace schließen“: Das Fenster zeigt danach die Startseite. */
  onCloseWorkspace: () => void;
  /** Ob gerade ein Ordner aus dem Windows-Explorer über der Seitenleiste schwebt. */
  folderDrop: boolean;
  /** Öffnet ein Terminal in diesem Ordner, mit `agent` samt einem Agenten. */
  onOpenTerminalIn: (folder: string, agent: boolean) => void;
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe. */
  activeFile: string | null;
  /** Öffnet eine Datei des Projekts als Dateiansicht, mit `preview` als Vorschau-Tab. */
  onOpenFile: (path: string, preview: boolean) => void;
  /** Öffnet eine Datei an einer Fundstelle der Suche. */
  onOpenMatch: SearchViewProps["onOpenFile"];
  /** Steigt, wenn die Suche aufgerufen wird. */
  searchFocus: number;
  /** Zeigt den Diff einer Änderung des Projekts im Tab „Versionskontrolle“. */
  onShowChange: (project: string, file: ChangedFile) => void;
  /** Ändert, welche Repositories ausgeblendet oder zugeklappt sind; das gehört zur Aufteilung. */
  onArrangeRepositories: (change: (arrangement: Arrangement) => Arrangement) => void;
}

export function Sidebar({
  view,
  visible,
  project,
  content,
  onAddProject,
  onRemoveProject,
  onMoveProject,
  onRenameWorkspace,
  renameRequest,
  onCloseWorkspace,
  folderDrop,
  onOpenTerminalIn,
  activeFile,
  onOpenFile,
  onOpenMatch,
  searchFocus,
  onShowChange,
  onArrangeRepositories,
  ...agents
}: SidebarProps) {
  const t = useT();
  const [width, setWidth] = useState(280);
  // Hier statt in der Agenten-Ansicht, damit beides einen Wechsel der
  // Ansicht übersteht.
  const collapsed = useTabSet(agents.arrangement);
  const showingAll = useTabSet(agents.arrangement);
  const sidebar = useRef<HTMLElement>(null);
  const title = views.find(({ id }) => id === view)!.label;
  // Dieselbe Liste, solange sich der Fensterinhalt nicht ändert: Die Suche beginnt sonst neu.
  const projects = useMemo(() => projectsOf(content), [content]);
  const showsExplorer = view === "explorer" && content.kind !== "startPage";
  const showsSearch = view === "search" && project !== null;

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const left = sidebar.current!.getBoundingClientRect().left;
    const widest = Math.max(MIN_WIDTH, window.innerWidth - left - MIN_MAIN_WIDTH);
    setWidth(Math.min(widest, Math.max(MIN_WIDTH, event.clientX - left)));
  }

  return (
    <aside
      className={folderDrop ? "sidebar folder-drop" : "sidebar"}
      data-drop-label={t("workspace.dropFolder")}
      ref={sidebar}
      hidden={!visible}
      style={{ width }}
    >
      <div className="side-title">{t(title)}</div>
      <div className="side-body" hidden={showsExplorer || showsSearch}>
        {view === "agents" ? (
          <AgentsView
            {...agents}
            collapsed={collapsed}
            showingAll={showingAll}
            content={content}
            onOpenTerminalIn={onOpenTerminalIn}
            onAddProject={onAddProject}
            onRemoveProject={onRemoveProject}
          />
        ) : view === "versionControl" && project !== null ? (
          <RepositoriesView
            content={content}
            arrangement={agents.arrangement}
            onShowChange={onShowChange}
            onArrange={onArrangeRepositories}
            onAddProject={onAddProject}
            onRemoveProject={onRemoveProject}
          />
        ) : (
          <p className="hint">{t("status.noProject")}</p>
        )}
      </div>
      {/* Der Explorer bleibt bestehen, damit er beim Wechsel der Ansicht nichts neu lesen muss. */}
      {content.kind !== "startPage" && (
        <Explorer
          // Wird aus dem Projekt ein Workspace, beginnt der Baum mit Wurzeln neu.
          key={content.kind === "workspace" ? content.id : content.path}
          projects={projects}
          workspace={content.kind === "workspace" ? content.name : null}
          onAddProject={onAddProject}
          onRemoveProject={onRemoveProject}
          onMoveProject={onMoveProject}
          onRenameWorkspace={onRenameWorkspace}
          renameRequest={renameRequest}
          onCloseWorkspace={onCloseWorkspace}
          hidden={!showsExplorer}
          onOpenTerminalIn={onOpenTerminalIn}
          activeFile={activeFile}
          onOpenFile={onOpenFile}
        />
      )}
      {/* Auch die Suche behält beim Wechsel der Ansicht Eingabe und Trefferliste. */}
      {project !== null && (
        <SearchView
          key={`search:${project}`}
          projects={projects}
          grouped={content.kind === "workspace"}
          hidden={!showsSearch}
          focusRequest={searchFocus}
          onOpenFile={onOpenMatch}
        />
      )}
      <div
        className="sash"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={resize}
      />
    </aside>
  );
}

/**
 * Die Agenten-Ansicht: oben die Agenten des Fensters als Karten mit
 * Agentenstatus, Laufzeit und letzter Aktion, darunter die gewöhnlichen
 * Terminals. Ein wartender Agent ist hervorgehoben. Im Workspace stehen sie
 * in aufklappbaren Abschnitten je Projekt (siehe {@link AgentSectionView}).
 */
function AgentsView({
  arrangement,
  statuses,
  onSelectTab,
  onNewAgent,
  onNewTerminal,
  onToggleSection,
  collapsed,
  showingAll,
  content,
  onOpenTerminalIn,
  onAddProject,
  onRemoveProject,
}: AgentsViewProps & SubagentFolding & AgentsViewContext) {
  const t = useT();
  const { settings } = useSettings();
  const known = useAgentStatuses(statuses);
  const [menu, setMenu] = useState<{ x: number; y: number; project: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Dateiansichten gehören nicht in die Agenten-Ansicht.
  const tabs = tabsOf(arrangement).filter(isTerminal);
  const selected = focusedGroupOf(arrangement)?.activeTab;
  const card = (tab: Tab) => {
    const status = known.get(tab.id);
    const classes = ["card", status?.state === "waiting" && "wait", tab.id === selected && "sel"];
    const assignment = visibleAssignment(tab, settings.showAssignment);
    // Steht an Stelle der letzten Aktion, bis sich der Agent meldet.
    const interrupted = isInterrupted(tab, known);
    // Die Karte selbst ist kein Knopf, damit keine Knöpfe in einem Knopf
    // stehen: Ihr oberer Teil und jede Zeile eines Subagenten sind je ein
    // Knopf, ihre Klicks gehen an die Karte. Pfeil und „weitere“ halten ihre
    // Klicks zurück. Mit der Maus wirkt die ganze Karte.
    return (
      <div
        key={tab.id}
        className={classes.filter(Boolean).join(" ")}
        onClick={() => onSelectTab(tab.id)}
      >
        <button className="card-main">
          <AgentCardTop
            status={status}
            name={tabLabel(tab, t)}
            kicker={assignment === null ? undefined : tab.name ? "named" : "agent"}
          />
          {assignment !== null && (
            <span className="assignment" title={assignment}>
              {assignment}
            </span>
          )}
          {status && <AgentCardStatus status={status} />}
          {interrupted && <span className="last">{t("agent.interrupted")}</span>}
        </button>
        {status && (
          <SubagentSection
            subagents={status.subagents}
            collapsed={collapsed.has(tab.id)}
            onToggleCollapsed={() => collapsed.toggle(tab.id)}
            showsAll={showingAll.has(tab.id)}
            onToggleShowsAll={() => showingAll.toggle(tab.id)}
          />
        )}
      </div>
    );
  };
  /** Agenten zuerst, dann die gewöhnlichen Terminals, mit `heading` unter „Terminals“. */
  const cards = (shown: readonly Tab[], heading: boolean) => {
    const agents = shown.filter((tab) => tab.agent);
    const terminals = shown.filter((tab) => !tab.agent);
    return (
      <>
        {agents.map(card)}
        {terminals.length > 0 && heading && <div className="sect">{t("sidebar.terminals")}</div>}
        {terminals.map(card)}
      </>
    );
  };
  const projectMenu = (project: string): MenuItem[] => {
    const name = projectName(project);
    const report = (error: unknown) => {
      const { key, values } = errorMessage(error, name);
      message(t(key, values), { title: t("activity.agents"), kind: "error" });
    };
    return [
      { label: t("explorer.agentHere"), onSelect: () => onOpenTerminalIn(project, true) },
      { label: t("explorer.terminalHere"), onSelect: () => onOpenTerminalIn(project, false) },
      {
        label: t("explorer.reveal"),
        separator: true,
        onSelect: () => revealEntry(project, "").catch(report),
      },
      { label: t("explorer.copyPath"), onSelect: () => copyText(project).catch(report) },
      { label: t("workspace.addProject"), separator: true, onSelect: onAddProject },
      { label: t("workspace.removeProject"), onSelect: () => onRemoveProject(project) },
    ];
  };
  return (
    <div className="cards">
      <div className="side-actions">
        <button
          className="btn"
          title={t("agent.newTooltip")}
          disabled={!onNewAgent}
          onClick={onNewAgent}
        >
          {t("agent.new")}
        </button>
        <button
          className="btn ghost"
          title={t("terminal.newTooltip")}
          disabled={!onNewTerminal}
          onClick={onNewTerminal}
        >
          {t("terminal.new")}
        </button>
      </div>
      {content.kind === "workspace" ? (
        agentSections(content.projects, tabs).map(({ project, tabs: shown }) => (
          <AgentSectionView
            key={project ?? ""}
            project={project}
            tabs={shown}
            statuses={known}
            collapsed={isSectionCollapsed(arrangement, project)}
            onToggle={() => onToggleSection(project)}
            onOpenTerminalIn={onOpenTerminalIn}
            onMenu={(x, y) => project !== null && setMenu({ x, y, project })}
          >
            {shown.length > 0
              ? cards(
                  shown,
                  shown.some((tab) => tab.agent),
                )
              : // „Außerhalb der Projekte“ erscheint nur mit Terminals.
                project !== null && (
                  <p className="hint">
                    {t("workspace.sectionEmpty")}{" "}
                    <button className="link-button" onClick={() => onOpenTerminalIn(project, true)}>
                      {t("workspace.startAgent")}
                    </button>
                  </p>
                )}
          </AgentSectionView>
        ))
      ) : (
        <>
          {cards(tabs, true)}
          {tabs.length === 0 && <p className="hint">{t("terminal.none")}</p>}
        </>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={projectMenu(menu.project)} onClose={closeMenu} />
      )}
    </div>
  );
}

/**
 * Ein Abschnitt der Agenten-Ansicht im Workspace. Im Kopf stehen Name und
 * Statuspunkte mit Anzahl; beim Darüberfahren erscheinen stattdessen Knöpfe
 * für einen neuen Agenten oder ein neues Terminal im Projekt und „…“ für sein
 * Kontextmenü. „Außerhalb der Projekte“ (`project` ist `null`) hat keine Knöpfe.
 */
function AgentSectionView({
  project,
  tabs,
  statuses,
  collapsed,
  onToggle,
  onOpenTerminalIn,
  onMenu,
  children,
}: {
  project: string | null;
  tabs: readonly Tab[];
  statuses: Statuses;
  collapsed: boolean;
  onToggle: () => void;
  onOpenTerminalIn: (folder: string, agent: boolean) => void;
  /** Öffnet das Kontextmenü des Projekts an dieser Stelle. */
  onMenu: (x: number, y: number) => void;
  children: ReactNode;
}) {
  const t = useT();
  const name = project === null ? t("workspace.outsideProjects") : projectName(project);
  const counts = countStates(tabs.flatMap((tab) => statuses.get(tab.id) ?? []));
  return (
    <section className={collapsed ? "agent-section collapsed" : "agent-section"}>
      <div
        className="agent-section-head"
        onContextMenu={(event) => {
          if (project === null) return;
          event.preventDefault();
          onMenu(event.clientX, event.clientY);
        }}
      >
        <button
          className="agent-section-toggle"
          aria-expanded={!collapsed}
          title={project ?? undefined}
          onClick={onToggle}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" />
          </svg>
          <span className="agent-section-name">{name}</span>
        </button>
        <span className="agent-section-counts">
          {stateOrder
            .filter((state) => counts[state] > 0)
            .map((state) => {
              const text = plural(t, counts[state], ...stateCounters[state]);
              return (
                <span key={state} role="img" title={text} aria-label={text}>
                  <span className={`dot ${state}`} />
                  {counts[state]}
                </span>
              );
            })}
        </span>
        {project !== null && (
          <span className="agent-section-actions">
            <SectionButton
              label={t("agent.newIn", { project: name })}
              onClick={() => onOpenTerminalIn(project, true)}
              path="M4 5.5h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM8 2.5v3M6 9h.01M10 9h.01"
            />
            <SectionButton
              label={t("terminal.newIn", { project: name })}
              onClick={() => onOpenTerminalIn(project, false)}
              path="m3 4 4 4-4 4M8 12h5"
            />
            <SectionButton
              label={t("explorer.more")}
              popup
              onClick={(bounds) => onMenu(bounds.left, bounds.bottom)}
              {...moreIcon}
            />
          </span>
        )}
      </div>
      {!collapsed && <div className="agent-section-cards">{children}</div>}
    </section>
  );
}
