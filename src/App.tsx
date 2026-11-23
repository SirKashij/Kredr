import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityBar, type View } from "./ActivityBar";
import { AgentStatuses } from "./agentStatus";
import { AgentCounters } from "./AgentStatusViews";
import {
  activateAdjacentTab,
  activateTab,
  assignShell,
  closeTab,
  closesFileText,
  emptyArrangement,
  filePathOf,
  focusAdjacentGroup,
  focusedGroupOf,
  focusGroupAt,
  focusGroupToward,
  isTerminal,
  openContent,
  openTab,
  openTabIn,
  restoreArrangement,
  showsFile,
  showVersionControl,
  splitGroup,
  tabsOf,
  type Arrangement,
} from "./arrangement";
import { ArrangementSaver, loadArrangement } from "./arrangementStore";
import { chooseFolder } from "./chooseFolder";
import { mayCloseWindow, type CloseQuestion } from "./closeWindow";
import { contentFor } from "./fileKinds";
import { fileName, fullPath, opensExternally, toProjectPath } from "./filePath";
import { recordOpened } from "./fileNameSearch";
import { saveFile } from "./FileView";
import { useT, type MessageKey } from "./i18n/i18n";
import { isModifierKey, resolveKey, type Command } from "./keybindings";
import { MainArea } from "./MainArea";
import { OpenFiles, type FilePosition } from "./openFiles";
import { openFileExternally, openUrl } from "./openExternally";
import { projectName } from "./project";
import { WorkspaceFileList } from "./projectFileList";
import { watchProjectFiles } from "./projectFiles";
import { ProjectWatches } from "./projectWatches";
import { BranchPicker } from "./BranchPicker";
import { QuickOpen } from "./QuickOpen";
import { repositoriesOf } from "./repositories";
import { Sidebar } from "./Sidebar";
import { StartPage } from "./StartPage";
import { RunningTerminals } from "./runningTerminals";
import { useSettings } from "./settings";
import { SettingsPage } from "./SettingsPage";
import { availableShells, type Shell } from "./settingsStore";
import { shellLabel, tabLabel } from "./tabLabel";
import { useWaitingAlerts } from "./useWaitingAlerts";
import { SyncStatus } from "./SyncStatus";
import { VersionControlProvider, VersionControls } from "./versionControl";
import type { ChangedFile } from "./versionControlState";
import { BranchStatus } from "./VersionControlView";
import { alertBody } from "./waitingAlerts";
import { WindowAgents } from "./windowAgents";
import {
  activeProject,
  addProject,
  firstProject,
  keepConversations,
  moveProject,
  projectsOf,
  removalInterrupts,
  removeProject,
  renameWorkspace,
  startPage,
  toggleSection,
  type WindowContent,
} from "./workspace";
import { Notice, type NoticeContent } from "./Notice";
import { ProjectPicker } from "./ProjectPicker";

/** Was der Kern auf „Projekt hinzufügen“ antwortet. */
type AddProjectOutcome = { kind: "added"; content: WindowContent } | { kind: "openElsewhere" };
/** Was der Kern auf „Workspace öffnen“ antwortet. */
type OpenWorkspaceOutcome = { kind: "opened"; content: WindowContent } | { kind: "openElsewhere" };

/** Eine Datei, die als Dateiansicht geöffnet werden soll. */
export interface FileRequest extends Partial<FilePosition> {
  /** Voller Pfad oder relativ zum Projektordner. */
  path: string;
  /** Als Vorschau-Tab, den die nächste Vorschau ersetzt; sonst dauerhaft. */
  preview?: boolean;
}

export function App() {
  const t = useT();
  const { settings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>("agents");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  /** Steigt mit jedem Aufruf der Suche; danach erhält ihr Suchfeld die Tastatur. */
  const [searchFocus, setSearchFocus] = useState(0);
  /** Was dieses Fenster zeigt: die Startseite, ein Projekt oder einen Workspace. */
  const [content, setContent] = useState<WindowContent>(startPage);
  /** Die Projekte des Fensters in Reihenfolge. */
  const projects = useMemo(() => projectsOf(content), [content]);
  /**
   * Das erste Projekt des Fensters. Ihm folgen bis auf Weiteres die Ansichten,
   * die Statusleiste und neue Terminals; für ein Projektfenster ist es das Projekt.
   */
  const project = firstProject(content);
  const [arrangement, setArrangement] = useState(emptyArrangement);
  /** Ob die gespeicherte Aufteilung des Projekts geladen ist; erst dann wird gezeigt und gespeichert. */
  const [restored, setRestored] = useState(false);
  /** Das Projekt oder der Workspace, dessen gespeicherte Aufteilung geladen ist. */
  const loadedFor = useRef<string | null>(null);
  const [saver] = useState(() => new ArrangementSaver());
  /** Steigt mit jeder Bedienung der Aufteilung; danach erhält das Terminal wieder den Fokus. */
  const [focusRequest, setFocusRequest] = useState(0);
  // Ein Sprachwechsel soll laufende Terminals nicht neu starten.
  const translate = useRef(t);
  translate.current = t;
  const [statuses] = useState(() => new AgentStatuses());
  const [terminals] = useState(
    () =>
      new RunningTerminals({
        translate: () => translate.current,
        openUrl,
        // Dateipfade aus dem Terminal öffnen sich in der Dateiansicht.
        openFile: (target) => openFileRequest.current(target),
      }),
  );
  /** Aufteilung, Einstellungen und Fensterinhalt für Rückfragen, die auf eine Antwort warten. */
  const latest = useRef({ arrangement, settings, content });
  latest.current = { arrangement, settings, content };
  const [agents] = useState(
    () =>
      new WindowAgents({
        terminals,
        statuses,
        change: setArrangement,
        // Eine geänderte Standard-Shell gilt für das nächste neue Terminal.
        settings: () => latest.current.settings,
      }),
  );
  const [files] = useState(() => new OpenFiles());
  /** Die Dateilisten aller Projekte für „Datei per Namen öffnen“. */
  const [fileList] = useState(() => new WorkspaceFileList());
  const [quickOpen, setQuickOpen] = useState(false);
  const [branchPicker, setBranchPicker] = useState(false);
  /** Die offene Frage nach dem Projekt für einen neuen Agenten oder ein neues Terminal. */
  const [projectPick, setProjectPick] = useState<{ agent: boolean } | null>(null);
  /** Der Hinweis, der gerade unten rechts steht. */
  const [notice, setNotice] = useState<NoticeContent | null>(null);
  const closeNotice = useCallback(() => setNotice(null), []);
  /** Steigt, wenn der Name des Workspace im Explorer-Kopf bearbeitet werden soll. */
  const [renameRequest, setRenameRequest] = useState(0);
  /** Ob gerade ein Ordner aus dem Windows-Explorer über der Seitenleiste schwebt. */
  const [folderDrop, setFolderDrop] = useState(false);
  /** Warum sich das Fenster zuletzt nicht schließen ließ. */
  const [closeError, setCloseError] = useState<string | null>(null);
  /** Die in diesem Fenster zuletzt geöffneten Dateien, die jüngste zuerst. */
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [versionControl] = useState(() => new VersionControls());
  /** Die Shells, die es auf diesem Rechner gibt; PowerShell immer. */
  const [shells, setShells] = useState<Shell[]>(["powershell"]);
  // Eine geänderte Standard-Shell gilt für das nächste neue Terminal.
  const defaultShell = useRef(settings.defaultShell);
  defaultShell.current = settings.defaultShell;

  useEffect(() => {
    availableShells()
      .then(setShells)
      .catch(() => {});
  }, []);

  /** Jedes neu entstandene Terminal hält die Standard-Shell fest, wenn keine gewählt wurde. */
  function settle(arrangement: Arrangement): Arrangement {
    return assignShell(arrangement, defaultShell.current);
  }

  useEffect(() => {
    invoke<WindowContent>("window_content").then((opened) => {
      setContent((current) => (current.kind === "startPage" ? opened : current));
    });
    // Ein weiterer Start von Kredr kann einem Fenster auf der Startseite ein Projekt geben.
    const unlisten = getCurrentWindow().listen<WindowContent>("window-content-opened", (event) =>
      setContent(event.payload),
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const title =
      content.kind === "workspace"
        ? t("window.titleWorkspace", { name: content.name })
        : project
          ? t("window.title", { project: projectName(project) })
          : "Kredr";
    getCurrentWindow().setTitle(title);
  }, [content, project, t]);

  // Ein Projekt öffnet sich mit seiner gespeicherten Aufteilung; ohne sie
  // beginnt es mit einem Terminal. Gemerkte Agenten starten sofort und
  // gleichzeitig, auch in verdeckten Tabs, und setzen ihr Gespräch fort.
  // Geladen wird einmal je Projekt bzw. Workspace: Ein Workspace, der aus
  // dem Projektfenster entsteht, übernimmt die laufende Aufteilung, und wird
  // sein erstes Projekt entfernt, lädt er nichts neu.
  const arrangementOwner = content.kind === "workspace" ? content.id : project;
  const hasProject = project !== null;
  useEffect(() => {
    if (!project || loadedFor.current === arrangementOwner) return;
    loadedFor.current = arrangementOwner;
    let stale = false;
    let done = false;
    const { resumeAgents } = latest.current.settings;
    loadArrangement(project, { resumeAgents }).then((stored) => {
      if (stale) return;
      // Ist schon ein Terminal entstanden, bleibt die gespeicherte Aufteilung ungenutzt.
      const used = !latest.current.arrangement.root;
      setArrangement((current) =>
        current.root ? current : settle(stored.root ? stored : openTab(current)),
      );
      if (used) agents.resumeAll(stored, project);
      setRestored(true);
      done = true;
    });
    return () => {
      stale = true;
      // Ein abgebrochenes Laden zählt nicht; der nächste Lauf lädt erneut.
      if (!done) loadedFor.current = null;
    };
  }, [arrangementOwner, hasProject]);

  // Die Aufteilung wird laufend gespeichert, mit ihr Größe und Position des Fensters.
  useEffect(() => {
    if (restored) saver.changed(arrangement);
  }, [arrangement, restored, saver]);
  useEffect(() => {
    const window = getCurrentWindow();
    const listening = [
      window.onMoved(() => saver.windowChanged()),
      window.onResized(() => saver.windowChanged()),
    ];
    return () => listening.forEach((unlisten) => unlisten.then((stop) => stop()));
  }, [saver]);

  // Terminals, deren Tab geschlossen wurde, enden.
  useEffect(() => {
    const tabIds = new Set(tabsOf(arrangement).map((tab) => tab.id));
    terminals.retain(tabIds);
    statuses.retain(tabIds);
  }, [arrangement, terminals, statuses]);

  // Ebenso die offenen Dateien der Dateiansichten.
  useEffect(() => {
    files.retain(tabsOf(arrangement).flatMap((tab) => filePathOf(tab) ?? []));
  }, [arrangement, files]);

  // Ändert ein Agent eine offene Datei, lädt ihre Dateiansicht neu. Jedes
  // Projekt des Fensters hat dafür seinen eigenen Beobachter. `files` bleibt
  // für die Lebensdauer des Fensters dasselbe Objekt.
  const [fileWatches] = useState(
    () =>
      new ProjectWatches((folder) =>
        watchProjectFiles(folder, (changes) => files.projectChanged(folder, changes)),
      ),
  );
  useEffect(() => fileWatches.follow(projects), [projects, fileWatches]);
  useEffect(() => () => fileWatches.follow([]), [fileWatches]);

  useEffect(() => fileList.follow(projects), [projects, fileList]);
  useEffect(() => () => fileList.follow([]), [fileList]);
  // Die Versionskontrolle folgt dem Zustand jedes Projekts, je in seinem Repository.
  useEffect(() => versionControl.follow(projects), [projects, versionControl]);
  useEffect(() => () => versionControl.follow([]), [versionControl]);

  /**
   * Fragt wie beim Schließen des Fensters nach, ob dabei etwas verloren ginge,
   * und speichert danach die Aufteilung; `true` heißt: schließen. Nutzt nur
   * Objekte, die für die Lebensdauer des Fensters dieselben bleiben.
   */
  function confirmClosing(
    texts: Record<CloseQuestion, [title: MessageKey, message: MessageKey]>,
    ok: MessageKey,
  ): Promise<boolean> {
    const t = translate.current;
    setCloseError(null);
    const { arrangement } = latest.current;
    // Agenten, die beim nächsten Öffnen zurückkommen, zählen nicht als laufender Prozess.
    const resumed = new Set(agents.returning(arrangement));
    return mayCloseWindow({
      hasUnsavedFiles: () => files.anyDirty(),
      hasRunningProcess: () => terminals.anyHasChildProcess(resumed),
      hasWorkingAgent: () => agents.closingInterrupts(arrangement),
      confirm: (question) => {
        const [title, message] = texts[question];
        return confirm(t(message), {
          title: t(title),
          kind: "warning",
          okLabel: t(ok),
          cancelLabel: t("dialog.cancel"),
        });
      },
      // Was an der Aufteilung noch nicht gespeichert ist, geht dabei nicht verloren.
      saveArrangement: () => saver.flush(),
      showError: setCloseError,
    });
  }

  // Das Fenster schließt mit ungespeicherten Änderungen oder einem laufenden
  // Prozess in einem Terminal erst nach Rückfrage.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      const close = await confirmClosing(
        {
          unsavedFiles: ["file.closeConfirm.title", "file.closeWindowConfirm.message"],
          runningProcess: [
            "terminal.closeWindowConfirm.title",
            "terminal.closeWindowConfirm.message",
          ],
          workingAgent: ["agent.closeWindowConfirm.title", "agent.closeWindowConfirm.message"],
        },
        "file.closeWindowConfirm.ok",
      );
      if (!close) event.preventDefault();
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [files, saver, terminals, agents]);

  useEffect(() => {
    terminals.setFont(settings.fontFamily, settings.fontSize);
  }, [terminals, settings.fontFamily, settings.fontSize]);

  // Ordner aus dem Windows-Explorer: Über der Seitenleiste erscheint eine
  // Ablagefläche, dort losgelassen kommen sie als Projekte hinzu.
  const dropFolders = useRef(dropOnSidebar);
  dropFolders.current = dropOnSidebar;
  useEffect(() => {
    /** Ob die Stelle (in physischen Pixeln des Fensters) über der Seitenleiste liegt. */
    const overSidebar = ({ x, y }: { x: number; y: number }) => {
      const sidebar = document.querySelector(".sidebar");
      if (!sidebar || latest.current.content.kind === "startPage") return false;
      const scale = window.devicePixelRatio;
      const box = sidebar.getBoundingClientRect();
      const [left, top] = [x / scale, y / scale];
      return left >= box.left && left <= box.right && top >= box.top && top <= box.bottom;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") return setFolderDrop(false);
      const over = overSidebar(payload.position);
      if (payload.type !== "drop") return setFolderDrop(over);
      setFolderDrop(false);
      if (over) dropFolders.current(payload.paths);
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  /** Gibt dem sichtbaren Terminal der fokussierten Gruppe die Tastatureingaben zurück. */
  function refocusTerminal() {
    setFocusRequest((count) => count + 1);
  }

  /** Ändert die Aufteilung und zeigt sie; die Tastatur bleibt, wo sie ist. */
  function show(change: (arrangement: Arrangement) => Arrangement) {
    setArrangement((current) => settle(change(current)));
    // Wer die Aufteilung bedient, will sie sehen.
    setSettingsOpen(false);
  }

  /** Ändert die Aufteilung und gibt dem Hauptbereich die Tastatur. */
  function update(change: (arrangement: Arrangement) => Arrangement) {
    show(change);
    refocusTerminal();
  }

  function closeSettings() {
    setSettingsOpen(false);
    refocusTerminal();
  }

  /**
   * Öffnet eine Datei als Dateiansicht im Hauptbereich, wahlweise an einer
   * Stelle und als Vorschau. Der eine Weg für Explorer, Dateipfade im
   * Terminal, Suche und „Datei per Namen öffnen“.
   */
  function openFile({ path, preview = false, line, ...position }: FileRequest) {
    if (!project) return;
    const file = toProjectPath(project, path);
    setRecentFiles((recent) => recordOpened(recent, file));
    // PDFs und Office-Dateien gehören ins Windows-Standardprogramm; nur die
    // Vorschau beim Durchklicken startet kein anderes Programm.
    if (!preview && opensExternally(file)) {
      return openFileExternally({ path: fullPath(project, file) });
    }
    // Bilder öffnen sich als Bild, alles andere als Dateiansicht.
    const content = contentFor(file);
    const isFileView = content.kind === "file";
    const open = (current: Arrangement) => openContent(current, content, preview);
    if (preview) {
      // Die Vorschau zeigt die Datei nur; die Tastatur bleibt, wo sie ist.
      show(open);
    } else {
      if (isFileView) files.get(project, file).wantFocus();
      update(open);
    }
    if (isFileView && line !== undefined) files.get(project, file).reveal({ line, ...position });
  }

  /**
   * Schließt „Datei per Namen öffnen“, die Branch-Liste und die Projektauswahl;
   * die Tastatur geht zurück in den Hauptbereich.
   */
  const closeQuickPick = useCallback(() => {
    setQuickOpen(false);
    setBranchPicker(false);
    setProjectPick(null);
    setFocusRequest((count) => count + 1);
  }, []);

  const openFileRequest = useRef(openFile);
  openFileRequest.current = openFile;

  /** Fragt bei ungespeicherten Änderungen nach; `false` heißt: Der Tab bleibt offen. */
  async function confirmCloseFile(path: string): Promise<boolean> {
    const file = files.find(path);
    if (!file?.state.dirty) return true;
    const name = fileName(path);
    const save = t("file.closeConfirm.save");
    const discard = t("file.closeConfirm.discard");
    const choice = await message(t("file.closeConfirm.message", { name }), {
      title: t("file.closeConfirm.title"),
      kind: "warning",
      buttons: { yes: save, no: discard, cancel: t("dialog.cancel") },
    });
    if (choice === save) {
      return saveFile(file, (details) => t("file.saveFailed", { name, details }));
    }
    return choice === discard;
  }

  /** Schließt den Tab, gleich was er zeigt; vorher fragt er nach, wenn dabei etwas verloren ginge. */
  async function requestCloseTab(tabId: string) {
    const content = tabsOf(arrangement).find((tab) => tab.id === tabId)?.content;
    // Quelltext und Markdown-Vorschau zeigen denselben Text; gefragt wird erst,
    // wenn der letzte Tab schließt, der ihn hält.
    const closing = showsFile(content) && closesFileText(arrangement, tabId);
    if (closing && !(await confirmCloseFile(content.path))) {
      refocusTerminal();
      return;
    }
    if (await terminals.find(tabId)?.hasChildProcess()) {
      const confirmed = await confirm(t("terminal.closeConfirm.message"), {
        title: t("terminal.closeConfirm.title"),
        kind: "warning",
        okLabel: t("terminal.closeConfirm.ok"),
        cancelLabel: t("dialog.cancel"),
      });
      if (!confirmed) {
        refocusTerminal();
        return;
      }
    }
    update((current) => closeTab(current, tabId));
  }

  /**
   * Zeigt die Versionskontrolle: die Änderungen in der Seitenleiste und, in
   * einem Repository, den maximierten Tab „Versionskontrolle“ im Hauptbereich.
   */
  function openVersionControl() {
    setView("versionControl");
    setSidebarVisible(true);
    if (repositoriesOf(versionControl.snapshot().projects).length > 0) {
      update((current) => showVersionControl(current, true));
    }
  }

  /** Zeigt den Diff einer Änderung im Tab „Versionskontrolle“; die Tastatur bleibt in der Liste. */
  function showChange(project: string, file: ChangedFile) {
    versionControl.select(project, file);
    show((current) => showVersionControl(current, false));
  }

  /** Zeigt eine Ansicht; ein Klick auf die bereits gezeigte blendet die Seitenleiste aus. */
  function selectView(next: View) {
    const shows = next !== view || !sidebarVisible;
    if (shows && next === "versionControl") return openVersionControl();
    setSidebarVisible(shows);
    setView(next);
    if (next === "search") setSearchFocus((count) => count + 1);
  }

  /**
   * „Neuer Agent“ (`agent`: ein Terminal, in dem sofort der Agent startet)
   * oder „Neues Terminal“ ohne Angabe des Projekts. Mit mehreren Projekten
   * fragt Kredr per QuickPick, in welchem.
   */
  function startTerminal(agent: boolean) {
    if (projects.length > 1) return setProjectPick({ agent });
    update((current) => openTab(current, agent));
  }

  /** Öffnet das Terminal, nach dem die Projektauswahl gefragt hat, im gewählten Projekt. */
  function startTerminalIn(project: string, agent: boolean) {
    setProjectPick(null);
    update((current) => openTabIn(current, project, agent));
  }

  function run(command: Command) {
    if (command.kind === "openSettings") return setSettingsOpen(true);
    // Alle übrigen Befehle bedienen die Aufteilung eines Projekts.
    if (!project) return;
    const focused = focusedGroupOf(arrangement);
    switch (command.kind) {
      case "newTerminal":
        return startTerminal(false);
      case "newAgent":
        return startTerminal(true);
      case "splitRight":
      case "splitDown": {
        // Ohne Gruppe gibt es nichts zu teilen; dann entsteht das erste Terminal.
        if (!focused) return update(openTab);
        const direction = command.kind === "splitRight" ? "right" : "down";
        return update((current) => splitGroup(current, focused.id, direction));
      }
      case "focusNextGroup":
        return update((current) => focusAdjacentGroup(current, 1));
      case "focusPreviousGroup":
        return update((current) => focusAdjacentGroup(current, -1));
      case "focusGroupToward":
        return update((current) => focusGroupToward(current, command.side));
      case "focusGroupAt":
        return update((current) => focusGroupAt(current, command.index));
      case "nextTab":
        return update((current) => activateAdjacentTab(current, 1));
      case "previousTab":
        return update((current) => activateAdjacentTab(current, -1));
      case "showExplorer":
        setView("explorer");
        return setSidebarVisible(true);
      case "showSearch":
        setView("search");
        setSearchFocus((count) => count + 1);
        return setSidebarVisible(true);
      case "quickOpen":
        return setQuickOpen(true);
      case "showVersionControl":
        return openVersionControl();
      case "toggleSidebar":
        return setSidebarVisible((visible) => !visible);
      case "closeTab":
        if (focused) requestCloseTab(focused.activeTab);
    }
  }
  const runCommand = useRef(run);
  runCommand.current = run;

  useWaitingAlerts({
    statuses,
    enabled: settings.notifications,
    describe: (tabIds) => {
      const tabs = tabsOf(arrangement);
      const waiting = tabIds.flatMap((tabId) => tabs.find((tab) => tab.id === tabId) ?? []);
      return {
        title: project ? projectName(project) : "",
        body: alertBody(
          waiting.map((tab) => tabLabel(tab, t)),
          t,
        ),
      };
    },
    // Wie der Klick auf die Karte des Agenten in der Agenten-Ansicht.
    onSelect: (tabId) => update((current) => activateTab(current, tabId)),
  });

  // Die Kürzel gelten im ganzen Fenster und greifen, bevor das Terminal die Taste sieht.
  useEffect(() => {
    let chord = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isModifierKey(event.keyCode)) return;
      const wasChord = chord;
      const resolved = resolveKey(event, chord);
      chord = resolved === "chord";
      // Eine unbekannte zweite Taste nach Strg+K verfällt wie in VS Code.
      if (!resolved && !wasChord) return;
      event.preventDefault();
      event.stopPropagation();
      if (resolved && resolved !== "chord") runCommand.current(resolved);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const focusedGroup = focusedGroupOf(arrangement);
  /** Der sichtbare Tab der fokussierten Gruppe. */
  const activeTab = focusedGroup?.tabs.find((tab) => tab.id === focusedGroup.activeTab);
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe. */
  const activeFile = filePathOf(activeTab) ?? null;
  // Ohne eigene Wahl zeigt der Verlauf das Repository des aktiven Projekts.
  useEffect(() => {
    const previous = versionControl.snapshot().active;
    versionControl.setActive(activeProject(projects, activeTab, previous));
  }, [projects, activeTab, versionControl]);

  async function openFolder() {
    const folder = await chooseFolder(t("dialog.openFolderTitle"));
    if (folder) await openProject(folder);
  }

  async function openProject(folder: string) {
    // Ist das Projekt schon in einem anderen Fenster offen, kommt jenes nach vorn.
    const opened = await invoke<WindowContent | null>("open_project", { path: folder });
    if (opened) setContent(opened);
  }

  async function openWorkspace(id: string, name: string) {
    const outcome = await invoke<OpenWorkspaceOutcome>("open_workspace", { id });
    if (outcome.kind === "opened") return setContent(outcome.content);
    // Ein Projekt des Workspace ist schon anderswo offen; jenes Fenster ist jetzt vorn.
    setNotice({ text: t("workspace.openElsewhereWorkspace", { name }) });
  }

  /**
   * „Projekt zum Workspace hinzufügen…“: Aus einem Projektfenster wird dabei
   * der Workspace „Unbenannt“, der die laufende Aufteilung übernimmt.
   */
  async function addProjectToWindow() {
    const folder = await chooseFolder(t("workspace.addProjectTitle"));
    if (folder) await addFolder(folder, latest.current.content);
  }

  /**
   * Fügt dem Fenster mit dem Inhalt `content` den Ordner als Projekt hinzu,
   * mit Hinweis, und liefert, was das Fenster danach zeigt. Der eine Weg für
   * den Ordnerdialog und aus dem Windows-Explorer gezogene Ordner.
   */
  async function addFolder(folder: string, content: WindowContent): Promise<WindowContent> {
    const added = projectName(folder);
    const result = addProject(content, folder, {
      id: crypto.randomUUID(),
      name: t("workspace.untitled"),
    });
    if (result.kind === "refused") {
      setNotice({ text: t("workspace.alreadyContained", { project: added }) });
      return content;
    }
    // Was an der Aufteilung noch aussteht, gehört zum Projekt, bevor der Workspace sie übernimmt.
    await saver.flush();
    try {
      const outcome = await invoke<AddProjectOutcome>("add_project", { content: result.content });
      if (outcome.kind === "openElsewhere") {
        setNotice({ text: t("workspace.openElsewhere", { project: added }) });
        return content;
      }
      const becameWorkspace = content.kind === "project";
      const next = outcome.content;
      // Der neue Workspace übernimmt die laufende Aufteilung, statt seine zu laden.
      if (becameWorkspace && next.kind === "workspace") loadedFor.current = next.id;
      setContent(next);
      if (becameWorkspace && next.kind === "workspace") {
        const from = projectName(content.path);
        setNotice({
          text: t("workspace.created", { project: from, name: next.name, added }),
          action: { label: t("workspace.rename"), run: startRenaming },
        });
      } else {
        setNotice({ text: t("workspace.added", { project: added }) });
      }
      return next;
    } catch (reason) {
      setNotice({ text: t("workspace.addFailed", { project: added, details: String(reason) }) });
      return content;
    }
  }

  /** Aus dem Windows-Explorer auf die Seitenleiste gezogen: Ordner kommen hinzu, Dateien nicht. */
  async function dropOnSidebar(paths: string[]) {
    if (latest.current.content.kind === "startPage") return;
    const folders = await invoke<string[]>("folders_among", { paths });
    let current: WindowContent = latest.current.content;
    for (const folder of folders) current = await addFolder(folder, current);
  }

  /** Zeigt den Explorer mit dem Namen des Workspace als Eingabefeld. */
  function startRenaming() {
    setView("explorer");
    setSidebarVisible(true);
    setSettingsOpen(false);
    setRenameRequest((count) => count + 1);
  }

  /** Gibt dem Workspace den neuen Namen; ein leerer oder gleicher Name ändert nichts. */
  async function renameWorkspaceTo(name: string) {
    if (!renameWorkspace(latest.current.content, name)) return;
    // Was noch aussteht, darf den neuen Namen nicht mit dem alten überschreiben.
    await saver.flush();
    try {
      setContent(await invoke<WindowContent>("rename_workspace", { name }));
    } catch (reason) {
      setNotice({ text: t("workspace.renameFailed", { details: String(reason) }) });
    }
  }

  /**
   * Setzt das Projekt an die Stelle `index` unter den Projekten. Rückt dabei
   * ein anderes Projekt an die erste Stelle, bleiben die Tabs des bisherigen
   * ersten Projekts bei diesem, offene Dateien samt ungespeicherten Änderungen.
   */
  async function moveProjectTo(folder: string, index: number) {
    const move = moveProject(latest.current.content, latest.current.arrangement, folder, index);
    if (!move) return;
    await saver.flush();
    try {
      const next = await invoke<WindowContent>("reorder_projects", {
        projects: projectsOf(move.content),
      });
      const before = latest.current.arrangement;
      const moved = moveProject(latest.current.content, before, folder, index);
      if (moved) {
        const paths = (arrangement: Arrangement) => tabsOf(arrangement).map(filePathOf);
        const after = paths(moved.arrangement);
        paths(before).forEach((path, position) => {
          if (path !== undefined && after[position] !== undefined) {
            files.rekey(path, after[position]);
          }
        });
        setArrangement(moved.arrangement);
      }
      setContent(next);
    } catch (reason) {
      setNotice({ text: t("workspace.moveFailed", { details: String(reason) }) });
    }
  }

  /**
   * „Workspace schließen“: Das Fenster zeigt danach die Startseite. Ginge
   * dabei etwas verloren, fragt Kredr wie beim Schließen eines Fensters. Die
   * Aufteilung ist gespeichert; beim nächsten Öffnen kommt der Workspace mit
   * seinen Agenten zurück.
   */
  async function closeWorkspace() {
    const close = await confirmClosing(
      {
        unsavedFiles: ["file.closeConfirm.title", "workspace.closeConfirm.unsavedFiles"],
        runningProcess: ["workspace.closeConfirm.title", "workspace.closeConfirm.runningProcess"],
        workingAgent: ["workspace.closeConfirm.title", "workspace.closeConfirm.workingAgent"],
      },
      "workspace.close",
    );
    if (!close) return refocusTerminal();
    try {
      await invoke("close_workspace");
    } catch (reason) {
      return setNotice({ text: t("workspace.closeFailed", { details: String(reason) }) });
    }
    // Ab hier speichert das Fenster nichts mehr; die Tabs schließen, ihre Terminals enden.
    loadedFor.current = null;
    setRestored(false);
    setArrangement(emptyArrangement);
    setContent(startPage);
    setNotice(null);
  }

  /**
   * „Projekt aus Workspace entfernen“: Terminals und Tabs des Projekts
   * schließen, seine Beobachter enden. Gingen dabei ungespeicherte Änderungen
   * verloren oder würde ein arbeitender oder wartender Agent unterbrochen,
   * fragt Kredr vorher. Die Gespräche seiner Agenten kommen in die eigene
   * Aufteilung des Projekts und gehen beim nächsten Öffnen dort weiter.
   */
  async function removeProjectFromWindow(folder: string) {
    const name = projectName(folder);
    const removal = removeProject(content, latest.current.arrangement, folder);
    if (!removal) return;
    const dirty = removal.closing.some(
      (tab) => showsFile(tab.content) && files.find(tab.content.path)?.state.dirty,
    );
    const ask = (message: MessageKey, title: MessageKey) =>
      confirm(t(message, { project: name }), {
        title: t(title),
        kind: "warning",
        okLabel: t("workspace.removeConfirm.ok"),
        cancelLabel: t("dialog.cancel"),
      });
    if (dirty && !(await ask("workspace.removeUnsaved.message", "file.closeConfirm.title"))) {
      return refocusTerminal();
    }
    if (
      removalInterrupts(removal.closing, statuses.snapshot()) &&
      !(await ask("workspace.removeConfirm.message", "workspace.removeConfirm.title"))
    ) {
      return refocusTerminal();
    }
    // Während der Rückfragen können sich Fensterinhalt und Aufteilung geändert haben.
    const before = latest.current.content;
    const confirmed = removeProject(before, latest.current.arrangement, folder);
    if (!confirmed) return;
    try {
      const raw = await invoke<unknown>("project_arrangement_load", { project: folder });
      const stored = restoreArrangement(raw, undefined, { resumeAgents: true });
      const withConversations = keepConversations(stored, confirmed.closing, folder);
      if (withConversations !== stored) {
        await invoke("project_arrangement_save", {
          project: folder,
          arrangement: withConversations,
        });
      }
      // Was noch aussteht, darf den Workspace ohne das Projekt nicht überschreiben.
      await saver.flush();
      const next = await invoke<WindowContent>("remove_project", {
        project: folder,
        arrangement: confirmed.arrangement,
      });
      setContent(next);
      setArrangement((current) => removeProject(before, current, folder)?.arrangement ?? current);
      setNotice({ text: t("workspace.removed", { project: name }) });
    } catch (reason) {
      setNotice({ text: t("workspace.removeFailed", { project: name, details: String(reason) }) });
    }
  }

  return (
    <VersionControlProvider controls={versionControl}>
      <div className="workbench">
        <ActivityBar
          view={sidebarVisible ? view : null}
          onSelect={selectView}
          settingsOpen={settingsOpen}
          statuses={statuses}
          onToggleSettings={() => (settingsOpen ? closeSettings() : setSettingsOpen(true))}
        />
        <Sidebar
          view={view}
          visible={sidebarVisible}
          project={project}
          content={content}
          onAddProject={addProjectToWindow}
          onRemoveProject={removeProjectFromWindow}
          onMoveProject={moveProjectTo}
          onRenameWorkspace={renameWorkspaceTo}
          renameRequest={renameRequest}
          onCloseWorkspace={closeWorkspace}
          folderDrop={folderDrop}
          arrangement={arrangement}
          activeFile={activeFile}
          onOpenFile={(path, preview) => openFile({ path, preview })}
          onOpenMatch={openFile}
          searchFocus={searchFocus}
          onShowChange={showChange}
          statuses={statuses}
          onSelectTab={(tabId) => update((current) => activateTab(current, tabId))}
          onNewAgent={project ? () => startTerminal(true) : undefined}
          onNewTerminal={project ? () => startTerminal(false) : undefined}
          onToggleSection={(section) =>
            setArrangement((current) => toggleSection(current, section))
          }
          onArrangeRepositories={setArrangement}
          onOpenTerminalIn={(folder, agent) =>
            update((current) => openTabIn(current, folder, agent))
          }
        />
        <main className="main">
          {content.kind === "workspace" && !project ? (
            <div className="empty-main">
              <p>{t("workspace.empty")}</p>
              <button className="btn" onClick={addProjectToWindow}>
                {t("workspace.addFirstProject")}
              </button>
            </div>
          ) : !project ? (
            <StartPage
              onOpen={openProject}
              onOpenWorkspace={openWorkspace}
              onOpenFolder={openFolder}
            />
          ) : !restored ? null : arrangement.root ? (
            <MainArea
              arrangement={arrangement}
              terminals={terminals}
              agents={agents}
              statuses={statuses}
              files={files}
              cwd={project}
              shells={shells}
              focusRequest={focusRequest}
              update={update}
              onRefocus={refocusTerminal}
              onOpenFile={(path) => openFile({ path })}
              onCloseTab={requestCloseTab}
            />
          ) : (
            <div className="empty-main">
              <p>{t("terminal.none")}</p>
              <button className="btn" onClick={() => startTerminal(true)}>
                {t("agent.new")}
              </button>
              <button className="btn ghost" onClick={() => startTerminal(false)}>
                {t("terminal.new")}
              </button>
            </div>
          )}
          {settingsOpen && <SettingsPage onClose={closeSettings} />}
        </main>
      </div>
      {quickOpen && project && (
        <QuickOpen
          files={fileList}
          showProjects={content.kind === "workspace"}
          recent={recentFiles}
          onOpen={(path) => openFile({ path })}
          onClose={closeQuickPick}
        />
      )}
      {branchPicker && project && <BranchPicker project={project} onClose={closeQuickPick} />}
      {projectPick && (
        <ProjectPicker
          projects={projects}
          agent={projectPick.agent}
          onPick={(picked) => startTerminalIn(picked, projectPick.agent)}
          onClose={closeQuickPick}
        />
      )}
      {notice && <Notice notice={notice} onClose={closeNotice} />}
      <footer className="status">
        <BranchStatus onToggle={() => setBranchPicker((open) => !open)} />
        <SyncStatus />
        <span>{project ? projectName(project) : t("status.noProject")}</span>
        <AgentCounters statuses={statuses} />
        {closeError !== null && (
          <span className="status-error" role="alert">
            {t("window.closeFailed", { details: closeError })}
          </span>
        )}
        {activeTab && isTerminal(activeTab) && (
          <span className="right">{shellLabel(activeTab.shell, t)}</span>
        )}
      </footer>
    </VersionControlProvider>
  );
}
