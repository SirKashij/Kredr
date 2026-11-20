import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { AgentStatuses, StatusUpdate } from "./agentStatus";
import type { Translate } from "./i18n/i18n";

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

/** Was der Kern nach dem Öffnen eines Terminals meldet. */
interface OpenedTerminal {
  id: number;
  /** Das Programm des Agent-Startbefehls, wenn es nicht installiert ist. */
  missingAgentProgram: string | null;
}

/**
 * Ein laufendes Terminal samt Darstellung. Es lebt unabhängig davon, wo es
 * im Hauptbereich gerade angezeigt wird: Sein Element wird beim Umbau der
 * Aufteilung nur umgehängt, Inhalt und Prozess bleiben erhalten.
 */
export class RunningTerminal {
  private readonly element = document.createElement("div");
  /** Darin zeichnet xterm.js; darüber ist Platz für einen Hinweis. */
  private readonly screen = document.createElement("div");
  private readonly xterm = new Terminal({
    theme,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    scrollback: 10_000,
    allowProposedApi: true,
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

  /**
   * @param cwd Startordner der Shell.
   * @param agent Ob in der Shell sofort ein Agent startet.
   * @param translate Liefert die Übersetzungsfunktion der aktuellen Sprache;
   *   ein Sprachwechsel soll die laufende Shell nicht neu starten.
   * @param onAgentStatus Erhält jede Änderung des Agentenstatus dieses Terminals.
   */
  constructor(
    private readonly cwd: string,
    private readonly agent: boolean,
    private readonly translate: () => Translate,
    private readonly onAgentStatus: (update: StatusUpdate) => void,
  ) {
    this.screen.className = "terminal-screen";
    this.element.append(this.screen);
    this.xterm.loadAddon(this.fitAddon);
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
    this.xterm.open(this.screen);
    try {
      const webgl = new WebglAddon();
      // Verliert die Grafikkarte den Kontext, zeichnet xterm.js ohne Beschleunigung weiter.
      webgl.onContextLoss(() => webgl.dispose());
      this.xterm.loadAddon(webgl);
    } catch {
      // Ohne WebGL bleibt die langsamere Standarddarstellung.
    }
    this.fit();
    this.observer.observe(this.screen);
    this.start();
  }

  /** Nimmt das Terminal aus `host`; die Shell läuft unsichtbar weiter. */
  detach(host: HTMLElement) {
    if (this.element.parentElement === host) this.element.remove();
  }

  focus() {
    this.xterm.focus();
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
      this.xterm.write(`\r\n\x1b[90m${this.translate()("terminal.exited")}\x1b[0m\r\n`);
    });
    const onAgentStatus = new Channel<StatusUpdate>((update) => {
      if (!this.closed) this.onAgentStatus(update);
    });
    const { cols, rows } = this.xterm;
    const { cwd, agent } = this;
    const channels = { onOutput, onExit, onAgentStatus };
    invoke<OpenedTerminal>("terminal_open", { cwd, cols, rows, agent, ...channels })
      .then(({ id, missingAgentProgram }) => {
        if (this.closed) {
          invoke("terminal_close", { id });
          return;
        }
        this.id = id;
        // Die Gruppe kann ihre Größe geändert haben, während die Shell startete.
        this.resize();
        if (this.earlyInput) this.write(this.earlyInput);
        if (missingAgentProgram) this.showAgentMissing(missingAgentProgram);
      })
      .catch((details) => {
        if (this.closed) return;
        const message = this.translate()("terminal.startFailed", { details: String(details) });
        this.xterm.write(`\x1b[31m${message}\x1b[0m`);
      });
  }

  /**
   * Zeigt über dem Terminal an, dass das Programm des Agent-Startbefehls
   * fehlt. In das Terminal selbst geschrieben, würde die Shell den Hinweis
   * mit ihrer eigenen Ausgabe überschreiben.
   */
  private showAgentMissing(program: string) {
    const notice = document.createElement("div");
    notice.className = "terminal-notice";
    notice.setAttribute("role", "alert");
    notice.textContent = this.translate()("agent.missing", { program });
    this.element.prepend(notice);
  }

  /** Passt Spalten und Zeilen an den Platz an; unsichtbar gibt es nichts zu messen. */
  private fit() {
    if (this.screen.clientWidth > 0 && this.screen.clientHeight > 0) this.fitAddon.fit();
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

  /**
   * @param statuses Nimmt den Agentenstatus der Terminals auf, nach der
   *   Kennung ihres Tabs.
   */
  constructor(
    private readonly translate: () => Translate,
    readonly statuses: AgentStatuses,
  ) {}

  /**
   * Das Terminal des Tabs; gibt es noch keines, entsteht es mit Startordner
   * `cwd` und startet mit `agent` sofort einen Agenten.
   */
  get(tabId: string, cwd: string, agent: boolean): RunningTerminal {
    let terminal = this.terminals.get(tabId);
    if (!terminal) {
      terminal = new RunningTerminal(cwd, agent, this.translate, (update) =>
        this.statuses.report(tabId, update),
      );
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
    this.statuses.retain(tabIds);
  }
}
