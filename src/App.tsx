import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { ActivityBar, type View } from "./ActivityBar";
import { useT } from "./i18n/i18n";
import { projectName } from "./project";
import { Sidebar } from "./Sidebar";
import { TerminalView } from "./TerminalView";

export function App() {
  const t = useT();
  const [view, setView] = useState<View>("agents");
  /** Der Ordner des Projekts dieses Fensters. */
  const [project, setProject] = useState<string | null>(null);

  useEffect(() => {
    invoke<string | null>("initial_project").then((folder) => {
      if (folder) setProject((current) => current ?? folder);
    });
  }, []);

  useEffect(() => {
    if (project) {
      getCurrentWindow().setTitle(t("window.title", { project: projectName(project) }));
    }
  }, [project, t]);

  async function openFolder() {
    const folder = await open({ directory: true, title: t("dialog.openFolderTitle") });
    if (folder) setProject(folder);
  }

  return (
    <>
      <div className="workbench">
        <ActivityBar view={view} onSelect={setView} />
        <Sidebar view={view} hasTerminal={project !== null} />
        <main className="main">
          {project ? (
            <section className="group">
              <div className="tabs">
                <div className="tab on">
                  <span className="tab-icon">›_</span>
                  <span>{t("terminal.powershell")}</span>
                </div>
              </div>
              {/* Ein anderes Projekt bekommt ein frisches Terminal. */}
              <TerminalView key={project} cwd={project} />
            </section>
          ) : (
            <div className="welcome">
              <p>{t("welcome.text")}</p>
              <button className="btn" onClick={openFolder}>
                {t("welcome.openFolder")}
              </button>
            </div>
          )}
        </main>
      </div>
      <footer className="status">
        <span>{project ? projectName(project) : t("status.noProject")}</span>
        {project && <span className="right">{t("terminal.powershell")}</span>}
      </footer>
    </>
  );
}
