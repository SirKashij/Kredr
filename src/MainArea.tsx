import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  activateTab,
  focusGroup,
  moveDivider,
  openTab,
  renameTab,
  splitGroup,
  type Arrangement,
  type Group,
  type Split,
  type TreeNode,
} from "./arrangement";
import { AgentDot } from "./AgentStatusViews";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { useT } from "./i18n/i18n";
import type { RunningTerminals } from "./runningTerminals";
import type { Shell } from "./settingsStore";
import { shellLabel, tabLabel } from "./tabLabel";
import { TerminalView } from "./TerminalView";
import { useTabDrag, type TabDrag } from "./useTabDrag";

/** Schmaler lässt sich eine Gruppe mit der Trennlinie nicht ziehen (in Pixeln). */
const MIN_GROUP_SIZE = 80;

interface MainAreaProps {
  arrangement: Arrangement;
  terminals: RunningTerminals;
  /** Der Ordner des Projekts; darin starten die Terminals. */
  cwd: string;
  /** Die Shells, die sich für ein neues Terminal wählen lassen. */
  shells: Shell[];
  /** Steigt mit jeder Bedienung der Aufteilung; danach erhält das Terminal wieder den Fokus. */
  focusRequest: number;
  /** Wendet eine Operation auf die Aufteilung an. */
  update: (change: (arrangement: Arrangement) => Arrangement) => void;
  /** Schließt ein Terminal, bei laufendem Kindprozess nach Rückfrage. */
  onCloseTab: (tabId: string) => void;
  /** Gibt dem Terminal die Tastatureingaben zurück, ohne die Aufteilung zu ändern. */
  onRefocus: () => void;
}

/** Was jeder Teil des Baums braucht. */
type Shared = MainAreaProps & { onOpenMenu: (menu: Menu) => void; tabDrag: Omit<TabDrag, "drop"> };

interface Menu {
  x: number;
  y: number;
  items: MenuItem[];
}

type IconName = "new" | "chooseShell" | "agent" | "splitRight" | "splitDown" | "close";

const icons: Record<IconName, ReactNode> = {
  new: <path d="M8 3v10M3 8h10" />,
  chooseShell: <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />,
  agent: (
    <>
      <rect x="3" y="6" width="10" height="7" rx="1.5" />
      <path d="M8 6V3.5M6.3 9v1.2M9.7 9v1.2" />
    </>
  ),
  splitRight: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M8 3v10" />
    </>
  ),
  splitDown: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M2.5 8h11" />
    </>
  ),
  close: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
};

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg className="icon" viewBox="0 0 16 16">
      {icons[name]}
    </svg>
  );
}

/** Der Hauptbereich: die Gruppen der Aufteilung mit ihren Tabs und Trennlinien. */
export function MainArea(props: MainAreaProps) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const { root } = props.arrangement;
  const { drop, ...tabDrag } = useTabDrag(props.arrangement, props.update, props.onRefocus);
  return (
    <>
      {root && <NodeView node={root} {...props} onOpenMenu={setMenu} tabDrag={tabDrag} />}
      {drop && (
        <div
          className="drop-marker"
          style={{
            left: drop.marker.left,
            top: drop.marker.top,
            width: drop.marker.right - drop.marker.left,
            height: drop.marker.bottom - drop.marker.top,
          }}
        />
      )}
      {menu && (
        <ContextMenu
          {...menu}
          onClose={() => {
            setMenu(null);
            // Der Rechtsklick hat dem Terminal den Fokus genommen.
            props.onRefocus();
          }}
        />
      )}
    </>
  );
}

function NodeView({ node, ...shared }: Shared & { node: TreeNode }) {
  return node.kind === "group" ? (
    <GroupView group={node} {...shared} />
  ) : (
    <SplitView split={node} {...shared} />
  );
}

function SplitView({ split, ...shared }: Shared & { split: Split }) {
  const container = useRef<HTMLDivElement>(null);

  function drag(event: PointerEvent<HTMLDivElement>, index: number) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = container.current!.getBoundingClientRect();
    const [offset, extent] =
      split.axis === "row"
        ? [event.clientX - box.left, box.width]
        : [event.clientY - box.top, box.height];
    shared.update((arrangement) =>
      moveDivider(arrangement, split.id, index, offset / extent, MIN_GROUP_SIZE / extent),
    );
  }

  return (
    <div className={`split ${split.axis}`} ref={container}>
      {split.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <div
              className="divider"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => drag(event, index - 1)}
            />
          )}
          <div className="split-part" style={{ flexGrow: split.sizes[index] }}>
            <NodeView node={child} {...shared} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** Das Eingabefeld, in dem ein Tab seinen Namen erhält. `null` heißt: abgebrochen. */
function TabNameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  /** Nach Eingabe oder Escape meldet der Verlust des Fokus nichts mehr. */
  const done = useRef(false);

  useEffect(() => {
    input.current!.focus();
    input.current!.select();
  }, []);

  function finish(name: string | null) {
    if (done.current) return;
    done.current = true;
    onDone(name);
  }

  return (
    <input
      ref={input}
      className="tab-name-input"
      defaultValue={initial}
      size={Math.max(initial.length, 8)}
      spellCheck={false}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(null);
      }}
      // Im Eingabefeld markiert die Maus Text und zieht nicht den Tab.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

function GroupView({ group, ...shared }: Shared & { group: Group }) {
  const t = useT();
  const { arrangement, terminals, shells, update, onCloseTab, onOpenMenu, tabDrag } = shared;
  /** Der Tab, dessen Name gerade bearbeitet wird. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTab)!;

  const newTerminal = (shell?: Shell) =>
    update((current) => openTab(focusGroup(current, group.id), false, shell));
  const newAgent = () => update((current) => openTab(focusGroup(current, group.id), true));
  const splitRight = () => update((current) => splitGroup(current, group.id, "right"));
  const splitDown = () => update((current) => splitGroup(current, group.id, "down"));

  function openMenu(event: MouseEvent, tabId?: string) {
    event.preventDefault();
    event.stopPropagation();
    const items: MenuItem[] = [
      { label: t("agent.new"), onSelect: newAgent },
      { label: t("terminal.new"), onSelect: () => newTerminal() },
      { label: t("group.splitRight"), onSelect: splitRight },
      { label: t("group.splitDown"), onSelect: splitDown },
    ];
    if (tabId) {
      items.push(
        { label: t("tab.rename"), onSelect: () => setRenaming(tabId) },
        { label: t("tab.close"), onSelect: () => onCloseTab(tabId) },
      );
    }
    onOpenMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** Das Menü unter dem Knopf, das die Shell des neuen Terminals wählen lässt. */
  function openShellMenu(event: MouseEvent) {
    const { left, bottom } = event.currentTarget.getBoundingClientRect();
    const items = shells.map((shell) => ({
      label: shellLabel(shell, t),
      onSelect: () => newTerminal(shell),
    }));
    onOpenMenu({ x: left, y: bottom, items });
  }

  /** Rechtsklick ins Terminal: Kopieren und Einfügen. */
  function openTerminalMenu(event: MouseEvent) {
    event.preventDefault();
    const terminal = terminals.find(activeTab.id);
    if (!terminal) return;
    const items: MenuItem[] = [{ label: t("terminal.paste"), onSelect: () => terminal.paste() }];
    if (terminal.hasSelection()) {
      items.unshift({ label: t("terminal.copy"), onSelect: () => terminal.copySelection() });
    }
    onOpenMenu({ x: event.clientX, y: event.clientY, items });
  }

  return (
    <section
      className={group.id === arrangement.focusedGroup ? "group focused" : "group"}
      data-group={group.id}
      onPointerDownCapture={() => update((current) => focusGroup(current, group.id))}
    >
      <div className="tabs" onContextMenu={(event) => openMenu(event)}>
        <div className="tab-list" role="tablist">
          {group.tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === group.activeTab}
              className={[
                "tab",
                tab.id === group.activeTab && "on",
                tab.id === tabDrag.tabId && "dragging",
              ]
                .filter(Boolean)
                .join(" ")}
              data-tab={tab.id}
              {...tabDrag.handlers(tab.id)}
              onClick={() => {
                // Das Loslassen nach dem Ziehen ist kein Klick auf den Tab.
                if (!tabDrag.justEndedDrag()) update((current) => activateTab(current, tab.id));
              }}
              onAuxClick={(event) => {
                // Mittelklick schließt wie in VS Code.
                if (event.button === 1) onCloseTab(tab.id);
              }}
              onDoubleClick={() => setRenaming(tab.id)}
              onContextMenu={(event) => openMenu(event, tab.id)}
            >
              {tab.agent ? (
                <AgentDot
                  statuses={shared.terminals.statuses}
                  tabId={tab.id}
                  fallback={
                    <span className="tab-icon agent">
                      <Icon name="agent" />
                    </span>
                  }
                />
              ) : (
                <span className="tab-icon">›_</span>
              )}
              {tab.id === renaming ? (
                <TabNameInput
                  initial={tabLabel(tab, t)}
                  onDone={(name) => {
                    setRenaming(null);
                    // Auch ohne Änderung: Das Terminal erhält die Eingaben zurück.
                    update((current) =>
                      name === null ? current : renameTab(current, tab.id, name),
                    );
                  }}
                />
              ) : (
                <span title={t("tab.renameTooltip")}>{tabLabel(tab, t)}</span>
              )}
              <button
                className="tab-close"
                title={t("tab.closeTooltip")}
                aria-label={t("tab.close")}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <div className="tab-actions">
          <button title={t("agent.newTooltip")} aria-label={t("agent.new")} onClick={newAgent}>
            <Icon name="agent" />
          </button>
          <button
            title={t("terminal.newTooltip")}
            aria-label={t("terminal.new")}
            onClick={() => newTerminal()}
          >
            <Icon name="new" />
          </button>
          {shells.length > 1 && (
            <button
              className="narrow"
              title={t("terminal.chooseShell")}
              aria-label={t("terminal.chooseShell")}
              onClick={openShellMenu}
            >
              <Icon name="chooseShell" />
            </button>
          )}
          <button
            title={t("group.splitRightTooltip")}
            aria-label={t("group.splitRight")}
            onClick={splitRight}
          >
            <Icon name="splitRight" />
          </button>
          <button
            title={t("group.splitDownTooltip")}
            aria-label={t("group.splitDown")}
            onClick={splitDown}
          >
            <Icon name="splitDown" />
          </button>
        </div>
      </div>
      <TerminalView
        key={group.activeTab}
        terminals={shared.terminals}
        tab={activeTab}
        cwd={activeTab.cwd ?? shared.cwd}
        // Solange ein Tab seinen Namen erhält, gehören die Eingaben dem Eingabefeld.
        focused={group.id === arrangement.focusedGroup && renaming === null}
        focusRequest={shared.focusRequest}
        onContextMenu={openTerminalMenu}
      />
    </section>
  );
}
