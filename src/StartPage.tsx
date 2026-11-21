import { useEffect, useState } from "react";
import { useT } from "./i18n/i18n";
import { forgetProject, loadRecentProjects, projectName, type RecentProject } from "./project";

interface StartPageProps {
  /** Öffnet den Ordner als Projekt; scheitert, wenn es ihn nicht mehr gibt. */
  onOpen: (folder: string) => Promise<void>;
  onOpenFolder: () => void;
}

/** Die Startseite eines Fensters ohne Projekt. */
export function StartPage({ onOpen, onOpenFolder }: StartPageProps) {
  const t = useT();
  const [projects, setProjects] = useState<RecentProject[]>([]);

  // Andere Fenster ändern die Liste; beim Zurückkehren zeigt sie den aktuellen Stand.
  useEffect(() => {
    const load = () => loadRecentProjects().then(setProjects);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);

  function open(folder: string) {
    // Der Ordner ist seit dem Laden verschwunden: die Liste zeigt es danach an.
    onOpen(folder).catch(() => loadRecentProjects().then(setProjects));
  }

  function forget(folder: string) {
    forgetProject(folder).then(setProjects);
  }

  return (
    <div className="start">
      <div className="start-column">
        {projects.length === 0 ? (
          <p className="start-hint">{t("start.text")}</p>
        ) : (
          <>
            <div className="sect">{t("start.recent")}</div>
            <ul className="recent">
              {projects.map(({ path, exists }) => (
                <li key={path} className={exists ? undefined : "missing"}>
                  <button className="recent-open" disabled={!exists} onClick={() => open(path)}>
                    <span className="recent-name">{projectName(path)}</span>
                    <span className="recent-path">{path}</span>
                    {!exists && <span className="recent-missing">{t("start.missing")}</span>}
                  </button>
                  <button
                    className="recent-remove"
                    title={t("start.remove")}
                    aria-label={t("start.remove")}
                    onClick={() => forget(path)}
                  >
                    <svg className="icon" viewBox="0 0 16 16">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </li>
              ))}
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
