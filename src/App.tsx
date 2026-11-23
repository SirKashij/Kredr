import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityBar, type View } from "./ActivityBar";
import { AgentStatuses } from "./agentStatus";
import { AgentCounters } from "./AgentStatusViews";
import {
  activateAdjacentTab,
  activateTab,
  assignShell,
  closeTab,
  closesFileText,
  filePathOf,
  focusAdjacentGroup,
  focusedGroupOf,
  focusGroupAt,
  focusGroupToward,
  isTerminal,
  openContent,
  openTab,
  openTabIn,
  showsFile,
  showVersionControl,
  splitGroup,
  tabsOf,
  type Arrangement,
} from "./arrangement";
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
import { ProjectScope, VersionControlProvider, VersionControls } from "./versionControl";
import type { ChangedFile } from "./versionControlState";
import { BranchStatus } from "./VersionControlView";
import { alertBody } from "./waitingAlerts";
import { WindowAgents } from "./windowAgents";
import { tauriWindowCore, WindowStore, type AddOutcome, type ClosingQuestion } from "./windowStore";
import {
  activeProject,
  firstProject,
  projectsOf,
  removalQuestion,
  type RemovalQuestion,
  toggleSection,
  type WindowContent,
} from "./workspace";
import { Notice, type NoticeContent } from "./Notice";
import { ProjectPicker } from "./ProjectPicker";

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
  /** Steigt mit jeder Bedienung der Aufteilung; danach erhält das Terminal wieder den Fokus. */
  const [focusRequest, setFocusRequest] = useState(0);
  // Ein Sprachwechsel soll laufende Terminals nicht neu starten.
  const translate = useRef(t);
  translate.current = t;
  /** Die Einstellungen für Agenten und Store, die nur bei Bedarf nachsehen. */
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
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
  const [files] = useState(() => new OpenFiles());
  /** Fensterinhalt und Aufteilung; nur der Store ändert sie. */
  const [{ store, agents }] = useState(() => {
    const store = new WindowStore({
      core: tauriWindowCore,
      settings: () => latestSettings.current,
      settle: (arrangement) => settle(arrangement),
      untitledName: () => translate.current("workspace.untitled"),
      resume: (stored, project) => agents.resumeAll(stored, project),
      mayClose: (question) => mayCloseRequest.current(question),
      // Vor dem Umbenennen der Tabs, sonst schlössen die Dateien mit dem alten Pfad.
      renameFiles: (renamed) => renamed.forEach(([from, to]) => files.rekey(from, to)),
    });
    const agents = new WindowAgents({
      terminals,
      statuses,
      change: store.change,
      // Eine geänderte Standard-Shell gilt für das nächste neue Terminal.
      settings: () => latestSettings.current,
    });
    return { store, agents };
  });
  const { content, arrangement, restored } = useSyncExternalStore(store.subscribe, store.snapshot);
  /** Die Projekte des Fensters in Reihenfolge. */
  const projects = useMemo(() => projectsOf(content), [content]);
  /**
   * Das erste Projekt des Fensters. Ihm folgen bis auf Weiteres die Ansichten
   * und neue Terminals; für ein Projektfenster ist es das Projekt.
   */
  const project = firstProject(content);
  /** Die Dateilisten aller Projekte für „Datei per Namen öffnen“. */
  const [fileList] = useState(() => new WorkspaceFileList());
  const [quickOpen, setQuickOpen] = useState(false);
  /** Das Projekt, dessen Branch die offene Branch-Liste wechselt. */
  const [branchPickerProject, setBranchPickerProject] = useState<string | null>(null);
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

  useEffect(() => {
    availableShells()
      .then(setShells)
      .catch(() => {});
  }, []);

  /**
   * Jedes neu entstandene Terminal hält die Standard-Shell fest, wenn keine
   * gewählt wurde. Eine geänderte Standard-Shell gilt für das nächste neue Terminal.
   */
  function settle(arrangement: Arrangement): Arrangement {
    return assignShell(arrangement, latestSettings.current.defaultShell);
  }

  useEffect(() => {
    invoke<WindowContent>("window_content").then((opened) => store.showInitial(opened));
    // Ein weiterer Start von Kredr kann einem Fenster auf der Startseite ein Projekt geben.
    const unlisten = getCurrentWindow().listen<WindowContent>("window-content-opened", (event) =>
      store.show(event.payload),
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [store]);

  useEffect(() => {
    const title =
      content.kind === "workspace"
        ? t("window.titleWorkspace", { name: content.name })
        : project
          ? t("window.title", { project: projectName(project) })
          : "Kredr";
    getCurrentWindow().setTitle(title);
  }, [content, project, t]);

  // Größe und Position des Fensters werden mit der Aufteilung gespeichert.
  useEffect(() => {
    const window = getCurrentWindow();
    const listening = [
      window.onMoved(() => store.windowChanged()),
      window.onResized(() => store.windowChanged()),
    ];
    return () => listening.forEach((unlisten) => unlisten.then((stop) => stop()));
  }, [store]);

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
    const { arrangement } = store.snapshot();
    // Agenten, die beim nächsten Öffnen zurückkommen, zählen nicht als laufender Prozess.
    const resumed = new Set(agents.returning(arrangement));
    return mayCloseWindow({
      hasUnsavedFiles: () => files.anyDirty(),
      hasRunningProcess: () => terminals.anyHasChildProcess(resumed),
      hasWorkingAgent: () => agents.closingInterrupts(arrangement),
      hasBackgroundAgent: () => agents.closingEndsBackgroundTasks(arrangement),
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
      saveArrangement: () => store.flush(),
      showError: setCloseError,
    });
  }

  /**
   * Die Rückfragen des Stores, bevor Tabs schließen: beim Schließen des
   * Workspace wie beim Schließen eines Fensters; beim Entfernen eines
   * Projekts, wenn ungespeicherte Änderungen verloren gingen, ein
   * arbeitender oder wartender Agent unterbrochen würde oder die
   * Hintergrundaufgaben eines Agenten endeten.
   */
  async function mayClose(question: ClosingQuestion): Promise<boolean> {
    if (question.kind === "closeWorkspace") {
      return confirmClosing(
        {
          unsavedFiles: ["file.closeConfirm.title", "workspace.closeConfirm.unsavedFiles"],
          runningProcess: ["workspace.closeConfirm.title", "workspace.closeConfirm.runningProcess"],
          workingAgent: ["workspace.closeConfirm.title", "workspace.closeConfirm.workingAgent"],
          backgroundAgent: [
            "workspace.closeConfirm.title",
            "workspace.closeConfirm.backgroundAgent",
          ],
        },
        "workspace.close",
      );
    }
    const t = translate.current;
    const name = projectName(question.project);
    const dirty = question.closing.some(
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
      return false;
    }
    const removal = removalQuestion(question.closing, statuses.snapshot());
    const messages: Record<RemovalQuestion, MessageKey> = {
      interruptsAgent: "workspace.removeConfirm.message",
      endsBackgroundTasks: "workspace.removeConfirm.backgroundMessage",
    };
    return !removal || ask(messages[removal], "workspace.removeConfirm.title");
  }
  const mayCloseRequest = useRef(mayClose);
  mayCloseRequest.current = mayClose;

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
          backgroundAgent: [
            "agent.closeWindowConfirm.title",
            "agent.closeWindowConfirm.backgroundMessage",
          ],
        },
        "file.closeWindowConfirm.ok",
      );
      if (!close) event.preventDefault();
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [files, store, terminals, agents]);

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
      if (!sidebar || store.snapshot().content.kind === "startPage") return false;
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
    store.change((current) => settle(change(current)));
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
    setBranchPickerProject(null);
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
  /** Das Projekt des aktiven Tabs; ihm folgen Statusleiste, Branch-Liste und Verlauf. */
  const [active, setActive] = useState<string | null>(null);
  // Zeigt sich die Versionskontrolle, bleibt das bisher aktive Projekt.
  const nextActive = activeProject(projects, activeTab, active);
  if (nextActive !== active) setActive(nextActive);
  // Ohne eigene Wahl zeigt der Verlauf das Repository des aktiven Projekts.
  useEffect(() => versionControl.setActive(active), [active, versionControl]);

  async function openFolder() {
    const folder = await chooseFolder(t("dialog.openFolderTitle"));
    if (folder) await openProject(folder);
  }

  /** Ist das Projekt schon in einem anderen Fenster offen, kommt jenes nach vorn. */
  async function openProject(folder: string) {
    const outcome = await store.open(folder);
    if (outcome.kind === "failed") {
      setNotice({
        text: t("window.openFailed", { project: projectName(folder), details: outcome.details }),
      });
    }
  }

  async function openWorkspace(id: string, name: string) {
    const outcome = await store.openWorkspace(id);
    // Ein Projekt des Workspace ist schon anderswo offen; jenes Fenster ist jetzt vorn.
    if (outcome.kind === "openElsewhere") {
      setNotice({ text: t("workspace.openElsewhereWorkspace", { name }) });
    } else if (outcome.kind === "failed") {
      setNotice({ text: t("workspace.openFailed", { name, details: outcome.details }) });
    }
  }

  /**
   * „Projekt zum Workspace hinzufügen…“: Aus einem Projektfenster wird dabei
   * der Workspace „Unbenannt“, der die laufende Aufteilung übernimmt.
   */
  async function addProjectToWindow() {
    const folder = await chooseFolder(t("workspace.addProjectTitle"));
    if (folder) showAdded(folder, await store.add(folder));
  }

  /** Aus dem Windows-Explorer auf die Seitenleiste gezogen: Ordner kommen hinzu, Dateien nicht. */
  async function dropOnSidebar(paths: string[]) {
    for (const { folder, outcome } of await store.addFolders(paths)) showAdded(folder, outcome);
  }

  /** Der Hinweis zum Hinzufügen des Ordners. */
  function showAdded(folder: string, outcome: AddOutcome) {
    const project = projectName(folder);
    switch (outcome.kind) {
      case "added":
        return setNotice({ text: t("workspace.added", { project }) });
      case "becameWorkspace":
        return setNotice({
          text: t("workspace.created", {
            project: projectName(outcome.from),
            name: outcome.name,
            added: project,
          }),
          action: { label: t("workspace.rename"), run: startRenaming },
        });
      case "alreadyContained":
        return setNotice({ text: t("workspace.alreadyContained", { project }) });
      case "openElsewhere":
        return setNotice({ text: t("workspace.openElsewhere", { project }) });
      case "failed":
        return setNotice({ text: t("workspace.addFailed", { project, details: outcome.details }) });
    }
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
    const outcome = await store.rename(name);
    if (outcome.kind === "failed") {
      setNotice({ text: t("workspace.renameFailed", { details: outcome.details }) });
    }
  }

  /** Setzt das Projekt an die Stelle `index` unter den Projekten. */
  async function moveProjectTo(folder: string, index: number) {
    const outcome = await store.move(folder, index);
    if (outcome.kind === "failed") {
      setNotice({ text: t("workspace.moveFailed", { details: outcome.details }) });
    }
  }

  /** „Workspace schließen“: Das Fenster zeigt danach die Startseite. */
  async function closeWorkspace() {
    const outcome = await store.closeWorkspace();
    if (outcome.kind === "declined") return refocusTerminal();
    if (outcome.kind === "failed") {
      return setNotice({ text: t("workspace.closeFailed", { details: outcome.details }) });
    }
    if (outcome.kind === "closed") setNotice(null);
  }

  /** „Projekt aus Workspace entfernen“: Terminals und Tabs des Projekts schließen. */
  async function removeProjectFromWindow(folder: string) {
    const project = projectName(folder);
    const outcome = await store.remove(folder);
    if (outcome.kind === "declined") return refocusTerminal();
    if (outcome.kind === "removed") setNotice({ text: t("workspace.removed", { project }) });
    if (outcome.kind === "failed") {
      setNotice({ text: t("workspace.removeFailed", { project, details: outcome.details }) });
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
          onToggleSection={(section) => store.change((current) => toggleSection(current, section))}
          onArrangeRepositories={store.change}
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
              projects={projects}
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
      {branchPickerProject && (
        <ProjectScope project={branchPickerProject}>
          <BranchPicker
            project={branchPickerProject}
            showProject={content.kind === "workspace"}
            onClose={closeQuickPick}
          />
        </ProjectScope>
      )}
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
        {active && (
          <ProjectScope project={active}>
            <BranchStatus
              onToggle={() => setBranchPickerProject((open) => (open === active ? null : active))}
            />
            <SyncStatus />
          </ProjectScope>
        )}
        <span>{active ? projectName(active) : t("status.noProject")}</span>
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
