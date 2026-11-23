import { useEffect, useRef, useState, type PointerEvent } from "react";
import { views, type View } from "./ActivityBar";
import { useAgentStatuses, type AgentStatuses } from "./agentStatus";
import { AgentCardStatus, AgentCardTop, SubagentSection } from "./AgentStatusViews";
import { focusedGroupOf, isTerminal, tabsOf, type Arrangement, type Tab } from "./arrangement";
import { Explorer } from "./Explorer";
import { useT } from "./i18n/i18n";
import { SearchView, type SearchViewProps } from "./SearchView";
import { useSettings } from "./settings";
import { tabLabel, visibleAssignment } from "./tabLabel";
import type { ChangedFile } from "./versionControlState";
import { VersionControlView } from "./VersionControlView";
import { isInterrupted } from "./windowAgents";
import { projectsOf, type WindowContent } from "./workspace";

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
  /** Zeigt den Diff einer Änderung im Tab „Versionskontrolle“. */
  onShowChange: (file: ChangedFile) => void;
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
          <AgentsView {...agents} collapsed={collapsed} showingAll={showingAll} />
        ) : view === "versionControl" && project !== null ? (
          <VersionControlView onShowChange={onShowChange} />
        ) : (
          <p className="hint">{t("status.noProject")}</p>
        )}
      </div>
      {/* Der Explorer bleibt bestehen, damit er beim Wechsel der Ansicht nichts neu lesen muss. */}
      {content.kind !== "startPage" && (
        <Explorer
          // Wird aus dem Projekt ein Workspace, beginnt der Baum mit Wurzeln neu.
          key={content.kind === "workspace" ? content.id : content.path}
          projects={projectsOf(content)}
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
          project={project}
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
 * Terminals. Ein wartender Agent ist hervorgehoben.
 */
function AgentsView({
  arrangement,
  statuses,
  onSelectTab,
  onNewAgent,
  onNewTerminal,
  collapsed,
  showingAll,
}: AgentsViewProps & SubagentFolding) {
  const t = useT();
  const { settings } = useSettings();
  const known = useAgentStatuses(statuses);
  // Dateiansichten gehören nicht in die Agenten-Ansicht.
  const tabs = tabsOf(arrangement).filter(isTerminal);
  const agents = tabs.filter((tab) => tab.agent);
  const terminals = tabs.filter((tab) => !tab.agent);
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
      {agents.map(card)}
      {tabs.length === 0 && <p className="hint">{t("terminal.none")}</p>}
      {terminals.length > 0 && <div className="sect">{t("sidebar.terminals")}</div>}
      {terminals.map(card)}
    </div>
  );
}
