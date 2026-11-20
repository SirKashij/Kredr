import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { ActivityBar, type View } from "./ActivityBar";
import {
  activateAdjacentTab,
  activateTab,
  closeTab,
  emptyArrangement,
  focusAdjacentGroup,
  focusedGroupOf,
  focusGroupAt,
  focusGroupToward,
  openContent,
  openTab,
  splitGroup,
  tabsOf,
  type Arrangement,
} from "./arrangement";
import { fileName, toProjectPath } from "./filePath";
import { saveFile } from "./FileView";
import { useT } from "./i18n/i18n";
import { isModifierKey, resolveKey, type Command } from "./keybindings";
import { MainArea } from "./MainArea";
import { OpenFiles, type FilePosition } from "./openFiles";
import { projectName } from "./project";
import { watchProjectFiles } from "./projectFiles";
import { Sidebar } from "./Sidebar";
import { StartPage } from "./StartPage";
import { RunningTerminals } from "./runningTerminals";
import { useSettings } from "./settings";
import { SettingsPage } from "./SettingsPage";

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
  /** Der Ordner des Projekts dieses Fensters. */
  const [project, setProject] = useState<string | null>(null);
  const [arrangement, setArrangement] = useState(emptyArrangement);
  /** Steigt mit jeder Bedienung der Aufteilung; danach erhält das Terminal wieder den Fokus. */
  const [focusRequest, setFocusRequest] = useState(0);
  // Ein Sprachwechsel soll laufende Terminals nicht neu starten.
  const translate = useRef(t);
  translate.current = t;
  const [terminals] = useState(() => new RunningTerminals(() => translate.current));
  const [files] = useState(() => new OpenFiles());

  useEffect(() => {
    invoke<string | null>("window_project").then((folder) => {
      if (folder) setProject((current) => current ?? folder);
    });
    // Ein weiterer Start von Kredr kann einem Fenster auf der Startseite ein Projekt geben.
    const unlisten = getCurrentWindow().listen<string>("project-opened", (event) =>
      setProject(event.payload),
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!project) return;
    getCurrentWindow().setTitle(t("window.title", { project: projectName(project) }));
  }, [project, t]);

  // Ein frisch geöffnetes Projekt beginnt mit einem Terminal.
  useEffect(() => {
    if (project) setArrangement((current) => (current.root ? current : openTab(current)));
  }, [project]);

  // Terminals, deren Tab geschlossen wurde, enden.
  useEffect(() => {
    terminals.retain(new Set(tabsOf(arrangement).map((tab) => tab.id)));
  }, [arrangement, terminals]);

  // Ebenso die offenen Dateien der Dateiansichten.
  useEffect(() => {
    files.retain(tabsOf(arrangement).flatMap((tab) => (tab.content ? [tab.content.path] : [])));
  }, [arrangement, files]);

  // Ändert ein Agent eine offene Datei, lädt ihre Dateiansicht neu.
  useEffect(() => {
    if (project) return watchProjectFiles(project, (changes) => files.projectChanged(changes));
  }, [project, files]);

  // Das Fenster schließt mit ungespeicherten Änderungen erst nach Rückfrage.
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (!files.anyDirty()) return;
      const t = translate.current;
      const discard = await confirm(t("file.closeWindowConfirm.message"), {
        title: t("file.closeConfirm.title"),
        kind: "warning",
        okLabel: t("file.closeWindowConfirm.ok"),
        cancelLabel: t("dialog.cancel"),
      });
      if (!discard) event.preventDefault();
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [files]);

  useEffect(() => {
    terminals.setFont(settings.fontFamily, settings.fontSize);
  }, [terminals, settings.fontFamily, settings.fontSize]);

  /** Gibt dem sichtbaren Terminal der fokussierten Gruppe die Tastatureingaben zurück. */
  function refocusTerminal() {
    setFocusRequest((count) => count + 1);
  }

  function update(change: (arrangement: Arrangement) => Arrangement) {
    setArrangement(change);
    // Wer die Aufteilung bedient, will sie sehen.
    setSettingsOpen(false);
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
    update((current) => openContent(current, { kind: "file", path: file }, preview));
    if (line !== undefined) files.get(project, file).reveal({ line, ...position });
  }

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

  async function closeTerminal(tabId: string) {
    const content = tabsOf(arrangement).find((tab) => tab.id === tabId)?.content;
    if (content?.kind === "file" && !(await confirmCloseFile(content.path))) {
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

  /** Zeigt eine Ansicht; ein Klick auf die bereits gezeigte blendet die Seitenleiste aus. */
  function selectView(next: View) {
    setSidebarVisible(next !== view || !sidebarVisible);
    setView(next);
  }
  /** „Neuer Agent“: öffnet ein Terminal, in dem sofort der Agent startet. */
  const newAgent = (current: Arrangement) => openTab(current, true);

  function run(command: Command) {
    if (command.kind === "openSettings") return setSettingsOpen(true);
    // Alle übrigen Befehle bedienen die Aufteilung eines Projekts.
    if (!project) return;
    const focused = focusedGroupOf(arrangement);
    switch (command.kind) {
      case "newTerminal":
        return update(openTab);
      case "newAgent":
        return update(newAgent);
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
      case "toggleSidebar":
        return setSidebarVisible((visible) => !visible);
      case "closeTab":
        if (focused) closeTerminal(focused.activeTab);
    }
  }
  const runCommand = useRef(run);
  runCommand.current = run;

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
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe. */
  const activeFile =
    focusedGroup?.tabs.find((tab) => tab.id === focusedGroup.activeTab)?.content?.path ?? null;

  async function openFolder() {
    const folder = await open({ directory: true, title: t("dialog.openFolderTitle") });
    if (folder) await openProject(folder);
  }

  async function openProject(folder: string) {
    // Ist das Projekt schon in einem anderen Fenster offen, kommt jenes nach vorn.
    if (await invoke<boolean>("open_project", { path: folder })) setProject(folder);
  }

  return (
    <>
      <div className="workbench">
        <ActivityBar
          view={sidebarVisible ? view : null}
          onSelect={selectView}
          settingsOpen={settingsOpen}
          onToggleSettings={() => (settingsOpen ? closeSettings() : setSettingsOpen(true))}
        />
        <Sidebar
          view={view}
          visible={sidebarVisible}
          project={project}
          arrangement={arrangement}
          activeFile={activeFile}
          onOpenFile={(path, preview) => openFile({ path, preview })}
          onSelectTab={(tabId) => update((current) => activateTab(current, tabId))}
          onNewAgent={project ? () => update(newAgent) : undefined}
          onNewTerminal={project ? () => update(openTab) : undefined}
        />
        <main className="main">
          {!project ? (
            <StartPage onOpen={openProject} onOpenFolder={openFolder} />
          ) : arrangement.root ? (
            <MainArea
              arrangement={arrangement}
              terminals={terminals}
              files={files}
              cwd={project}
              focusRequest={focusRequest}
              update={update}
              onRefocus={refocusTerminal}
              onCloseTab={closeTerminal}
            />
          ) : (
            <div className="welcome">
              <p>{t("terminal.none")}</p>
              <button className="btn" onClick={() => update(newAgent)}>
                {t("agent.new")}
              </button>
              <button className="btn ghost" onClick={() => update(openTab)}>
                {t("terminal.new")}
              </button>
            </div>
          )}
          {settingsOpen && <SettingsPage onClose={closeSettings} />}
        </main>
      </div>
      <footer className="status">
        <span>{project ? projectName(project) : t("status.noProject")}</span>
        {arrangement.root && activeFile === null && (
          <span className="right">{t("terminal.powershell")}</span>
        )}
      </footer>
    </>
  );
}
