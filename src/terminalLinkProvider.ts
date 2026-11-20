import { invoke } from "@tauri-apps/api/core";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findLinks, type FileTarget } from "./terminalLinks";

/** Was ein Klick auf einen Link im Terminal auslöst. */
export interface LinkActions {
  openUrl: (url: string) => void;
  openFile: (file: FileTarget) => void;
}

/** So viele umbrochene Bildschirmzeilen vor und nach der Stelle zählen höchstens zu einer Zeile. */
const MAX_WRAPPED_ROWS = 20;

interface Cell {
  x: number;
  y: number;
}

/**
 * Der Text der Zeile, zu der die Bildschirmzeile `y` (ab 1) gehört, samt
 * ihren umbrochenen Fortsetzungen; dazu für jedes Zeichen seine Zelle.
 */
function readLine(xterm: Terminal, y: number): { text: string; cells: Cell[] } {
  const buffer = xterm.buffer.active;
  let first = y - 1;
  let last = y - 1;
  while (first > y - 1 - MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first--;
  while (last < y - 1 + MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) last++;

  let text = "";
  const cells: Cell[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let column = 0; column < line.length; column++) {
      const cell = line.getCell(column);
      // Die zweite Hälfte eines breiten Zeichens hat keinen eigenen Inhalt.
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let unit = 0; unit < chars.length; unit++) cells.push({ x: column + 1, y: row + 1 });
    }
  }
  return { text, cells };
}

/**
 * Macht Web-Adressen und Pfade vorhandener Dateien im Terminal anklickbar.
 * Relative Pfade gelten ab dem Startordner `cwd` der Shell.
 */
export function linkProvider(xterm: Terminal, cwd: string, actions: LinkActions): ILinkProvider {
  return {
    async provideLinks(y, callback) {
      const { text, cells } = readLine(xterm, y);
      const found = findLinks(text);
      const candidates = found.filter((link) => link.kind === "file");
      const files =
        candidates.length > 0
          ? await invoke<(string | null)[]>("resolve_files", {
              base: cwd,
              candidates: candidates.map((link) => link.target),
            }).catch(() => [])
          : [];

      const links: ILink[] = [];
      for (const link of found) {
        const path = link.kind === "file" ? files[candidates.indexOf(link)] : null;
        if (link.kind === "file" && !path) continue;
        links.push({
          range: { start: cells[link.start], end: cells[link.end - 1] },
          text: text.slice(link.start, link.end),
          activate(event) {
            // Wer über einem Link Text markiert, will ihn nicht öffnen.
            if (event.button !== 0 || xterm.hasSelection()) return;
            if (path) actions.openFile({ path, line: link.line, column: link.column });
            else actions.openUrl(link.target);
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
