import { confirm, message } from "@tauri-apps/plugin-dialog";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { gitMarks, markOf, type GitMark, type GitMarks } from "./explorerGit";
import {
  childPath,
  emptyTree,
  expandFolder,
  folderFor,
  foldersToLoad,
  foldersToReload,
  receiveListing,
  revealPath,
  renameInTree,
  rootDrop,
  rowsOf,
  rowsWithEdit,
  toggleFolder,
  type Edit,
  type ExplorerTree,
  type Row,
  type RootDrop,
} from "./explorerTree";
import { fileIcon } from "./fileIcons";
import {
  fullPath,
  isOutsideProject,
  parentOf,
  folderKey,
  samePath,
  toProjectPath,
} from "./filePath";
import {
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
import { projectName } from "./project";
import { listFolder, watchProjectFiles, type Entry, type ProjectChanges } from "./projectFiles";
import { useVersionControl, VersionControlStore } from "./versionControl";
import { statusLabels } from "./versionControlState";
import { projectOf } from "./workspace";

/** Höhe einer Zeile in Pixeln; muss zu `.tree-row` passen. */
const ROW_HEIGHT = 22;
/** So viele Zeilen werden über und unter dem sichtbaren Ausschnitt mitgezeichnet. */
const OVERSCAN = 10;
/** Erst ab dieser Strecke gilt eine gedrückte Wurzel als gezogen (in Pixeln). */
const DRAG_THRESHOLD = 5;

interface ExplorerProps {
  /** Die Projekte des Fensters in Reihenfolge. */
  projects: readonly string[];
  /**
   * Der Name des Workspace; dann stehen die Projekte als Wurzeln im Baum.
   * `null` für ein einzelnes Projekt, dessen Einträge ganz oben stehen.
   */
  workspace: string | null;
  /** Fügt dem Fenster ein weiteres Projekt hinzu. */
  onAddProject: () => void;
  /** Nimmt das Projekt mit diesem Ordner aus dem Workspace. */
  onRemoveProject: (folder: string) => void;
  /** Setzt das Projekt an die Stelle `index` (gezählt vor dem Verschieben). */
  onMoveProject: (folder: string, index: number) => void;
  /** Gibt dem Workspace einen neuen Namen; schon bereinigt und nicht leer. */
  onRenameWorkspace: (name: string) => void;
  /** Steigt, wenn der Name des Workspace bearbeitet werden soll. */
  renameRequest: number;
  /** „Workspace schließen“: Das Fenster zeigt danach die Startseite. */
  onCloseWorkspace: () => void;
  hidden: boolean;
  /** Öffnet ein Terminal im Ordner mit diesem vollen Pfad, mit `agent` samt einem Agenten. */
  onOpenTerminalIn: (folder: string, agent: boolean) => void;
  /** Die Datei des sichtbaren Tabs der fokussierten Gruppe; sie wird hervorgehoben. */
  activeFile: string | null;
  /** Öffnet die Datei als Dateiansicht, mit `preview` als Vorschau-Tab. */
  onOpenFile: (path: string, preview: boolean) => void;
}

/** Ein Eintrag eines Projekts: das Projekt und der Pfad relativ zu seinem Ordner. */
interface Located {
  project: string;
  path: string;
}

/** Der Name, unter dem ein Projekt als Wurzel im Baum steht; ohne `/`. */
function rootSegment(project: string): string {
  return encodeURIComponent(folderKey(project));
}

/**
 * Der Ordnerbaum des Fensters. Ordnerinhalte werden erst beim Aufklappen
 * gelesen, und gezeichnet wird nur der sichtbare Ausschnitt: So bleibt auch
 * ein Ordner mit zehntausenden Einträgen flüssig.
 *
 * Im Workspace steht jedes Projekt als Wurzel im Baum. Seine Einträge liegen
 * dann unter einem eigenen ersten Pfadteil (`rootSegment`), sonst wie die
 * Einträge eines einzelnen Projekts direkt unter `""`.
 */
export function Explorer({
  projects,
  workspace,
  onAddProject,
  onRemoveProject,
  onMoveProject,
  onRenameWorkspace,
  renameRequest,
  onCloseWorkspace,
  hidden,
  onOpenTerminalIn,
  activeFile,
  onOpenFile,
}: ExplorerProps) {
  const t = useT();
  const roots = workspace !== null;
  /** Ändert sich nur, wenn sich die Projekte ändern, nicht mit jeder neuen Liste. */
  const projectsKey = projects.join("\n");
  const project = projects[0] ?? null;

  /** Projekt und Pfad im Projekt zu einem Pfad im Baum. */
  function locate(path: string): Located | null {
    if (!roots) return project === null ? null : { project, path };
    const segment = path.split("/", 1)[0];
    const owner = projects.find((candidate) => rootSegment(candidate) === segment);
    if (owner === undefined) return null;
    return { project: owner, path: path.slice(segment.length + 1) };
  }

  /** Der Pfad im Baum zu einem Pfad im Projekt. */
  function treePath(owner: string, path: string): string {
    if (!roots) return path;
    return childPath(rootSegment(owner), path).replace(/\/$/, "");
  }
  const [tree, setTree] = useState(emptyTree);
  const [selected, setSelected] = useState<string | null>(null);
  /** Die laufende Namenseingabe und die Meldung zu einem abgelehnten Namen. */
  const [edit, setEdit] = useState<Edit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** Das offene Kontextmenü; `row` fehlt beim Rechtsklick auf die freie Fläche. */
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row | null } | null>(null);
  /** Das offene „…“-Menü im Kopf der Ansicht. */
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const currentTree = useRef(tree);
  currentTree.current = tree;
  /** Die Namenseingabe, über die gerade entschieden wird; schützt vor doppeltem Abschicken. */
  const pendingEdit = useRef<Edit | null>(null);
  /** Ob der Name des Workspace gerade bearbeitet wird. */
  const [renaming, setRenaming] = useState(false);
  /** Die Anforderung, die schon bearbeitet ist; eine ältere zählt nach dem Neuaufbau nicht. */
  const handledRename = useRef(renameRequest);
  useEffect(() => {
    if (renameRequest === handledRename.current) return;
    handledRename.current = renameRequest;
    if (roots) setRenaming(true);
  }, [renameRequest]);
  // Wer die Ansicht wechselt, lässt den Namen, wie er war.
  useEffect(() => {
    if (hidden) setRenaming(false);
  }, [hidden]);
  /** Die gezogene Wurzel und wo sie landen würde. */
  const [rootDrag, setRootDrag] = useState<{ folder: string; drop: RootDrop | null } | null>(null);
  /** Wo eine Wurzel gedrückt wurde; erst ab einer kleinen Strecke gilt sie als gezogen. */
  const pressedRoot = useRef<{ folder: string; x: number; y: number } | null>(null);
  /** Gesetzt, bis der Klick ankommt, der nur das Loslassen nach dem Ziehen ist. */
  const justDragged = useRef(false);
  /** Die laufenden Leseaufträge: je Ordner die Nummer des jüngsten. */
  const requests = useRef(new Map<string, number>());
  const requestCount = useRef(0);

  /** Liest einen Ordner; von mehreren Aufträgen für denselben Ordner zählt nur der jüngste. */
  function load(folder: string) {
    // Die Wurzeln eines Workspace sind seine Projekte, in seiner Reihenfolge.
    if (roots && folder === "") return setTree((current) => withRoots(current, projects));
    const located = locate(folder);
    if (!located) return;
    const request = (requestCount.current += 1);
    requests.current.set(folder, request);
    listFolder(located.project, located.path)
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

  // Kommt ein Projekt hinzu, erscheint es als aufgeklappte Wurzel.
  useEffect(() => {
    if (roots) setTree((current) => withRoots(current, projects));
  }, [roots, projectsKey]);

  useEffect(() => {
    const stops = projects.map((owner) =>
      watchProjectFiles(owner, (changes) => {
        const inTree: ProjectChanges = {
          rescan: changes.rescan,
          paths: changes.paths.map((path) => treePath(owner, path)),
        };
        // Auch was gerade gelesen wird, kann schon wieder veraltet sein.
        const stale = new Set([
          ...foldersToReload(currentTree.current, inTree),
          ...requests.current.keys(),
        ]);
        stale.forEach((folder) => loadFolder.current(folder));
      }),
    );
    return () => stops.forEach((stop) => stop());
  }, [projectsKey]);

  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => rowsWithEdit(rowsOf(tree), edit), [tree, edit]);
  // Die Git-Markierungen folgen dem Zustand der Versionskontrolle des Fensters.
  // Im Workspace hat jedes Projekt seine eigenen.
  const { state: versionControl } = useVersionControl();
  const marks = useMemo(() => gitMarks(versionControl), [versionControl]);
  const projectMarks = useProjectMarks(projects, roots);
  /** Die Markierung einer Zeile, nachgeschlagen im Projekt, zu dem sie gehört. */
  function rowMark(row: Row): GitMark | null {
    if (!roots) return markOf(marks, row);
    const located = locate(row.path);
    const owned = located && projectMarks.get(located.project);
    return owned ? markOf(owned, { path: located.path, kind: row.kind }) : null;
  }
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
    if (activeFile === null) return;
    const path = activeFileInTree(activeFile);
    if (path === null) return;
    setSelected(path);
    setTree((current) => revealPath(current, path));
    revealing.current = path;
  }, [activeFile]);

  /**
   * Der Pfad im Baum zur Datei des aktiven Tabs; sie ist relativ zum ersten
   * Projekt oder ein voller Pfad. Nichts, wenn sie in keinem Projekt liegt.
   */
  function activeFileInTree(file: string): string | null {
    if (!isOutsideProject(file)) return project === null ? null : treePath(project, file);
    if (!roots) return null;
    const owner = projectOf(projects, file);
    return owner === null ? null : treePath(owner, toProjectPath(owner, file));
  }

  // Sobald ihre Zeile geladen ist, rückt sie einmal in den sichtbaren Ausschnitt.
  useEffect(() => {
    const path = revealing.current;
    if (path === null || hidden) return;
    const index = rows.findIndex((row) => samePath(row.path, path));
    if (index < 0) return;
    revealing.current = null;
    const element = viewport.current!;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
  }, [rows, hidden, activeFile]);

  function select(row: Row) {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    setSelected(row.path);
    if (row.kind === "folder") setTree((current) => toggleFolder(current, row.path));
    else onOpenFile(openPath(row.path), true);
  }

  /** Wie eine Datei des Baums der Oberfläche übergeben wird: im Workspace mit vollem Pfad. */
  function openPath(path: string): string {
    const located = roots ? locate(path) : null;
    return located ? fullPath(located.project, located.path) : path;
  }

  /** Ob die Zeile ein Projekt als Wurzel eines Workspace zeigt. */
  function isRoot(row: Row): boolean {
    return roots && row.depth === 0;
  }

  /** Eine Projektwurzel trägt den Namen ihres Projekts. */
  function rootRow(row: Row): Row {
    return { ...row, name: projectName(locate(row.path)?.project ?? row.name) };
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
    let folder = folderFor(row);
    // Ohne Auswahl entsteht der Eintrag im Workspace im ersten Projekt.
    if (roots && folder === "") {
      if (project === null) return;
      folder = rootSegment(project);
    }
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
    const located = locate(current.type === "create" ? current.folder : current.path);
    if (!located) return endEdit();
    pendingEdit.current = null;
    try {
      if (current.type === "create") {
        await createEntry(located.project, located.path, name, current.kind);
        setSelected(childPath(current.folder, name));
      } else {
        const renamed = childPath(parentOf(current.path), name);
        await renameEntry(located.project, located.path, name);
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
    const located = locate(row.path);
    if (confirmed && located) {
      trashEntry(located.project, located.path).catch((error) => report(error, row.name));
    }
  }

  function menuItems(row: Row | null): MenuItem[] {
    const located = row ? locate(row.path) : project === null ? null : { project, path: "" };
    if (!located) return [];
    const { project: owner, path } = located;
    const name = row && !isRoot(row) ? row.name : projectName(owner);
    const inFolder: MenuItem[] = [
      { label: t("explorer.newFile"), onSelect: () => startCreate("file", row) },
      { label: t("explorer.newFolder"), onSelect: () => startCreate("folder", row) },
      {
        label: t("explorer.terminalHere"),
        separator: true,
        onSelect: () => onOpenTerminalIn(fullPath(owner, path), false),
      },
      {
        label: t("explorer.agentHere"),
        onSelect: () => onOpenTerminalIn(fullPath(owner, path), true),
      },
    ];
    const items: MenuItem[] = [
      ...(row?.kind === "file" ? [] : inFolder),
      {
        label: t("explorer.reveal"),
        separator: row?.kind !== "file",
        onSelect: () => revealEntry(owner, path).catch((error) => report(error, name)),
      },
      {
        label: t("explorer.copyPath"),
        separator: true,
        onSelect: () => copyText(fullPath(owner, path)).catch((error) => report(error, name)),
      },
    ];
    // Eine Projektwurzel lässt sich hier weder umbenennen noch löschen, aber
    // aus dem Workspace nehmen.
    if (row && isRoot(row)) {
      return [
        ...items,
        { label: t("workspace.removeProject"), onSelect: () => onRemoveProject(owner) },
      ];
    }
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

  /** Wo die gezogene Wurzel unter dem Zeiger landen würde. */
  function dropUnder(clientY: number): RootDrop {
    const element = viewport.current!;
    const offset = clientY - element.getBoundingClientRect().top + element.scrollTop;
    const pointed = Math.floor(offset / ROW_HEIGHT);
    return rootDrop(rows, pointed, offset - pointed * ROW_HEIGHT < ROW_HEIGHT / 2);
  }

  /** Merkt sich die mit der linken Taste gedrückte Wurzel; gezogen ist sie damit noch nicht. */
  function pressRoot(event: PointerEvent<HTMLElement>, row: Row) {
    if (event.button !== 0 || !isRoot(row)) return;
    const folder = locate(row.path)?.project;
    if (folder) pressedRoot.current = { folder, x: event.clientX, y: event.clientY };
  }

  /** Bricht das Ziehen einer Wurzel ab; die Reihenfolge bleibt. */
  function cancelRootDrag() {
    pressedRoot.current = null;
    setRootDrag(null);
  }

  /** Zieht die gedrückte Wurzel, sobald der Zeiger sich weit genug bewegt hat. */
  function dragRoot(event: PointerEvent<HTMLElement>) {
    const pressed = pressedRoot.current;
    if (!pressed) return;
    // Wurde die Taste außerhalb des Baums losgelassen, ist nichts mehr gedrückt.
    if ((event.buttons & 1) === 0) return cancelRootDrag();
    if (!rootDrag) {
      const distance = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
      if (distance < DRAG_THRESHOLD) return;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setRootDrag({ folder: pressed.folder, drop: dropUnder(event.clientY) });
  }

  /** Lässt die gezogene Wurzel an der markierten Stelle los. */
  function dropRoot() {
    pressedRoot.current = null;
    if (!rootDrag) return;
    justDragged.current = true;
    // Kommt kein Klick mehr, gilt der nächste wieder.
    setTimeout(() => (justDragged.current = false));
    setRootDrag(null);
    if (rootDrag.drop) onMoveProject(rootDrag.folder, rootDrag.drop.index);
  }

  // Escape bricht das Ziehen einer Wurzel ab.
  useEffect(() => {
    if (!rootDrag) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      cancelRootDrag();
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [rootDrag !== null]);

  function onKeyDown(event: KeyboardEvent) {
    const row = rows.find((row) => row.path === selected);
    if (!row || edit || isRoot(row)) return;
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
        <button
          title={t("explorer.more")}
          aria-label={t("explorer.more")}
          aria-haspopup="menu"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setMoreMenu({ x: bounds.left, y: bounds.bottom });
          }}
        >
          <svg viewBox="0 0 16 16">
            <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />
          </svg>
        </button>
      </div>
      {roots && (
        <WorkspaceHead
          name={workspace}
          hidden={hidden}
          editing={renaming}
          onEdit={() => setRenaming(true)}
          onSubmit={(name) => {
            setRenaming(false);
            viewport.current?.focus();
            const trimmed = name.trim();
            if (trimmed !== "" && trimmed !== workspace) onRenameWorkspace(trimmed);
          }}
          onCancel={() => {
            setRenaming(false);
            viewport.current?.focus();
          }}
        />
      )}
      <div
        className={rootDrag ? "tree dragging-root" : "tree"}
        role="tree"
        tabIndex={0}
        hidden={hidden}
        ref={viewport}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => openMenu(event, null)}
        onPointerMove={dragRoot}
        onPointerUp={dropRoot}
        onLostPointerCapture={cancelRootDrag}
      >
        {roots && projects.length === 0 ? (
          <div className="empty-workspace">
            <p className="hint">{t("workspace.empty")}</p>
            <button className="btn" onClick={onAddProject}>
              {t("workspace.addFirstProject")}
            </button>
          </div>
        ) : (
          rows.length === 0 &&
          tree.listings.has("") && <p className="hint">{t("explorer.empty")}</p>
        )}
        <div
          className="tree-rows"
          style={{ height: rows.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}
        >
          {rootDrag?.drop && (
            <div className="tree-drop-line" style={{ top: rootDrag.drop.line * ROW_HEIGHT }} />
          )}
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
                className={[
                  "tree-row",
                  row.path === selected && "sel",
                  isRoot(row) && "root",
                  rootDrag && locate(row.path)?.project === rootDrag.folder && "dragged",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: 8 + row.depth * 12 }}
                title={isRoot(row) ? t("workspace.dragToReorder") : undefined}
                onPointerDown={(event) => pressRoot(event, row)}
                onClick={() => select(row)}
                onDoubleClick={() => row.kind === "file" && onOpenFile(openPath(row.path), false)}
                onContextMenu={(event) => openMenu(event, row)}
              >
                <RowIcon row={row} />
                <RowName row={isRoot(row) ? rootRow(row) : row} mark={rowMark(row)} />
              </div>
            ),
          )}
        </div>
      </div>
      {menu && <ContextMenu {...menu} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {moreMenu && (
        <ContextMenu
          {...moreMenu}
          items={[
            { label: t("workspace.addProject"), onSelect: onAddProject },
            ...(roots
              ? [
                  { label: t("workspace.renameMenu"), onSelect: () => setRenaming(true) },
                  { label: t("workspace.close"), separator: true, onSelect: onCloseWorkspace },
                ]
              : []),
          ]}
          onClose={() => setMoreMenu(null)}
        />
      )}
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
 * Der Kopf eines Workspace mit seinem Namen. Ein Doppelklick macht daraus ein
 * Eingabefeld: Eingabe und Verlassen übernehmen den Namen, Esc verwirft ihn.
 */
function WorkspaceHead({
  name,
  hidden,
  editing,
  onEdit,
  onSubmit,
  onCancel,
}: {
  name: string;
  hidden: boolean;
  editing: boolean;
  onEdit: () => void;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  /** Esc verwirft; das anschließende Verlassen des Felds übernimmt dann nichts. */
  const done = useRef(false);

  useLayoutEffect(() => {
    if (!editing) return;
    done.current = false;
    input.current?.focus();
    input.current?.select();
  }, [editing, hidden]);

  if (!editing || hidden) {
    return (
      <div
        className="tree-head"
        hidden={hidden}
        title={t("workspace.renameHint")}
        onDoubleClick={onEdit}
      >
        {t("workspace.label", { name })}
      </div>
    );
  }
  const finish = (submit: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (submit) onSubmit(value);
    else onCancel();
  };
  return (
    <div className="tree-head editing">
      <input
        ref={input}
        className="tree-input"
        defaultValue={name}
        aria-label={t("workspace.nameInput")}
        spellCheck={false}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") finish(true, event.currentTarget.value);
          else if (event.key === "Escape") finish(false, "");
        }}
        onBlur={(event) => finish(true, event.currentTarget.value)}
      />
    </div>
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

/**
 * Der Baum mit den Projekten als Wurzeln in ihrer Reihenfolge. Ein neues
 * Projekt erscheint aufgeklappt; was zu einem weggefallenen gehörte, entfällt.
 */
function withRoots(tree: ExplorerTree, projects: readonly string[]): ExplorerTree {
  const segments = projects.map(rootSegment);
  const known = new Set((tree.listings.get("") ?? []).map((entry) => entry.name));
  const kept = (path: string) => path === "" || segments.includes(path.split("/", 1)[0]);
  const listings = new Map([...tree.listings].filter(([path]) => kept(path)));
  listings.set(
    "",
    segments.map((name) => ({ name, kind: "folder" as const })),
  );
  const expanded = new Set([...tree.expanded].filter(kept));
  for (const segment of segments) if (!known.has(segment)) expanded.add(segment);
  return { listings, expanded };
}

/**
 * Die Git-Markierungen je Projekt eines Workspace. Jedes Projekt folgt dem
 * Zustand seiner eigenen Versionskontrolle.
 */
function useProjectMarks(
  projects: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, GitMarks> {
  const [marks, setMarks] = useState<ReadonlyMap<string, GitMarks>>(new Map());
  const projectsKey = projects.join("\n");
  useEffect(() => {
    if (!enabled) return;
    const stops = projects.map((project) => {
      const store = new VersionControlStore();
      const unsubscribe = store.subscribe(() => {
        const next = gitMarks(store.snapshot().state);
        setMarks((current) => new Map(current).set(project, next));
      });
      const unwatch = store.watch(project);
      return () => {
        unsubscribe();
        unwatch();
      };
    });
    return () => stops.forEach((stop) => stop());
  }, [projectsKey, enabled]);
  return marks;
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
