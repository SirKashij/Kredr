import { useEffect, useMemo, useRef, useState } from "react";
import {
  emptyTree,
  foldersToLoad,
  foldersToReload,
  receiveListing,
  rowsOf,
  toggleFolder,
  type Row,
} from "./explorerTree";
import { fileIcon } from "./fileIcons";
import { useT } from "./i18n/i18n";
import { listFolder, watchProjectFiles } from "./projectFiles";

/** Höhe einer Zeile in Pixeln; muss zu `.tree-row` passen. */
const ROW_HEIGHT = 22;
/** So viele Zeilen werden über und unter dem sichtbaren Ausschnitt mitgezeichnet. */
const OVERSCAN = 10;

/**
 * Der Ordnerbaum des Projekts. Ordnerinhalte werden erst beim Aufklappen
 * gelesen, und gezeichnet wird nur der sichtbare Ausschnitt: So bleibt auch
 * ein Ordner mit zehntausenden Einträgen flüssig.
 */
export function Explorer({ project, hidden }: { project: string; hidden: boolean }) {
  const t = useT();
  const [tree, setTree] = useState(emptyTree);
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const currentTree = useRef(tree);
  currentTree.current = tree;
  /** Die laufenden Leseaufträge: je Ordner die Nummer des jüngsten. */
  const requests = useRef(new Map<string, number>());
  const requestCount = useRef(0);

  /** Liest einen Ordner; von mehreren Aufträgen für denselben Ordner zählt nur der jüngste. */
  function load(folder: string) {
    const request = (requestCount.current += 1);
    requests.current.set(folder, request);
    listFolder(project, folder)
      // Ein Ordner, der sich nicht lesen lässt (etwa gerade gelöscht), ist leer.
      .catch(() => [])
      .then((entries) => {
        if (requests.current.get(folder) !== request) return;
        requests.current.delete(folder);
        setTree((current) => receiveListing(current, folder, entries));
      });
  }
  const loadFolder = useRef(load);
  loadFolder.current = load;

  useEffect(() => {
    for (const folder of foldersToLoad(tree)) {
      if (!requests.current.has(folder)) loadFolder.current(folder);
    }
  }, [tree]);

  useEffect(
    () =>
      watchProjectFiles(project, (changes) => {
        // Auch was gerade gelesen wird, kann schon wieder veraltet sein.
        const stale = new Set([
          ...foldersToReload(currentTree.current, changes),
          ...requests.current.keys(),
        ]);
        stale.forEach((folder) => loadFolder.current(folder));
      }),
    [project],
  );

  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => rowsOf(tree), [tree]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  function select(row: Row) {
    setSelected(row.path);
    if (row.kind === "folder") setTree((current) => toggleFolder(current, row.path));
  }

  return (
    <div
      className="tree"
      role="tree"
      hidden={hidden}
      ref={viewport}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {rows.length === 0 && tree.listings.has("") && <p className="hint">{t("explorer.empty")}</p>}
      <div style={{ height: rows.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}>
        {rows.slice(first, last).map((row) => (
          <div
            key={row.path}
            role="treeitem"
            aria-expanded={row.kind === "folder" ? row.expanded : undefined}
            aria-selected={row.path === selected}
            className={row.path === selected ? "tree-row sel" : "tree-row"}
            style={{ paddingLeft: 8 + row.depth * 12 }}
            onClick={() => select(row)}
          >
            <RowIcon row={row} />
            <span className="tree-name">{row.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RowIcon({ row }: { row: Row }) {
  if (row.kind === "folder") {
    return (
      <>
        <svg className={row.expanded ? "tree-twist open" : "tree-twist"} viewBox="0 0 16 16">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <svg className="tree-icon folder" viewBox="0 0 16 16">
          {row.expanded ? (
            <path d="M1.5 12.5v-9h4l1.5 1.5h6v2M1.5 12.5l2-5.5h11l-2 5.5z" />
          ) : (
            <path d="M1.5 3.5h4L7 5h7.5v7.5h-13z" />
          )}
        </svg>
      </>
    );
  }
  const icon = fileIcon(row.name);
  return (
    <>
      <span className="tree-twist" />
      {icon ? (
        <span className="tree-icon glyph" style={{ color: icon.color }}>
          {icon.glyph}
        </span>
      ) : (
        <svg className="tree-icon" viewBox="0 0 16 16">
          <path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3" />
        </svg>
      )}
    </>
  );
}
