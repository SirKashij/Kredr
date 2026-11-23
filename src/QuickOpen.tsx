import { useMemo, useState, useSyncExternalStore } from "react";
import { fileIcon } from "./fileIcons";
import { fileName, parentOf } from "./filePath";
import { searchFiles } from "./fileNameSearch";
import { useT } from "./i18n/i18n";
import { projectName } from "./project";
import type { WorkspaceFileList } from "./projectFileList";
import { QuickPick } from "./QuickPick";
import type { WorkspaceFile } from "./workspace";

/**
 * „Datei per Namen öffnen“ (Strg+P): ein Eingabefeld mit Trefferliste über
 * dem Fenster. Pfeiltasten wählen, die Eingabetaste oder ein Klick öffnet,
 * Esc oder ein Klick daneben schließt. Im Workspace findet es die Dateien
 * aller Projekte und nennt bei jedem Treffer sein Projekt.
 */
export function QuickOpen({
  files,
  showProjects,
  recent,
  onOpen,
  onClose,
}: {
  files: WorkspaceFileList;
  /** Ob neben jedem Treffer sein Projekt steht: im Workspace. */
  showProjects: boolean;
  /** Die zuletzt geöffneten Dateien, die jüngste zuerst. */
  recent: readonly string[];
  /** Öffnet die Datei unter ihrem Schlüssel (`WorkspaceFile.key`). */
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const snapshot = useSyncExternalStore(files.subscribe, () => files.snapshot);
  const byKey = useMemo(() => new Map(snapshot.files.map((file) => [file.key, file])), [snapshot]);
  const [query, setQuery] = useState("");
  const results = useMemo(
    () => searchFiles(snapshot.index, query, recent).map((key) => byKey.get(key)!),
    [snapshot, byKey, query, recent],
  );

  return (
    <QuickPick
      placeholder={t("quickOpen.placeholder")}
      query={query}
      onQuery={setQuery}
      rows={results}
      rowKey={(file) => file.key}
      rowTitle={(file) => file.key}
      renderRow={(file) => <Result file={file} showProject={showProjects} />}
      empty={t("quickOpen.noResults")}
      onPick={(file) => {
        onClose();
        onOpen(file.key);
      }}
      onClose={onClose}
    />
  );
}

function Result({ file, showProject }: { file: WorkspaceFile; showProject: boolean }) {
  const name = fileName(file.path);
  const icon = fileIcon(name);
  const folder = parentOf(file.path);
  const where = showProject
    ? [projectName(file.project), folder].filter((part) => part !== "").join(" · ")
    : folder;
  return (
    <>
      {icon ? (
        <span className="tab-icon glyph" style={{ color: icon.color }}>
          {icon.glyph}
        </span>
      ) : (
        <svg className="tab-icon file" viewBox="0 0 16 16">
          <path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3" />
        </svg>
      )}
      <span className="quick-open-name">{name}</span>
      <span className="quick-open-folder">{where}</span>
    </>
  );
}
