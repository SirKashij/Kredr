import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { gitMarks, markOf, type GitMark } from "./explorerGit";
import {
  childPath,
  emptyTree,
  expandFolder,
  folderFor,
  foldersToLoad,
  foldersToReload,
  parentOf,
  receiveListing,
  revealPath,
  renameInTree,
  rowsOf,
  rowsWithEdit,
  toggleFolder,
  type Edit,
  type Row,
} from "./explorerTree";
import { fileIcon } from "./fileIcons";
import { isOutsideProject } from "./filePath";
import {
  absolutePath,
  copyText,
  createEntry,
  errorMessage,
  relativePath,
  renameEntry,
  renameSelectionLength,
  revealEntry,
  trashEntry,
} from "./fileOperations";
import { useT } from "./i18n/i18n";
import { listFolder, watchProjectFiles, type Entry } from "./projectFiles";
import { useVersionControl } from "./versionControl";
import { statusLabels } from "./versionControlState";

/** Höhe einer Zeile in Pixeln; muss zu `.tree-row` passen. */
const ROW_HEIGHT = 22;
/** So viele Zeilen werden über und unter dem sichtbaren Ausschnitt mitgezeichnet. */
const OVERSCAN = 10;

interface ExplorerProps {
  project: string;
  hidden: boolean;
  /** Öffnet ein Terminal im Ordner mit diesem vollen Pfad, mit `agent` samt einem Agenten. */
  onOpenTerminalIn: (folder: string, agent: boolean) => void;
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe; sie wird hervorgehoben. */
  activeFile: string | null;
  /** Öffnet die Datei als Dateiansicht, mit `preview` als Vorschau-Tab. */
  onOpenFile: (path: string, preview: boolean) => void;
}

/**
 * Der Ordnerbaum des Projekts. Ordnerinhalte werden erst beim Aufklappen
 * gelesen, und gezeichnet wird nur der sichtbare Ausschnitt: So bleibt auch
 * ein Ordner mit zehntausenden Einträgen flüssig.
 */
export function Explorer({
  project,
  hidden,
  onOpenTerminalIn,
  activeFile,
  onOpenFile,
}: ExplorerProps) {
  const t = useT();
  const [tree, setTree] = useState(emptyTree);
  const [selected, setSelected] = useState<string | null>(null);
  /** Die laufende Namenseingabe und die Meldung zu einem abgelehnten Namen. */
  const [edit, setEdit] = useState<Edit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** Das offene Kontextmenü; `row` fehlt beim Rechtsklick auf die freie Fläche. */
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row | null } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const currentTree = useRef(tree);
  currentTree.current = tree;
  /** Die Namenseingabe, über die gerade entschieden wird; schützt vor doppeltem Abschicken. */
  const pendingEdit = useRef<Edit | null>(null);
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

  const rows = useMemo(() => rowsWithEdit(rowsOf(tree), edit), [tree, edit]);
  // Die Git-Markierungen folgen dem Zustand der Versionskontrolle des Fensters.
  const { state: versionControl } = useVersionControl();
  const marks = useMemo(() => gitMarks(versionControl), [versionControl]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  // Die Zeile der Namenseingabe muss sichtbar sein, sonst gibt es nichts zum Tippen.
  const editRow = rows.findIndex((row) => row.edit);
  useLayoutEffect(() => {
    if (editRow < 0) return;
    const element = viewport.current!;
    const top = editRow * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
  }, [editRow]);

  // Die Datei des aktiven Tabs wird ausgewählt und ihre Ordner klappen auf.
  // Dateien außerhalb des Projekts stehen nicht im Baum.
  const revealing = useRef<string | null>(null);
  useEffect(() => {
    if (activeFile === null || isOutsideProject(activeFile)) return;
    setSelected(activeFile);
    setTree((current) => revealPath(current, activeFile));
    revealing.current = activeFile;
  }, [activeFile]);

  // Sobald ihre Zeile geladen ist, rückt sie einmal in den sichtbaren Ausschnitt.
  useEffect(() => {
    const path = revealing.current;
    if (path === null || hidden) return;
    const index = rows.findIndex((row) => row.path.toLowerCase() === path.toLowerCase());
    if (index < 0) return;
    revealing.current = null;
    const element = viewport.current!;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
  }, [rows, hidden, activeFile]);

  function select(row: Row) {
    setSelected(row.path);
    if (row.kind === "folder") setTree((current) => toggleFolder(current, row.path));
    else onOpenFile(row.path, true);
  }

  function startEdit(next: Edit) {
    pendingEdit.current = next;
    setEditError(null);
    setEdit(next);
  }

  function endEdit() {
    pendingEdit.current = null;
    setEditError(null);
    setEdit(null);
    viewport.current?.focus();
  }

  /** Beginnt die Eingabe für einen neuen Eintrag: im Ordner der Zeile, sonst der Auswahl. */
  function startCreate(kind: Entry["kind"], anchor?: Row | null) {
    const row = anchor === undefined ? rows.find((row) => row.path === selected) : anchor;
    const folder = folderFor(row);
    setTree((current) => expandFolder(current, folder));
    startEdit({ type: "create", folder, kind });
  }

  function startRename(row: Row) {
    setSelected(row.path);
    startEdit({ type: "rename", path: row.path });
  }

  /** Legt an oder benennt um. Ein abgelehnter Name bleibt mit Meldung zur Korrektur stehen. */
  async function submitEdit(value: string) {
    const current = pendingEdit.current;
    if (!current) return;
    const name = value.trim();
    const unchanged = current.type === "rename" && current.path.split("/").pop() === name;
    if (name === "" || unchanged) return endEdit();
    pendingEdit.current = null;
    try {
      if (current.type === "create") {
        await createEntry(project, current.folder, name, current.kind);
        setSelected(childPath(current.folder, name));
      } else {
        const renamed = childPath(parentOf(current.path), name);
        await renameEntry(project, current.path, name);
        setTree((tree) => renameInTree(tree, current.path, renamed));
        setSelected(renamed);
      }
      // Hat inzwischen eine neue Eingabe begonnen, bleibt sie stehen.
      if (pendingEdit.current === null) endEdit();
    } catch (error) {
      if (pendingEdit.current !== null) return;
      const { key, values } = errorMessage(error, name);
      pendingEdit.current = current;
      setEditError(t(key, values));
    }
  }

  /** Meldet eine gescheiterte Aktion, die keine eigene Stelle für Meldungen hat. */
  function report(error: unknown, name: string) {
    const { key, values } = errorMessage(error, name);
    message(t(key, values), { title: t("activity.explorer"), kind: "error" });
  }

  async function trash(row: Row) {
    const text =
      row.kind === "folder" ? "explorer.trashConfirm.folder" : "explorer.trashConfirm.file";
    const confirmed = await confirm(t(text, { name: row.name }), {
      title: t("explorer.trashConfirm.title"),
      kind: "warning",
      okLabel: t("explorer.trashConfirm.ok"),
      cancelLabel: t("dialog.cancel"),
    });
    viewport.current?.focus();
    if (confirmed) trashEntry(project, row.path).catch((error) => report(error, row.name));
  }

  function menuItems(row: Row | null): MenuItem[] {
    const path = row?.path ?? "";
    const name = row?.name ?? project;
    const inFolder: MenuItem[] = [
      { label: t("explorer.newFile"), onSelect: () => startCreate("file", row) },
      { label: t("explorer.newFolder"), onSelect: () => startCreate("folder", row) },
      {
        label: t("explorer.terminalHere"),
        separator: true,
        onSelect: () => onOpenTerminalIn(absolutePath(project, path), false),
      },
      {
        label: t("explorer.agentHere"),
        onSelect: () => onOpenTerminalIn(absolutePath(project, path), true),
      },
    ];
    const items: MenuItem[] = [
      ...(row?.kind === "file" ? [] : inFolder),
      {
        label: t("explorer.reveal"),
        separator: row?.kind !== "file",
        onSelect: () => revealEntry(project, path).catch((error) => report(error, name)),
      },
      {
        label: t("explorer.copyPath"),
        separator: true,
        onSelect: () => copyText(absolutePath(project, path)).catch((error) => report(error, name)),
      },
    ];
    if (!row) return items;
    return [
      ...items,
      {
        label: t("explorer.copyRelativePath"),
        onSelect: () => copyText(relativePath(path)).catch((error) => report(error, name)),
      },
      { label: t("explorer.rename"), separator: true, onSelect: () => startRename(row) },
      { label: t("explorer.trash"), onSelect: () => trash(row) },
    ];
  }

  function openMenu(event: MouseEvent, row: Row | null) {
    event.preventDefault();
    event.stopPropagation();
    if (row) setSelected(row.path);
    setMenu({ x: event.clientX, y: event.clientY, row });
  }

  function onKeyDown(event: KeyboardEvent) {
    const row = rows.find((row) => row.path === selected);
    if (!row || edit) return;
    if (event.key === "F2") startRename(row);
    else if (event.key === "Delete") trash(row);
    else return;
    event.preventDefault();
  }

  return (
    <>
      <div className="tree-actions" hidden={hidden}>
        <button
          title={t("explorer.newFile")}
          aria-label={t("explorer.newFile")}
          onClick={() => startCreate("file")}
        >
          <svg viewBox="0 0 16 16">
            <path d="M12.5 7V4.5l-3-3h-6v13H8M9.5 1.5v3h3M12 9.5v5M9.5 12h5" />
          </svg>
        </button>
        <button
          title={t("explorer.newFolder")}
          aria-label={t("explorer.newFolder")}
          onClick={() => startCreate("folder")}
        >
          <svg viewBox="0 0 16 16">
            <path d="M14.5 7.5V5H7L5.5 3.5h-4v9H8M12 9.5v5M9.5 12h5" />
          </svg>
        </button>
      </div>
      <div
        className="tree"
        role="tree"
        tabIndex={0}
        hidden={hidden}
        ref={viewport}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => openMenu(event, null)}
      >
        {rows.length === 0 && tree.listings.has("") && (
          <p className="hint">{t("explorer.empty")}</p>
        )}
        <div style={{ height: rows.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}>
          {rows.slice(first, last).map((row) =>
            row.edit ? (
              <div
                key={row.path}
                role="treeitem"
                aria-selected
                className="tree-row editing"
                style={{ paddingLeft: 8 + row.depth * 12 }}
                onContextMenu={(event) => event.stopPropagation()}
              >
                <RowIcon row={row} />
                <NameInput
                  row={row}
                  error={editError}
                  onChange={() => setEditError(null)}
                  onSubmit={submitEdit}
                  onCancel={endEdit}
                />
              </div>
            ) : (
              <div
                key={row.path}
                role="treeitem"
                aria-expanded={row.kind === "folder" ? row.expanded : undefined}
                aria-selected={row.path === selected}
                className={row.path === selected ? "tree-row sel" : "tree-row"}
                style={{ paddingLeft: 8 + row.depth * 12 }}
                onClick={() => select(row)}
                onDoubleClick={() => row.kind === "file" && onOpenFile(row.path, false)}
                onContextMenu={(event) => openMenu(event, row)}
              >
                <RowIcon row={row} />
                <RowName row={row} mark={markOf(marks, row)} />
              </div>
            ),
          )}
        </div>
      </div>
      {menu && <ContextMenu {...menu} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
    </>
  );
}

/**
 * Das Eingabefeld für einen Namen im Baum. Eingabe bestätigt, Esc verwirft;
 * wer das Feld verlässt, bestätigt ebenfalls, es sei denn, der Name wurde
 * gerade abgelehnt.
 */
function NameInput({
  row,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  row: Row;
  error: string | null;
  onChange: () => void;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);

  // Nur beim Erscheinen; der Name der Zeile ändert sich währenddessen nicht.
  useLayoutEffect(() => {
    input.current!.focus();
    input.current!.setSelectionRange(0, renameSelectionLength(row.name, row.kind));
  }, []);

  // Ein abgelehnter Name soll sich sofort korrigieren lassen.
  useEffect(() => {
    if (error) input.current!.focus();
  }, [error]);

  return (
    <>
      <input
        ref={input}
        className={error ? "tree-input invalid" : "tree-input"}
        defaultValue={row.name}
        aria-label={t("explorer.nameInput")}
        aria-invalid={error !== null}
        spellCheck={false}
        onChange={onChange}
        onKeyDown={(event) => {
          // Tasten im Feld gehören dem Feld, nicht dem Baum.
          event.stopPropagation();
          if (event.key === "Enter") onSubmit(event.currentTarget.value);
          else if (event.key === "Escape") onCancel();
        }}
        onBlur={(event) => (error ? onCancel() : onSubmit(event.currentTarget.value))}
      />
      {error && (
        <div className="tree-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/**
 * Der Name einer Zeile in der Farbe ihres Git-Status, dahinter das Kürzel der
 * Datei bzw. der Punkt eines Ordners, der Änderungen enthält.
 */
function RowName({ row, mark }: { row: Row; mark: GitMark | null }) {
  const t = useT();
  if (!mark) return <span className="tree-name">{row.name}</span>;
  const label =
    mark.status === "ignored"
      ? null
      : row.kind === "folder"
        ? t("explorer.containsChanges")
        : t(statusLabels[mark.status]);
  return (
    <>
      <span className={`tree-name git-${mark.status}`}>{row.name}</span>
      {label && (
        <span
          className={`tree-badge git-${mark.status}`}
          role="img"
          title={label}
          aria-label={label}
        >
          {mark.badge ?? "\u25cf"}
        </span>
      )}
    </>
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
