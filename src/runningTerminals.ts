import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import type { Shell } from "./arrangement";
import type { Translate } from "./i18n/i18n";
import { clipboardCommand } from "./terminalClipboard";
import { linkProvider, type LinkActions } from "./terminalLinkProvider";

/** Was ein Terminal von seinem Fenster braucht. */
export interface TerminalHost extends LinkActions {
  /**
   * Liefert die Übersetzungsfunktion der aktuellen Sprache; ein Sprachwechsel
   * soll die laufende Shell nicht neu starten.
   */
  translate: () => Translate;
}

/** Womit ein Terminal startet. */
export interface TerminalStart {
  /** Startordner der Shell. */
  cwd: string;
  /** Ohne Angabe die Standard-Shell. */
  shell?: Shell;
}

/** Terminalfarben des dunklen VS-Code-Standardthemas. */
const theme = {
  background: "#1f1f1f",
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

/**
 * Ein laufendes Terminal samt Darstellung. Es lebt unabhängig davon, wo es
 * im Hauptbereich gerade angezeigt wird: Sein Element wird beim Umbau der
 * Aufteilung nur umgehängt, Inhalt und Prozess bleiben erhalten.
 */
export class RunningTerminal {
  private readonly element = document.createElement("div");
  private readonly xterm = new Terminal({
    theme,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    scrollback: 10_000,
    allowProposedApi: true,
    // Links, die ein Programm selbst auszeichnet (OSC 8); nur Web-Adressen.
    linkHandler: { activate: (_event, url) => this.host.openUrl(url) },
  });
  private readonly fitAddon = new FitAddon();
  private readonly observer = new ResizeObserver(() => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.fit());
  });
  private frame = 0;
  private started = false;
  private closed = false;
  /** Kennung des Terminals im Kern, sobald die Shell läuft. */
  private id: number | null = null;
  // Die erste Ausgabe kann vor der Kennung eintreffen. ConPTY wartet dann
  // schon auf die Antwort von xterm.js auf seine Cursorabfrage.
  private earlyInput = "";

  constructor(
    private readonly options: TerminalStart,
    private readonly host: TerminalHost,
  ) {
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.registerLinkProvider(linkProvider(this.xterm, options.cwd, host));
    this.xterm.attachCustomKeyEventHandler((event) => {
      const command = clipboardCommand(event, this.xterm.hasSelection());
      if (!command) return true;
      // Die Taste geht nicht an die Shell, und der Browser fügt nicht selbst ein.
      event.preventDefault();
      if (event.type === "keydown") {
        if (command === "copy") this.copySelection();
        else this.paste();
      }
      return false;
    });
    // Breiten von Sonderzeichen und Emoji wie in aktuellen Terminals.
    this.xterm.loadAddon(new Unicode11Addon());
    this.xterm.unicode.activeVersion = "11";
    this.xterm.onData((data) => {
      if (this.id !== null) this.write(data);
      else this.earlyInput += data;
    });
    this.xterm.onResize(() => {
      if (this.id !== null) this.resize();
    });
  }

  /** Zeigt das Terminal in `host` an. Beim ersten Mal startet die Shell. */
  attach(host: HTMLElement) {
    host.appendChild(this.element);
    if (this.started) {
      this.fit();
      return;
    }
    this.started = true;
    this.xterm.open(this.element);
    try {
      const webgl = new WebglAddon();
      // Verliert die Grafikkarte den Kontext, zeichnet xterm.js ohne Beschleunigung weiter.
      webgl.onContextLoss(() => webgl.dispose());
      this.xterm.loadAddon(webgl);
    } catch {
      // Ohne WebGL bleibt die langsamere Standarddarstellung.
    }
    this.fit();
    this.observer.observe(this.element);
    this.start();
  }

  /** Nimmt das Terminal aus `host`; die Shell läuft unsichtbar weiter. */
  detach(host: HTMLElement) {
    if (this.element.parentElement === host) this.element.remove();
  }

  focus() {
    this.xterm.focus();
  }

  hasSelection(): boolean {
    return this.xterm.hasSelection();
  }

  /**
   * Kopiert den markierten Text in die Zwischenablage und hebt die Markierung
   * auf; das nächste Strg+C erreicht damit wieder das laufende Programm.
   */
  copySelection() {
    const text = this.xterm.getSelection();
    if (!text) return;
    writeText(text).catch(() => {});
    this.xterm.clearSelection();
  }

  /** Fügt den Text der Zwischenablage als Eingabe ein. */
  paste() {
    readText()
      .then((text) => {
        if (text && !this.closed) this.xterm.paste(text);
      })
      // Die Zwischenablage ist leer oder enthält keinen Text.
      .catch(() => {});
  }

  /** Ob in der Shell gerade ein Programm läuft, etwa ein Agent. */
  async hasChildProcess(): Promise<boolean> {
    if (this.id === null) return false;
    return invoke<boolean>("terminal_has_child_process", { id: this.id }).catch(() => false);
  }

  /** Beendet die Shell und gibt die Darstellung frei. */
  dispose() {
    this.closed = true;
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.element.remove();
    this.xterm.dispose();
    if (this.id !== null) invoke("terminal_close", { id: this.id });
  }

  private start() {
    const onOutput = new Channel<ArrayBuffer>((bytes) => {
      if (!this.closed) this.xterm.write(new Uint8Array(bytes));
    });
    const onExit = new Channel<null>(() => {
      if (this.closed) return;
      this.xterm.write(`\r\n\x1b[90m${this.host.translate()("terminal.exited")}\x1b[0m\r\n`);
    });
    const { cols, rows } = this.xterm;
    const { cwd, shell } = this.options;
    invoke<number>("terminal_open", { shell, cwd, cols, rows, onOutput, onExit })
      .then((id) => {
        if (this.closed) {
          invoke("terminal_close", { id });
          return;
        }
        this.id = id;
        // Die Gruppe kann ihre Größe geändert haben, während die Shell startete.
        this.resize();
        if (this.earlyInput) this.write(this.earlyInput);
      })
      .catch((details) => {
        if (this.closed) return;
        const message = this.host.translate()("terminal.startFailed", {
          details: String(details),
        });
        this.xterm.write(`\x1b[31m${message}\x1b[0m`);
      });
  }

  /** Passt Spalten und Zeilen an den Platz an; unsichtbar gibt es nichts zu messen. */
  private fit() {
    if (this.element.clientWidth > 0 && this.element.clientHeight > 0) this.fitAddon.fit();
  }

  // Eingaben und Größenänderungen an eine bereits beendete Shell scheitern;
  // das ist kein Fehler, den der Nutzer sehen müsste.
  private write(data: string) {
    invoke("terminal_write", { id: this.id, data }).catch(() => {});
  }

  private resize() {
    const { cols, rows } = this.xterm;
    invoke("terminal_resize", { id: this.id, cols, rows }).catch(() => {});
  }
}

/** Die laufenden Terminals eines Fensters, nach der Kennung ihres Tabs. */
export class RunningTerminals {
  private readonly terminals = new Map<string, RunningTerminal>();

  constructor(private readonly host: TerminalHost) {}

  /** Das Terminal des Tabs; gibt es noch keines, entsteht es und startet mit `start`. */
  get(tabId: string, start: TerminalStart): RunningTerminal {
    let terminal = this.terminals.get(tabId);
    if (!terminal) {
      terminal = new RunningTerminal(start, this.host);
      this.terminals.set(tabId, terminal);
    }
    return terminal;
  }

  find(tabId: string): RunningTerminal | undefined {
    return this.terminals.get(tabId);
  }

  /** Beendet alle Terminals, deren Tab es nicht mehr gibt. */
  retain(tabIds: ReadonlySet<string>) {
    for (const [tabId, terminal] of this.terminals) {
      if (tabIds.has(tabId)) continue;
      terminal.dispose();
      this.terminals.delete(tabId);
    }
  }
}
