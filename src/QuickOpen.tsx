import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fileIcon } from "./fileIcons";
import { fileName } from "./filePath";
import { searchFiles } from "./fileSearch";
import { useT } from "./i18n/i18n";
import type { ProjectFileList } from "./projectFileList";

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
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const index = useSyncExternalStore(files.subscribe, () => files.index);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useMemo(() => searchFiles(index, query, recent), [index, query, recent]);
  // Liest die Dateiliste im Hintergrund neu, bleibt die Auswahl in der Liste.
  const chosen = Math.min(selected, results.length - 1);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!box.current!.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    list.current?.children[chosen]?.scrollIntoView({ block: "nearest" });
  }, [chosen, results]);

  function open(path: string) {
    onClose();
    onOpen(path);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      // Am Ende der Liste geht es am anderen Ende weiter.
      if (results.length > 0) setSelected((chosen + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      if (results[chosen]) open(results[chosen]);
    } else if (event.key === "Escape") {
      onClose();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className="quick-open" ref={box}>
      <input
        className="quick-open-input"
        autoFocus
        spellCheck={false}
        placeholder={t("quickOpen.placeholder")}
        aria-label={t("quickOpen.placeholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      {results.length > 0 ? (
        <div className="quick-open-list" role="listbox" ref={list}>
          {results.map((path, position) => (
            <Result
              key={path}
              path={path}
              selected={position === chosen}
              onClick={() => open(path)}
            />
          ))}
        </div>
      ) : (
        <div className="quick-open-empty">{t("quickOpen.noResults")}</div>
      )}
    </div>
  );
}

function Result({
  path,
  selected,
  onClick,
}: {
  path: string;
  selected: boolean;
  onClick: () => void;
}) {
  const name = fileName(path);
  const icon = fileIcon(name);
  return (
    <div
      className={selected ? "quick-open-row sel" : "quick-open-row"}
      role="option"
      aria-selected={selected}
      title={path}
      onClick={onClick}
    >
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
    </div>
  );
}
