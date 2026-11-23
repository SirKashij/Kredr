import { useMemo, useState } from "react";
import { useT } from "./i18n/i18n";
import { projectName } from "./project";
import { QuickPick } from "./QuickPick";

/**
 * Die Frage nach dem Projekt für einen neuen Agenten (`agent`) oder ein
 * neues Terminal: die Projekte des Workspace in ihrer Reihenfolge, gefiltert
 * nach dem eingegebenen Namen.
 */
export function ProjectPicker({
  projects,
  agent,
  onPick,
  onClose,
}: {
  projects: readonly string[];
  agent: boolean;
  onPick: (project: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => projectName(project).toLowerCase().includes(needle));
  }, [projects, query]);
  return (
    <QuickPick
      placeholder={t(agent ? "workspace.pickProject.agent" : "workspace.pickProject.terminal")}
      query={query}
      onQuery={setQuery}
      rows={rows}
      rowKey={(project) => project}
      rowTitle={(project) => project}
      renderRow={(project) => (
        <>
          <span className="quick-open-name">{projectName(project)}</span>
          <span className="quick-open-folder">{project}</span>
        </>
      )}
      empty={t("workspace.pickProject.none")}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
