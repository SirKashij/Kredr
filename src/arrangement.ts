/**
 * Die Aufteilung des Hauptbereichs als reines Zustandsmodell: ein Baum aus
 * Teilungen und Gruppen, jede Gruppe mit ihren Tabs. Jede Operation liefert
 * eine neue Aufteilung und lässt die alte unverändert. Der Zustand besteht
 * nur aus einfachen Daten und lässt sich deshalb als JSON speichern.
 */

import { pathKey, samePath } from "./filePath";
import { isShell, type Shell } from "./settingsStore";

export interface Tab {
  id: string;
  /** Der selbst vergebene Name; ohne ihn heißt das Terminal wie seine Shell. */
  name?: string;
  /** Die Shell des Terminals; fehlt nur, bis `assignShell` die Standard-Shell einträgt. */
  shell?: Shell;
  /** Gesetzt, wenn in diesem Terminal ein Agent gestartet wurde. */
  agent?: true;
  /** Der Startordner des Terminals, wenn es nicht im Projektordner startet. */
  cwd?: string;
  /** Was der Tab zeigt; fehlt bei einem Terminal. */
  content?: TabContent;
  /** Gesetzt bei einem Vorschau-Tab: Die nächste Vorschau seiner Gruppe ersetzt ihn. */
  preview?: true;
  /**
   * Das Gespräch des Agenten, der gerade im Terminal läuft; beim nächsten
   * Öffnen des Projekts wird es fortgesetzt. Fehlt, sobald der Agent endet.
   */
  conversation?: Conversation;
}

/** Das Gespräch eines Agenten, wie die Aufteilung es sich merkt. */
export interface Conversation {
  /** Die Art des Agenten; bisher kennt Kredr nur Claude Code. */
  agent: "claudeCode";
  /** Die Kennung, unter der der Agent das Gespräch fortsetzt. */
  id: string;
  /** Der Auftrag des Gesprächs. */
  assignment?: string;
  /** Gesetzt, solange der Agent arbeitet; beim Öffnen heißt das: unterbrochen. */
  working?: true;
}

/**
 * Der Inhalt eines Tabs, der kein Terminal ist. Jede weitere Tab-Art (Diff,
 * Versionskontrolle, Bild …) ist ein weiterer Fall mit eigenem `kind`.
 */
export type TabContent =
  | FileTabContent
  /** Die Versionskontrolle mit dem großen Diff; es gibt sie nur einmal. */
  | { kind: "versionControl" };

/** Der Inhalt eines Tabs, der eine Datei zeigt. */
export interface FileTabContent {
  /**
   * `file`: eine Dateiansicht. `markdown`: die gerenderte Vorschau einer
   * Markdown-Datei. `image`: eine Bilddatei als Bild.
   */
  kind: "file" | "markdown" | "image";
  /** Relativ zum Projektordner und mit `/` getrennt; außerhalb des Projekts der volle Pfad. */
  path: string;
}

/** Ob der Tab eine Datei zeigt, in welcher Ansicht auch immer. */
export function showsFile(content: TabContent | undefined): content is FileTabContent {
  return content !== undefined && content.kind !== "versionControl";
}

/**
 * Ob der Tab den Text einer Datei hält, samt ungespeicherter Änderungen: ihre
 * Dateiansicht und ihre Markdown-Vorschau (beide zeigen denselben Text).
 */
export function holdsFileText(content: TabContent): content is FileTabContent {
  return content.kind === "file" || content.kind === "markdown";
}

/**
 * Ob mit dem Tab der letzte schließt, der den Text seiner Datei hält; erst
 * dann gingen ungespeicherte Änderungen verloren.
 */
export function closesFileText(arrangement: Arrangement, tabId: string): boolean {
  const tabs = tabsOf(arrangement);
  const content = tabs.find((tab) => tab.id === tabId)?.content;
  if (!content || !holdsFileText(content)) return false;
  const path = pathKey(content.path);
  return !tabs.some(
    (tab) =>
      tab.id !== tabId &&
      tab.content &&
      holdsFileText(tab.content) &&
      pathKey(tab.content.path) === path,
  );
}

/** Ob der Tab ein Terminal ist (gewöhnlich oder mit Agent). */
export function isTerminal(tab: Tab): boolean {
  return !tab.content;
}

/** Der Pfad der Datei, die der Tab zeigt; fehlt bei Terminals und der Versionskontrolle. */
export function filePathOf(tab: Tab | undefined): string | undefined {
  return showsFile(tab?.content) ? tab?.content.path : undefined;
}

/** Ob beide dasselbe zeigen; ein Inhalt ist im Hauptbereich nur einmal offen. */
export function sameContent(a: TabContent, b: TabContent): boolean {
  if (a.kind !== b.kind) return false;
  if (!showsFile(a) || !showsFile(b)) return true;
  return samePath(a.path, b.path);
}

/** Eine Gruppe: ein Teilstück des Hauptbereichs mit eigener Tab-Leiste. */
export interface Group {
  kind: "group";
  id: string;
  /** Nie leer; eine Gruppe ohne Tabs verschwindet. */
  tabs: Tab[];
  /** Kennung des sichtbaren Tabs. */
  activeTab: string;
}

/** Eine Teilung: mindestens zwei Teilstücke neben- oder untereinander. */
export interface Split {
  kind: "split";
  id: string;
  /** `row`: nebeneinander, `column`: untereinander. */
  axis: "row" | "column";
  children: TreeNode[];
  /** Anteil jedes Teilstücks an der Teilung; zusammen 1. */
  sizes: number[];
}

export type TreeNode = Group | Split;

export interface Arrangement {
  /** Version des gespeicherten Formats. */
  version: 1;
  /** `null`, solange kein Tab offen ist. */
  root: TreeNode | null;
  /** Die Gruppe, die Tastatureingaben erhält. */
  focusedGroup: string | null;
  /** Zähler für die nächste vergebene Kennung. */
  nextId: number;
  /**
   * Kennung des maximierten Tabs. Solange er der sichtbare Tab der
   * fokussierten Gruppe ist, verdeckt seine Gruppe alle übrigen
   * (siehe `maximizedGroupOf`).
   */
  maximized?: string;
}

export const emptyArrangement: Arrangement = {
  version: 1,
  root: null,
  focusedGroup: null,
  nextId: 1,
};

/** Alle Gruppen in Lesereihenfolge: von links nach rechts, von oben nach unten. */
export function groupsOf(arrangement: Arrangement): Group[] {
  const groups: Group[] = [];
  const collect = (node: TreeNode) => {
    if (node.kind === "group") groups.push(node);
    else node.children.forEach(collect);
  };
  if (arrangement.root) collect(arrangement.root);
  return groups;
}

/** Alle Tabs in der Reihenfolge ihrer Gruppen. */
export function tabsOf(arrangement: Arrangement): Tab[] {
  return groupsOf(arrangement).flatMap((group) => group.tabs);
}

function groupOfTab(arrangement: Arrangement, tabId: string): Group | undefined {
  return groupsOf(arrangement).find((group) => group.tabs.some((tab) => tab.id === tabId));
}

function newTab(nextId: number, agent: boolean, shell?: Shell): Tab {
  const tab: Tab = { id: `t${nextId}` };
  if (agent) tab.agent = true;
  if (shell) tab.shell = shell;
  return tab;
}

/** Eine neue Gruppe mit einem neuen Tab; sie verbraucht zwei Kennungen. */
function newGroup(nextId: number, agent = false, shell?: Shell): Group {
  const tab = newTab(nextId, agent, shell);
  return { kind: "group", id: `g${nextId + 1}`, tabs: [tab], activeTab: tab.id };
}

/**
 * Öffnet einen neuen Tab in der fokussierten Gruppe und zeigt ihn an. Ohne
 * Gruppen entsteht die erste; hat keine Gruppe den Fokus, nimmt ihn die erste.
 * Mit `agent` ist es ein Terminal, in dem ein Agent startet; mit `shell`
 * läuft darin diese Shell statt der Standard-Shell.
 */
export function openTab(arrangement: Arrangement, agent = false, shell?: Shell): Arrangement {
  const { root, nextId } = arrangement;
  if (!root) {
    const group = newGroup(nextId, agent, shell);
    return { ...arrangement, root: group, focusedGroup: group.id, nextId: nextId + 2 };
  }
  const target = focusedGroupOf(arrangement) ?? groupsOf(arrangement)[0];
  const tab = newTab(nextId, agent, shell);
  return {
    ...arrangement,
    root: replaceGroup(root, target.id, (group) => ({
      ...group,
      tabs: [...group.tabs, tab],
      activeTab: tab.id,
    })),
    focusedGroup: target.id,
    nextId: nextId + 1,
  };
}

/**
 * Öffnet wie `openTab` einen neuen Tab, dessen Terminal aber im Ordner `cwd`
 * startet („Terminal hier öffnen“, „Agent hier starten“).
 */
export function openTabIn(arrangement: Arrangement, cwd: string, agent = false): Arrangement {
  const opened = openTab(arrangement, agent);
  const target = focusedGroupOf(opened);
  if (!opened.root || !target) return opened;
  const root = replaceGroup(opened.root, target.id, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) => (tab.id === group.activeTab ? { ...tab, cwd } : tab)),
  }));
  return { ...opened, root };
}

/**
 * Legt die Tabs mit neuen Kennungen als eigene Gruppe rechts neben alles
 * Bisherige; der Fokus bleibt, wo er ist. Ohne Tabs bleibt alles, wie es war.
 */
export function addGroupBeside(arrangement: Arrangement, tabs: readonly Tab[]): Arrangement {
  if (tabs.length === 0) return arrangement;
  let nextId = arrangement.nextId;
  const renamed = tabs.map((tab) => ({ ...tab, id: `t${nextId++}` }));
  const group: Group = {
    kind: "group",
    id: `g${nextId++}`,
    tabs: renamed,
    activeTab: renamed[0].id,
  };
  if (!arrangement.root) return { ...arrangement, root: group, focusedGroup: group.id, nextId };
  const split: Split = {
    kind: "split",
    id: `s${nextId++}`,
    axis: "row",
    children: [arrangement.root, group],
    sizes: [0.5, 0.5],
  };
  return { ...arrangement, root: tidy(split), nextId };
}

/**
 * Teilt die Gruppe: rechts von ihr oder unter ihr entsteht eine neue Gruppe
 * mit einem neuen Tab, die die Hälfte ihres Platzes übernimmt und den Fokus erhält.
 */
export function splitGroup(
  arrangement: Arrangement,
  groupId: string,
  direction: "right" | "down",
): Arrangement {
  if (!arrangement.root || !groupsOf(arrangement).some((group) => group.id === groupId)) {
    return arrangement;
  }
  const { nextId } = arrangement;
  const added = newGroup(nextId);
  const root = replaceGroup(arrangement.root, groupId, (group) => ({
    kind: "split",
    id: `s${nextId + 2}`,
    axis: direction === "right" ? "row" : "column",
    children: [group, added],
    sizes: [0.5, 0.5],
  }));
  return { ...arrangement, root: tidy(root), focusedGroup: added.id, nextId: nextId + 3 };
}

/** Schließt den Tab. War er sichtbar, rückt sein rechter Nachbar nach, sonst der linke. */
export function closeTab(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  const root = tidy(replaceGroup(arrangement.root, group.id, () => withoutTab(group, tabId)));
  // Mit dem maximierten Tab endet das Maximieren.
  const remaining = arrangement.maximized === tabId ? restoreGroups(arrangement) : arrangement;
  if (group.tabs.length > 1 || arrangement.focusedGroup !== group.id) {
    return { ...remaining, root };
  }

  // Die fokussierte Gruppe ist verschwunden: Der Fokus geht an die Gruppe
  // davor, sonst an die danach.
  const before = groupsOf(arrangement);
  const position = before.indexOf(group);
  const heir = before[position - 1] ?? before[position + 1];
  return { ...remaining, root, focusedGroup: heir?.id ?? null };
}

/**
 * Maximiert den Tab: Er wird sichtbar, seine Gruppe erhält den Fokus und
 * verdeckt die übrigen Gruppen. Deren Tabs bleiben, wo sie sind.
 */
export function maximizeTab(arrangement: Arrangement, tabId: string): Arrangement {
  if (!groupOfTab(arrangement, tabId)) return arrangement;
  return { ...activateTab(arrangement, tabId), maximized: tabId };
}

/** Beendet das Maximieren; alle Gruppen sind wieder zu sehen. */
export function restoreGroups(arrangement: Arrangement): Arrangement {
  if (arrangement.maximized === undefined) return arrangement;
  const { maximized: _, ...restored } = arrangement;
  return restored;
}

/**
 * Die Gruppe, die gerade alle übrigen verdeckt. Das gilt nur, solange der
 * maximierte Tab der sichtbare Tab der fokussierten Gruppe ist: Wer ein
 * Terminal nach vorn holt oder daneben einen Tab öffnet, sieht wieder alles.
 */
export function maximizedGroupOf(arrangement: Arrangement): Group | null {
  const group = focusedGroupOf(arrangement);
  return group && group.activeTab === arrangement.maximized ? group : null;
}

/**
 * Zeigt den Tab der Versionskontrolle und öffnet ihn, wenn es ihn noch nicht
 * gibt. Beim Öffnen ist er maximiert; ein vorhandener Tab wird es nur mit
 * `maximize` erneut (Klick auf das Symbol der Versionskontrolle).
 */
export function showVersionControl(arrangement: Arrangement, maximize: boolean): Arrangement {
  const isShown = (tab: Tab) => tab.content?.kind === "versionControl";
  const existed = tabsOf(arrangement).some(isShown);
  const shown = openContent(arrangement, { kind: "versionControl" });
  if (existed && !maximize) return shown;
  return maximizeTab(shown, tabsOf(shown).find(isShown)!.id);
}

/**
 * Gibt dem Tab einen eigenen Namen. Ein leerer Name nimmt ihn wieder weg;
 * der Tab heißt dann wie seine Shell.
 */
export function renameTab(arrangement: Arrangement, tabId: string, name: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  const trimmed = name.trim();
  const rename = ({ name: _, ...tab }: Tab): Tab => (trimmed ? { ...tab, name: trimmed } : tab);
  const tabs = group.tabs.map((tab) => (tab.id === tabId ? rename(tab) : tab));
  const root = replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs }));
  return { ...arrangement, root };
}

/**
 * Merkt sich das Gespräch des Agenten im Terminal; ohne `conversation` ist
 * es vergessen. Ändert sich nichts, kommt dieselbe Aufteilung zurück.
 */
export function recordConversation(
  arrangement: Arrangement,
  tabId: string,
  conversation: Conversation | undefined,
): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  const tab = group.tabs.find((tab) => tab.id === tabId)!;
  if (sameConversation(tab.conversation, conversation)) return arrangement;
  const { conversation: _, ...rest } = tab;
  const changed = conversation ? { ...rest, conversation } : rest;
  const tabs = group.tabs.map((each) => (each.id === tabId ? changed : each));
  const root = replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs }));
  return { ...arrangement, root };
}

/**
 * Macht aus dem Agenten im Terminal ein gewöhnliches Terminal am selben Platz,
 * etwa weil sich sein Gespräch nicht fortsetzen ließ. Name, Shell und
 * Startordner bleiben.
 */
export function endAgent(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  const tab = group?.tabs.find((tab) => tab.id === tabId);
  if (!arrangement.root || !group || !tab?.agent) return arrangement;
  const { agent: _, conversation: __, ...terminal } = tab;
  const tabs = group.tabs.map((each) => (each.id === tabId ? terminal : each));
  const root = replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs }));
  return { ...arrangement, root };
}

/** Ob zwei Gespräche in allem übereinstimmen, was die Aufteilung sich merkt. */
function sameConversation(a: Conversation | undefined, b: Conversation | undefined): boolean {
  return (
    a?.agent === b?.agent &&
    a?.id === b?.id &&
    a?.assignment === b?.assignment &&
    a?.working === b?.working
  );
}

/**
 * Trägt bei jedem Terminal, für das keine Shell gewählt wurde, `shell` ein: die
 * Standard-Shell zum Zeitpunkt seines Entstehens. Eine spätere Änderung der
 * Standard-Shell lässt bestehende Terminals damit unberührt.
 */
export function assignShell(arrangement: Arrangement, shell: Shell): Arrangement {
  const settled = (tab: Tab) => tab.shell !== undefined || !isTerminal(tab);
  if (!arrangement.root || tabsOf(arrangement).every(settled)) return arrangement;
  const assign = (node: TreeNode): TreeNode =>
    node.kind === "group"
      ? { ...node, tabs: node.tabs.map((tab) => (settled(tab) ? tab : { ...tab, shell })) }
      : { ...node, children: node.children.map(assign) };
  return { ...arrangement, root: assign(arrangement.root) };
}

/** Wohin ein Tab verschoben wird. */
export type TabTarget =
  | {
      /** In die Tab-Leiste dieser Gruppe. */
      groupId: string;
      /** Lücke der Tab-Leiste, wie sie vor dem Verschieben aussieht: 0 vor dem ersten Tab, die Anzahl der Tabs nach dem letzten. */
      index: number;
    }
  | {
      /** An den Rand dieser Gruppe; dort entsteht eine neue Gruppe. */
      groupId: string;
      side: Side;
    };

/**
 * Verschiebt den Tab an das Ziel. Dort wird er sichtbar, und seine neue Gruppe
 * erhält den Fokus. In der alten Gruppe rückt ein Nachbar nach wie beim
 * Schließen; verliert sie ihren letzten Tab, verschwindet sie. An einem Rand
 * übernimmt die neue Gruppe die Hälfte des Platzes der Zielgruppe.
 */
export function moveTab(arrangement: Arrangement, tabId: string, target: TabTarget): Arrangement {
  const source = groupOfTab(arrangement, tabId);
  const destination = groupsOf(arrangement).find((group) => group.id === target.groupId);
  if (!arrangement.root || !source || !destination) return arrangement;
  const sourceIndex = source.tabs.findIndex((tab) => tab.id === tabId);
  const tab = source.tabs[sourceIndex];
  const without = replaceGroup(arrangement.root, source.id, (group) => withoutTab(group, tabId));

  if ("side" in target) {
    // Der einzige Tab einer Gruppe hätte neben sich nur eine leere Gruppe.
    if (source === destination && source.tabs.length === 1) return arrangement;
    const { nextId } = arrangement;
    const added: Group = { kind: "group", id: `g${nextId}`, tabs: [tab], activeTab: tab.id };
    const addedFirst = target.side === "left" || target.side === "up";
    const root = replaceGroup(without, destination.id, (group) => ({
      kind: "split",
      id: `s${nextId + 1}`,
      axis: target.side === "left" || target.side === "right" ? "row" : "column",
      children: addedFirst ? [added, group] : [group, added],
      sizes: [0.5, 0.5],
    }));
    return { ...arrangement, root: tidy(root), focusedGroup: added.id, nextId: nextId + 2 };
  }

  // Fehlt der Tab links von der Lücke, liegt sie eine Stelle weiter vorn.
  const shift = source === destination && sourceIndex < target.index ? 1 : 0;
  const root = replaceGroup(without, destination.id, (group) => {
    const tabs = [...group.tabs];
    tabs.splice(target.index - shift, 0, tab);
    return { ...group, tabs, activeTab: tab.id };
  });
  return { ...arrangement, root: tidy(root), focusedGroup: destination.id };
}

/** Die Gruppe ohne den Tab. War er sichtbar, rückt sein rechter Nachbar nach, sonst der linke. */
function withoutTab(group: Group, tabId: string): Group {
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = group.tabs.filter((tab) => tab.id !== tabId);
  // Bleibt kein Tab übrig, räumt `tidy` die Gruppe ab.
  const successor = tabs[index] ?? tabs.at(-1);
  const activeTab = group.activeTab === tabId && successor ? successor.id : group.activeTab;
  return { ...group, tabs, activeTab };
}

/**
 * Stellt die Regeln des Baums wieder her: Eine Gruppe ohne Tabs verschwindet,
 * ihre Nachbarn teilen sich ihren Platz im bisherigen Verhältnis. Eine Teilung
 * in derselben Richtung wie die umgebende geht in dieser auf, und eine Teilung
 * mit nur einem Teilstück wird durch dieses ersetzt.
 */
function tidy(node: TreeNode): TreeNode | null {
  if (node.kind === "group") return node.tabs.length > 0 ? node : null;
  const children: TreeNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((original, index) => {
    const child = tidy(original);
    if (!child) return;
    if (child.kind === "split" && child.axis === node.axis) {
      children.push(...child.children);
      sizes.push(...child.sizes.map((size) => size * node.sizes[index]));
    } else {
      children.push(child);
      sizes.push(node.sizes[index]);
    }
  });
  if (children.length < 2) return children[0] ?? null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return { ...node, children, sizes: sizes.map((size) => size / total) };
}

/** Ersetzt die Gruppe mit der Kennung `id` durch das Ergebnis von `change`. */
function replaceGroup(
  node: TreeNode,
  id: string | null,
  change: (group: Group) => TreeNode,
): TreeNode {
  if (node.kind === "group") return node.id === id ? change(node) : node;
  return { ...node, children: node.children.map((child) => replaceGroup(child, id, change)) };
}

/**
 * Öffnet einen Inhalt (etwa eine Dateiansicht) als Tab der fokussierten
 * Gruppe, rechts neben ihrem sichtbaren Tab, und zeigt ihn an. Ist der Inhalt
 * schon irgendwo offen, wird stattdessen jener Tab angezeigt. Mit `preview`
 * entsteht ein Vorschau-Tab, der den bisherigen Vorschau-Tab der Gruppe
 * ersetzt; ohne `preview` ist der Tab dauerhaft, auch wenn er zuvor Vorschau war.
 */
export function openContent(
  arrangement: Arrangement,
  content: TabContent,
  preview = false,
): Arrangement {
  const existing = tabsOf(arrangement).find(
    (tab) => tab.content && sameContent(tab.content, content),
  );
  if (existing) {
    const shown = activateTab(arrangement, existing.id);
    return preview ? shown : keepTab(shown, existing.id);
  }

  const { root, nextId } = arrangement;
  const added: Tab = preview
    ? { id: `t${nextId}`, content, preview }
    : { id: `t${nextId}`, content };
  if (!root) {
    const group: Group = {
      kind: "group",
      id: `g${nextId + 1}`,
      tabs: [added],
      activeTab: added.id,
    };
    return { ...arrangement, root: group, focusedGroup: group.id, nextId: nextId + 2 };
  }
  const target = focusedGroupOf(arrangement) ?? groupsOf(arrangement)[0];
  const replaced = preview ? target.tabs.find((tab) => tab.preview) : undefined;
  if (replaced) {
    // Der Vorschau-Tab behält Platz und Kennung und zeigt nur etwas anderes.
    const tabs = target.tabs.map((tab) => (tab === replaced ? { ...tab, content } : tab));
    return {
      ...arrangement,
      root: replaceGroup(root, target.id, (group) => ({ ...group, tabs, activeTab: replaced.id })),
      focusedGroup: target.id,
    };
  }
  const tabs = [...target.tabs];
  tabs.splice(tabs.findIndex((tab) => tab.id === target.activeTab) + 1, 0, added);
  return {
    ...arrangement,
    root: replaceGroup(root, target.id, (group) => ({ ...group, tabs, activeTab: added.id })),
    focusedGroup: target.id,
    nextId: nextId + 1,
  };
}

/** Macht aus einem Vorschau-Tab einen dauerhaften. */
export function keepTab(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group?.tabs.some((tab) => tab.id === tabId && tab.preview)) {
    return arrangement;
  }
  const keep = ({ preview: _, ...tab }: Tab): Tab => tab;
  const tabs = group.tabs.map((tab) => (tab.id === tabId ? keep(tab) : tab));
  return {
    ...arrangement,
    root: replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs })),
  };
}

/**
 * Lässt den Tab an Ort und Stelle etwas anderes zeigen, etwa die Vorschau
 * statt des Quelltexts. Ist der Inhalt schon in einem anderen Tab offen, wird
 * stattdessen jener angezeigt.
 */
export function showInTab(
  arrangement: Arrangement,
  tabId: string,
  content: TabContent,
): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  const existing = tabsOf(arrangement).find(
    (tab) => tab.content && sameContent(tab.content, content),
  );
  if (existing) return activateTab(arrangement, existing.id);
  const tabs = group.tabs.map((tab) => (tab.id === tabId ? { ...tab, content } : tab));
  return {
    ...arrangement,
    root: replaceGroup(arrangement.root, group.id, () => ({ ...group, tabs })),
  };
}

/**
 * Öffnet einen Inhalt in einer neuen Gruppe rechts neben der fokussierten,
 * etwa die Vorschau neben dem Quelltext. Der Fokus bleibt, wo er ist. Ist der
 * Inhalt schon offen, wird stattdessen jener Tab angezeigt.
 */
export function openContentBeside(arrangement: Arrangement, content: TabContent): Arrangement {
  const origin = focusedGroupOf(arrangement);
  const existing = tabsOf(arrangement).some(
    (tab) => tab.content && sameContent(tab.content, content),
  );
  if (!origin || existing) return openContent(arrangement, content);
  const opened = openContent(arrangement, content);
  const moved = moveTab(opened, focusedGroupOf(opened)!.activeTab, {
    groupId: origin.id,
    side: "right",
  });
  // In der alten Gruppe bleibt sichtbar, was sichtbar war.
  return activateTab(moved, origin.activeTab);
}

/**
 * Verschiebt die Trennlinie hinter dem Teilstück `index` einer Teilung an die
 * Stelle `position` (0 bis 1 entlang der Teilung). Nur die beiden Nachbarn der
 * Trennlinie ändern ihre Größe; jedem bleibt mindestens `minSize`.
 */
export function moveDivider(
  arrangement: Arrangement,
  splitId: string,
  index: number,
  position: number,
  minSize = 0.05,
): Arrangement {
  let found = false;
  const move = (node: TreeNode): TreeNode => {
    if (node.kind === "group") return node;
    if (node.id !== splitId) return { ...node, children: node.children.map(move) };
    if (index < 0 || index >= node.children.length - 1) return node;
    found = true;
    const start = node.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
    const both = node.sizes[index] + node.sizes[index + 1];
    const min = Math.min(minSize, both / 2);
    const first = Math.min(Math.max(position - start, min), both - min);
    const sizes = [...node.sizes];
    sizes[index] = first;
    sizes[index + 1] = both - first;
    return { ...node, sizes };
  };
  const root = arrangement.root && move(arrangement.root);
  return found ? { ...arrangement, root } : arrangement;
}

/** Gibt der Gruppe den Fokus. */
export function focusGroup(arrangement: Arrangement, groupId: string): Arrangement {
  if (arrangement.focusedGroup === groupId) return arrangement;
  if (!groupsOf(arrangement).some((group) => group.id === groupId)) return arrangement;
  return { ...arrangement, focusedGroup: groupId };
}

/** Gibt der nächsten (`1`) oder vorigen (`-1`) Gruppe in Lesereihenfolge den Fokus, reihum. */
export function focusAdjacentGroup(arrangement: Arrangement, offset: 1 | -1): Arrangement {
  const groups = groupsOf(arrangement);
  const index = groups.findIndex((group) => group.id === arrangement.focusedGroup);
  if (index < 0) return arrangement;
  return focusGroupAt(arrangement, (index + offset + groups.length) % groups.length);
}

export type Side = "left" | "right" | "up" | "down";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Die Fläche jeder Gruppe im Hauptbereich; dieser reicht von 0 bis 1 in beiden Richtungen. */
function boxesOf(arrangement: Arrangement): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const place = (node: TreeNode, box: Box) => {
    if (node.kind === "group") {
      boxes.set(node.id, box);
      return;
    }
    let start = node.axis === "row" ? box.left : box.top;
    const extent = node.axis === "row" ? box.right - box.left : box.bottom - box.top;
    node.children.forEach((child, index) => {
      const end = start + node.sizes[index] * extent;
      const part =
        node.axis === "row"
          ? { ...box, left: start, right: end }
          : { ...box, top: start, bottom: end };
      place(child, part);
      start = end;
    });
  };
  if (arrangement.root) place(arrangement.root, { left: 0, top: 0, right: 1, bottom: 1 });
  return boxes;
}

/**
 * Gibt der Gruppe den Fokus, die auf der Seite `side` an die fokussierte
 * angrenzt; von mehreren die oberste bzw. die am weitesten links. Grenzt
 * dort keine an, bleibt der Fokus.
 */
export function focusGroupToward(arrangement: Arrangement, side: Side): Arrangement {
  const boxes = boxesOf(arrangement);
  const from = arrangement.focusedGroup && boxes.get(arrangement.focusedGroup);
  if (!from) return arrangement;
  // Rechenungenauigkeit der Anteile; weit unter jeder sichtbaren Größe.
  const touches = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const overlaps = (start: number, end: number, otherStart: number, otherEnd: number) =>
    start < otherEnd - 1e-6 && otherStart < end - 1e-6;
  const horizontal = side === "left" || side === "right";
  const neighbors = [...boxes].filter(([, box]) => {
    const beside = overlaps(box.top, box.bottom, from.top, from.bottom);
    const stacked = overlaps(box.left, box.right, from.left, from.right);
    if (side === "left") return beside && touches(box.right, from.left);
    if (side === "right") return beside && touches(box.left, from.right);
    if (side === "up") return stacked && touches(box.bottom, from.top);
    return stacked && touches(box.top, from.bottom);
  });
  neighbors.sort(([, a], [, b]) => (horizontal ? a.top - b.top : a.left - b.left));
  return neighbors.length > 0 ? focusGroup(arrangement, neighbors[0][0]) : arrangement;
}

/** Gibt der Gruppe an der Stelle `index` (ab 0, in Lesereihenfolge) den Fokus. */
export function focusGroupAt(arrangement: Arrangement, index: number): Arrangement {
  const group = groupsOf(arrangement)[index];
  return group ? focusGroup(arrangement, group.id) : arrangement;
}

/** Zeigt den Tab an und gibt seiner Gruppe den Fokus. */
export function activateTab(arrangement: Arrangement, tabId: string): Arrangement {
  const group = groupOfTab(arrangement, tabId);
  if (!arrangement.root || !group) return arrangement;
  if (group.activeTab === tabId) return focusGroup(arrangement, group.id);
  const root = replaceGroup(arrangement.root, group.id, () => ({ ...group, activeTab: tabId }));
  return { ...arrangement, root, focusedGroup: group.id };
}

/** Zeigt in der fokussierten Gruppe den nächsten (`1`) oder vorigen (`-1`) Tab an, reihum. */
export function activateAdjacentTab(arrangement: Arrangement, offset: 1 | -1): Arrangement {
  const group = focusedGroupOf(arrangement);
  if (!group) return arrangement;
  const index = group.tabs.findIndex((tab) => tab.id === group.activeTab);
  const next = group.tabs[(index + offset + group.tabs.length) % group.tabs.length];
  return activateTab(arrangement, next.id);
}

/** Die Gruppe, die den Fokus hat. */
export function focusedGroupOf(arrangement: Arrangement): Group | null {
  return groupsOf(arrangement).find((group) => group.id === arrangement.focusedGroup) ?? null;
}

/** Die gespeicherte Aufteilung ist nicht lesbar; es gilt die leere. */
class Unreadable extends Error {}

type Raw = Record<string, unknown>;

function rawObject(value: unknown): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Unreadable();
  return value as Raw;
}

function rawList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Unreadable();
  return value;
}

/** Jede Shell, die ein gespeichertes Terminal haben kann. */

/**
 * Der gespeicherte Inhalt eines Tabs, oder `null`, wenn er sich nicht
 * wiederherstellen lässt: eine unbekannte Tab-Art oder eine Datei, die es
 * nicht mehr gibt. Jede weitere Tab-Art, die das Schließen des Fensters
 * überdauern soll, ist hier ein weiterer Fall.
 */
function restoreContent(value: unknown, exists: (path: string) => boolean): TabContent | null {
  const raw = rawObject(value);
  switch (raw.kind) {
    case "file":
    // Markdown-Vorschau und Bild zeigen wie die Dateiansicht eine Datei.
    case "markdown":
    case "image":
      return typeof raw.path === "string" && exists(raw.path)
        ? { kind: raw.kind, path: raw.path }
        : null;
    // Der Tab kommt zurück, aber nicht maximiert (`maximized` wird nicht
    // übernommen): Ein frisch geöffnetes Projekt zeigt seine Terminals.
    case "versionControl":
      return { kind: "versionControl" };
    default:
      return null;
  }
}

/** Das gespeicherte Gespräch eines Agenten, oder `null`, wenn es sich nicht fortsetzen lässt. */
function restoreConversation(value: unknown): Conversation | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Raw;
  if (raw.agent !== "claudeCode" || typeof raw.id !== "string" || !raw.id) return null;
  const conversation: Conversation = { agent: raw.agent, id: raw.id };
  if (typeof raw.assignment === "string" && raw.assignment) {
    conversation.assignment = raw.assignment;
  }
  if (raw.working === true) conversation.working = true;
  return conversation;
}

/** Wie eine gespeicherte Aufteilung zurückkommt. */
export interface RestoreOptions {
  /** Ob Agenten mit ihrem Gespräch zurückkommen; sonst als gewöhnliche Terminals. */
  resumeAgents: boolean;
}

/** Der gespeicherte Tab ohne alles, was zu einem laufenden Prozess gehört; `null`, wenn er entfällt. */
function restoreTab(
  raw: Raw,
  exists: (path: string) => boolean,
  { resumeAgents }: RestoreOptions,
): Tab | null {
  const tab: Tab = { id: raw.id as string };
  if (typeof raw.name === "string" && raw.name) tab.name = raw.name;
  if (raw.content !== undefined) {
    const content = restoreContent(raw.content, exists);
    if (!content) return null;
    tab.content = content;
    if (raw.preview === true) tab.preview = true;
    return tab;
  }
  // Nur ein Agent mit Gespräch kommt als Agent zurück und setzt es fort.
  // Jedes andere Terminal startet als frische Shell; kein frischer Agent
  // läuft von selbst an.
  const conversation = resumeAgents ? restoreConversation(raw.conversation) : null;
  if (conversation) tab.agent = true;
  if (isShell(raw.shell)) tab.shell = raw.shell;
  // Ohne seinen Startordner startet das Terminal im Projektordner.
  if (typeof raw.cwd === "string" && exists(raw.cwd)) tab.cwd = raw.cwd;
  if (conversation) tab.conversation = conversation;
  return tab;
}

/**
 * Stellt eine gespeicherte Aufteilung wieder her. `stored` ist, was der
 * Aufteilungsspeicher geladen hat, und kann alles sein: Ist es nicht lesbar
 * oder von einer anderen Version, ergibt sich die leere Aufteilung. Terminals
 * kommen mit Namen, Shell und Startordner zurück, Agenten mit Gespräch laut
 * `options` als Agenten, die es fortsetzen, alle übrigen als gewöhnliche Terminals.
 * Tabs unbekannter Art und Dateiansichten, deren Datei es laut `exists` nicht
 * mehr gibt, fehlen still; ihre Nachbarn rücken nach wie beim Schließen.
 * `exists` erhält die Pfade so, wie sie gespeichert sind (Dateien, Startordner).
 */
export function restoreArrangement(
  stored: unknown,
  exists: (path: string) => boolean = () => true,
  options: RestoreOptions = { resumeAgents: false },
): Arrangement {
  try {
    const raw = rawObject(stored);
    if (raw.version !== emptyArrangement.version) return emptyArrangement;
    if (raw.root === null) return emptyArrangement;

    const ids = new Set<string>();
    /** Ob etwas entfallen ist und der Baum aufgeräumt werden muss. */
    let dropped = false;
    const claimId = (value: unknown): string => {
      if (typeof value !== "string" || value === "" || ids.has(value)) throw new Unreadable();
      ids.add(value);
      return value;
    };

    const restoreNode = (value: unknown): TreeNode => {
      const node = rawObject(value);
      const id = claimId(node.id);
      if (node.kind === "group") {
        const all = rawList(node.tabs).map(rawObject);
        all.forEach((tab) => claimId(tab.id));
        if (all.length === 0) throw new Unreadable();
        const restored = all.map((tab) => restoreTab(tab, exists, options));
        const tabs = restored.filter((tab) => tab !== null);
        if (tabs.length < all.length) dropped = true;
        // Fehlt der sichtbare Tab, rückt sein rechter Nachbar nach, sonst der linke.
        const visible = Math.max(
          all.findIndex((tab) => tab.id === node.activeTab),
          0,
        );
        const successor = restored.slice(visible).find((tab) => tab !== null) ?? tabs.at(-1);
        return { kind: "group", id, tabs, activeTab: successor?.id ?? "" };
      }
      if (node.kind === "split" && (node.axis === "row" || node.axis === "column")) {
        const children = rawList(node.children).map(restoreNode);
        if (children.length < 2) throw new Unreadable();
        return {
          kind: "split",
          id,
          axis: node.axis,
          children,
          sizes: restoreSizes(node.sizes, children.length),
        };
      }
      throw new Unreadable();
    };

    const whole = restoreNode(raw.root);
    const root = dropped ? tidy(whole) : whole;
    const restored: Arrangement = { ...emptyArrangement, root };
    const groups = groupsOf(restored);
    const focused = groups.find((group) => group.id === raw.focusedGroup) ?? groups[0];
    // Auch entfallene Tabs zählen: Ihre Kennungen werden nicht neu vergeben.
    const used = Math.max(0, ...[...ids].map((id) => Number(id.slice(1)) || 0));
    const nextId = Number.isSafeInteger(raw.nextId) ? (raw.nextId as number) : 0;
    return { ...restored, focusedGroup: focused?.id ?? null, nextId: Math.max(nextId, used + 1) };
  } catch (error) {
    if (error instanceof Unreadable) return emptyArrangement;
    throw error;
  }
}

/** Die Anteile einer Teilung; sind sie unbrauchbar, erhält jedes Teilstück gleich viel. */
function restoreSizes(value: unknown, count: number): number[] {
  const sizes = Array.isArray(value) ? value : [];
  const usable =
    sizes.length === count &&
    sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0);
  if (!usable) return Array.from({ length: count }, () => 1 / count);
  const total = sizes.reduce((sum: number, size: number) => sum + size, 0);
  return Math.abs(total - 1) < 1e-6 ? sizes : sizes.map((size: number) => size / total);
}
