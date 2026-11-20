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
  groupsOf,
  openTab,
  splitGroup,
  type Arrangement,
} from "./arrangement";
import { useT } from "./i18n/i18n";
import { resolveKey, type Command } from "./keybindings";
import { MainArea } from "./MainArea";
import { projectName } from "./project";
import { Sidebar } from "./Sidebar";
import { TerminalSessions } from "./terminalSessions";

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
  const [sessions] = useState(() => new TerminalSessions(() => translate.current));

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
    const tabs = groupsOf(arrangement).flatMap((group) => group.tabs.map((tab) => tab.id));
    sessions.retain(new Set(tabs));
  }, [arrangement, sessions]);

  function update(change: (arrangement: Arrangement) => Arrangement) {
    setArrangement(change);
    setFocusRequest((count) => count + 1);
  }

  async function closeTerminal(tabId: string) {
    if (await sessions.find(tabId)?.hasChildProcess()) {
      const confirmed = await confirm(t("terminal.closeConfirm.message"), {
        title: t("terminal.closeConfirm.title"),
        kind: "warning",
        okLabel: t("terminal.closeConfirm.ok"),
        cancelLabel: t("dialog.cancel"),
      });
      if (!confirmed) {
        update((current) => current);
        return;
      }
    }
    update((current) => closeTab(current, tabId));
  }

  function run(command: Command) {
    const focused = focusedGroupOf(arrangement);
    switch (command.kind) {
      case "newTerminal":
        return update(openTab);
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
      // Strg, Umschalt, Alt und die Windows-Taste allein lösen nichts aus.
      if ([16, 17, 18, 91, 92].includes(event.keyCode)) return;
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
              root={arrangement.root}
              arrangement={arrangement}
              sessions={sessions}
              cwd={project}
              focusRequest={focusRequest}
              update={update}
              onCloseTab={closeTerminal}
            />
          ) : (
            <div className="welcome">
              <p>{t("sidebar.noTerminals")}</p>
              <button className="btn" onClick={() => update(openTab)}>
                {t("terminal.new")}
              </button>
            </div>
          )}
        </main>
      </div>
      <footer className="status">
        <span>{project ? projectName(project) : t("status.noProject")}</span>
        {arrangement.root && <span className="right">{t("terminal.powershell")}</span>}
      </footer>
    </>
  );
}
