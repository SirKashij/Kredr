import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
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
  openTab,
  splitGroup,
  tabsOf,
  type Arrangement,
  type Shell,
} from "./arrangement";
import { useT } from "./i18n/i18n";
import { isModifierKey, resolveKey, type Command } from "./keybindings";
import { MainArea } from "./MainArea";
import { openFileExternally, openUrl } from "./openExternally";
import { projectName } from "./project";
import { Sidebar } from "./Sidebar";
import { RunningTerminals } from "./runningTerminals";
import { shellLabel } from "./tabLabel";

export function App() {
  const t = useT();
  const [view, setView] = useState<View>("agents");
  /** Der Ordner des Projekts dieses Fensters. */
  const [project, setProject] = useState<string | null>(null);
  const [arrangement, setArrangement] = useState(emptyArrangement);
  /** Steigt mit jeder Bedienung der Aufteilung; danach erhält das Terminal wieder den Fokus. */
  const [focusRequest, setFocusRequest] = useState(0);
  // Ein Sprachwechsel soll laufende Terminals nicht neu starten.
  const translate = useRef(t);
  translate.current = t;
  const [terminals] = useState(
    () =>
      new RunningTerminals({
        translate: () => translate.current,
        openUrl,
        // Bis es die Dateiansicht gibt, öffnen Dateipfade aus dem Terminal
        // im Windows-Standardprogramm. Die Dateiansicht hängt sich hier ein.
        openFile: openFileExternally,
      }),
  );
  /** Die Shells, die es auf diesem Rechner gibt; PowerShell immer. */
  const [shells, setShells] = useState<Shell[]>(["powershell"]);

  useEffect(() => {
    invoke<Shell[]>("terminal_shells")
      .then(setShells)
      .catch(() => {});
  }, []);

  useEffect(() => {
    invoke<string | null>("initial_project").then((folder) => {
      if (folder) setProject((current) => current ?? folder);
    });
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

  /** Gibt dem sichtbaren Terminal der fokussierten Gruppe die Tastatureingaben zurück. */
  function refocusTerminal() {
    setFocusRequest((count) => count + 1);
  }

  function update(change: (arrangement: Arrangement) => Arrangement) {
    setArrangement(change);
    refocusTerminal();
  }

  async function closeTerminal(tabId: string) {
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

  function run(command: Command) {
    const focused = focusedGroupOf(arrangement);
    switch (command.kind) {
      case "newTerminal":
        return update((current) => openTab(current));
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
      case "closeTab":
        if (focused) closeTerminal(focused.activeTab);
    }
  }
  const runCommand = useRef(run);
  runCommand.current = run;

  // Die Kürzel gelten im ganzen Fenster und greifen, bevor das Terminal die Taste sieht.
  useEffect(() => {
    if (!project) return;
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
  }, [project]);

  const focusedGroup = focusedGroupOf(arrangement);
  /** Der sichtbare Tab der fokussierten Gruppe. */
  const activeTab = focusedGroup?.tabs.find((tab) => tab.id === focusedGroup.activeTab);

  async function openFolder() {
    const folder = await open({ directory: true, title: t("dialog.openFolderTitle") });
    if (folder) setProject(folder);
  }

  return (
    <>
      <div className="workbench">
        <ActivityBar view={view} onSelect={setView} />
        <Sidebar
          view={view}
          arrangement={arrangement}
          onSelectTab={(tabId) => update((current) => activateTab(current, tabId))}
        />
        <main className="main">
          {!project ? (
            <div className="welcome">
              <p>{t("welcome.text")}</p>
              <button className="btn" onClick={openFolder}>
                {t("welcome.openFolder")}
              </button>
            </div>
          ) : arrangement.root ? (
            <MainArea
              arrangement={arrangement}
              terminals={terminals}
              cwd={project}
              shells={shells}
              focusRequest={focusRequest}
              update={update}
              onRefocus={refocusTerminal}
              onCloseTab={closeTerminal}
            />
          ) : (
            <div className="welcome">
              <p>{t("terminal.none")}</p>
              <button className="btn" onClick={() => update((current) => openTab(current))}>
                {t("terminal.new")}
              </button>
            </div>
          )}
        </main>
      </div>
      <footer className="status">
        <span>{project ? projectName(project) : t("status.noProject")}</span>
        {activeTab && <span className="right">{shellLabel(activeTab.shell, t)}</span>}
      </footer>
    </>
  );
}
