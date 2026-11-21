import { useMemo, useState, useSyncExternalStore } from "react";
import { fileIcon } from "./fileIcons";
import { fileName } from "./filePath";
import { searchFiles } from "./fileSearch";
import { useT } from "./i18n/i18n";
import type { ProjectFileList } from "./projectFileList";
import { QuickPick } from "./QuickPick";

/**
 * „Datei per Namen öffnen“ (Strg+P): ein Eingabefeld mit Trefferliste über
 * dem Fenster. Pfeiltasten wählen, die Eingabetaste oder ein Klick öffnet,
 * Esc oder ein Klick daneben schließt.
 */
export function QuickOpen({
  files,
  recent,
  onOpen,
  onClose,
}: {
  files: ProjectFileList;
  /** Die zuletzt geöffneten Dateien, die jüngste zuerst. */
  recent: readonly string[];
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const index = useSyncExternalStore(files.subscribe, () => files.index);
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchFiles(index, query, recent), [index, query, recent]);

  return (
    <QuickPick
      placeholder={t("quickOpen.placeholder")}
      query={query}
      onQuery={setQuery}
      rows={results}
      rowKey={(path) => path}
      rowTitle={(path) => path}
      renderRow={(path) => <Result path={path} />}
      empty={t("quickOpen.noResults")}
      onPick={(path) => {
        onClose();
        onOpen(path);
      }}
      onClose={onClose}
    />
  );
}

function Result({ path }: { path: string }) {
  const name = fileName(path);
  const icon = fileIcon(name);
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
      <span className="quick-open-folder">{path.slice(0, -name.length - 1)}</span>
    </>
  );
}
