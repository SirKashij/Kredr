import { useEffect, useState } from "react";
import { useT } from "./i18n/i18n";
import {
  forgetProject,
  forgetWorkspace,
  loadRecentEntries,
  projectName,
  type RecentEntry,
} from "./project";

interface StartPageProps {
  /** Öffnet den Ordner als Projekt; scheitert, wenn es ihn nicht mehr gibt. */
  onOpen: (folder: string) => Promise<void>;
  /** Öffnet den gespeicherten Workspace; scheitert, wenn es ihn nicht mehr gibt. */
  onOpenWorkspace: (id: string, name: string) => Promise<void>;
  onOpenFolder: () => void;
}

/** Die Startseite eines Fensters ohne Projekt. */
export function StartPage({ onOpen, onOpenWorkspace, onOpenFolder }: StartPageProps) {
  const t = useT();
  const [entries, setEntries] = useState<RecentEntry[]>([]);

  // Andere Fenster ändern die Liste; beim Zurückkehren zeigt sie den aktuellen Stand.
  useEffect(() => {
    const load = () => loadRecentEntries().then(setEntries);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  function open(entry: RecentEntry) {
    const opening =
      entry.kind === "project" ? onOpen(entry.path) : onOpenWorkspace(entry.id, entry.name);
    // Der Eintrag ist seit dem Laden verschwunden: die Liste zeigt es danach an.
    opening.catch(() => loadRecentEntries().then(setEntries));
  }

  function forget(entry: RecentEntry) {
    const forgetting =
      entry.kind === "project" ? forgetProject(entry.path) : forgetWorkspace(entry.id);
    forgetting.then(setEntries);
  }

  return (
    <div className="start">
      <div className="start-column">
        {entries.length === 0 ? (
          <p className="start-hint">{t("start.text")}</p>
        ) : (
          <>
            <div className="sect">{t("start.recent")}</div>
            <ul className="recent">
              {entries.map((entry) => {
                const missing = isMissing(entry);
                return (
                  <li
                    key={entry.kind === "project" ? entry.path : `workspace:${entry.id}`}
                    className={missing ? "missing" : undefined}
                  >
                    <button className="recent-open" disabled={missing} onClick={() => open(entry)}>
                      {entry.kind === "project" ? (
                        <>
                          <span className="recent-name">{projectName(entry.path)}</span>
                          <span className="recent-path">{entry.path}</span>
                        </>
                      ) : (
                        <>
                          <span className="recent-name">
                            {entry.name}
                            <small className="recent-kind">{t("start.workspace")}</small>
                          </span>
                          <span className="recent-path">
                            {entry.projects.map((project, index) => (
                              <span key={project.path}>
                                {index > 0 && ", "}
                                <span
                                  className={project.exists ? undefined : "recent-gone"}
                                  title={project.path}
                                >
                                  {projectName(project.path)}
                                </span>
                              </span>
                            ))}
                          </span>
                        </>
                      )}
                      {missing && <span className="recent-missing">{t("start.missing")}</span>}
                    </button>
                    <button
                      className="recent-remove"
                      title={t("start.remove")}
                      aria-label={t("start.remove")}
                      onClick={() => forget(entry)}
                    >
                      <svg className="icon" viewBox="0 0 16 16">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <button className="btn" onClick={onOpenFolder}>
          {t("start.openFolder")}
        </button>
      </div>
    </div>
  );
}

/**
 * Ob ein Ordner des Eintrags fehlt. Wie ein Projekt lässt sich dann auch ein
 * Workspace nicht öffnen, nur entfernen; seine fehlenden Projekte sind markiert.
 */
function isMissing(entry: RecentEntry): boolean {
  if (entry.kind === "project") return !entry.exists;
  return entry.projects.some((project) => !project.exists);
}
