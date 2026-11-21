import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { conversationOf, type AgentStatuses, type StatusUpdate } from "./agentStatus";
import type { Conversation } from "./arrangement";
import type { Translate } from "./i18n/i18n";
import type { Shell } from "./settingsStore";
import { shellLabel } from "./tabLabel";
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
  /** Ohne Angabe die Standard-Shell aus den Einstellungen. */
  shell?: Shell;
  /** Ob in der Shell sofort ein Agent startet. */
  agent: boolean;
  /** Das Gespräch, das der Agent fortsetzt; ohne Angabe beginnt er ein neues. */
  resume?: Conversation;
}

/** Was ein Terminal über seinen Agenten meldet. */
interface AgentEvents {
  /** Erhält jede Änderung des Agentenstatus. */
  onStatus(update: StatusUpdate): void;
  /** Der Agent konnte sein Gespräch nicht fortsetzen; die Shell läuft ohne ihn weiter. */
  onResumeFailed(): void;
}

/** So lange (in Sekunden) sieht ein Terminal nach, ob ein fortgesetzter Agent läuft. */
const RESUME_START_LIMIT = 30;
/** So lange (in Sekunden) muss er laufen, damit das Fortsetzen als gelungen gilt. */
const RESUME_SETTLE_TIME = 5;

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
  /** Das Programm des Agent-Startbefehls, wenn es im Suchpfad nicht zu finden ist. */
  missingAgentProgram: string | null;
  /** Die gewünschte Shell, wenn es sie nicht (mehr) gibt; das Terminal läuft dann mit PowerShell. */
  missingShell: Shell | null;
  /** Ob ein Agent gestartet ist; ein Gespräch setzt nur Claude Code fort. */
  agentStarted: boolean;
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
  /** Ob der Agent sich schon einmal gemeldet hat. */
  private reported = false;

  constructor(
    private readonly options: TerminalStart,
    private readonly host: TerminalHost,
    private readonly agentEvents: AgentEvents,
  ) {
    this.screen.className = "terminal-screen";
    this.element.append(this.screen);
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

  /**
   * Startet die Shell, ohne das Terminal anzuzeigen, etwa für einen Agenten
   * in einem verdeckten Tab. Das nächste `attach` holt es in die Ansicht.
   */
  startUnseen() {
    if (!this.started) this.attach(unseenHost());
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

  /** Stellt Schriftart und Schriftgröße um; Spalten und Zeilen passen sich an. */
  setFont(fontFamily: string, fontSize: number) {
    this.xterm.options.fontFamily = fontFamily;
    this.xterm.options.fontSize = fontSize;
    if (this.started) this.fit();
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
    const onAgentStatus = new Channel<StatusUpdate>((update) => {
      if (this.closed) return;
      this.reported = true;
      this.agentEvents.onStatus(update);
    });
    const { cols, rows } = this.xterm;
    const { cwd, shell, agent, resume: conversation } = this.options;
    const channels = { onOutput, onExit, onAgentStatus };
    const resume = conversation
      ? { conversation: conversation.id, assignment: conversation.assignment ?? null }
      : null;
    invoke<OpenedTerminal>("terminal_open", { shell, cwd, cols, rows, agent, resume, ...channels })
      .then(({ id, missingAgentProgram, missingShell, agentStarted }) => {
        if (this.closed) {
          invoke("terminal_close", { id });
          return;
        }
        this.id = id;
        // Lässt sich das Gespräch nicht fortsetzen, bleibt ein gewöhnliches Terminal.
        if (resume && !agentStarted) this.agentEvents.onResumeFailed();
        else if (resume) this.watchResume();
        // Die Gruppe kann ihre Größe geändert haben, während die Shell startete.
        this.resize();
        if (this.earlyInput) this.write(this.earlyInput);
        const t = this.host.translate();
        if (missingShell) {
          this.showNotice(t("terminal.shellMissing", { shell: shellLabel(missingShell, t) }));
        }
        if (missingAgentProgram) {
          this.showNotice(t("agent.missing", { program: missingAgentProgram }));
        }
      })
      .catch((details) => {
        if (this.closed) return;
        const message = this.host.translate()("terminal.startFailed", {
          details: String(details),
        });
        this.xterm.write(`\x1b[31m${message}\x1b[0m`);
      });
  }

  /**
   * Sieht nach, ob der fortgesetzte Agent wirklich läuft. Gibt es sein
   * Gespräch nicht mehr, meldet er sich nie und beendet sich gleich nach dem
   * Start; seine Fehlermeldung bleibt in der Shell stehen.
   */
  private watchResume() {
    let seconds = 0;
    /** Seit wie vielen Sekunden der Agent läuft; `null`, solange er nicht gestartet ist. */
    let running: number | null = null;
    const check = async () => {
      if (this.closed || this.reported) return;
      const alive = await this.hasChildProcess();
      if (this.closed || this.reported) return;
      seconds += 1;
      if (alive) running = (running ?? 0) + 1;
      const ended = running !== null && !alive;
      const neverStarted = running === null && seconds >= RESUME_START_LIMIT;
      if (ended || neverStarted) return this.agentEvents.onResumeFailed();
      if (running !== null && running >= RESUME_SETTLE_TIME) return;
      setTimeout(check, 1000);
    };
    setTimeout(check, 1000);
  }

  /**
   * Zeigt über dem Terminal einen Hinweis an, etwa dass das Programm des
   * Agent-Startbefehls nicht gefunden wurde. In das Terminal selbst
   * geschrieben, würde die Shell ihn mit ihrer eigenen Ausgabe überschreiben.
   */
  private showNotice(text: string) {
    const notice = document.createElement("div");
    notice.className = "terminal-notice";
    notice.setAttribute("role", "alert");
    notice.textContent = text;
    this.screen.before(notice);
  }

  /** Passt Spalten und Zeilen an den Platz an; unsichtbar gibt es nichts zu messen. */
  private fit() {
    if (this.screen.clientWidth > 0 && this.screen.clientHeight > 0) {
      this.fitAddon.fit();
      this.renderNow();
    }
  }

  /**
   * Zeichnet ausstehende Zeilen sofort statt im nächsten Frame. Ändert `fit` die Größe,
   * leert das Setzen von `canvas.width` die WebGL-Fläche; xterm.js zeichnet erst einen
   * Frame später neu, und dazwischen malt der Browser ein leeres Terminal (Flackern beim
   * Auf- und Zuklappen der Seitenleiste). xterm.js bietet dafür keine öffentliche
   * Schnittstelle; fehlt der interne Weg nach einem Update, bleibt es beim Flackern.
   */
  private renderNow() {
    const debouncer = (
      this.xterm as unknown as {
        _core?: {
          _renderService?: {
            _renderDebouncer?: { _animationFrame?: number; _innerRefresh?: () => void };
          };
        };
      }
    )._core?._renderService?._renderDebouncer;
    if (!debouncer?._animationFrame || typeof debouncer._innerRefresh !== "function") return;
    cancelAnimationFrame(debouncer._animationFrame);
    debouncer._innerRefresh();
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

/** Der unsichtbare Platz für Terminals verdeckter Tabs; entsteht beim ersten Gebrauch. */
let unseen: HTMLElement | null = null;

/**
 * Ein unsichtbarer Platz im Dokument, an dem ein Terminal starten kann:
 * xterm.js braucht dafür ein eingehängtes Element mit einer Größe.
 */
function unseenHost(): HTMLElement {
  if (!unseen) {
    unseen = document.createElement("div");
    unseen.className = "terminal-unseen";
    unseen.setAttribute("aria-hidden", "true");
    document.body.append(unseen);
  }
  return unseen;
}

/** Was die Aufteilung von den Agenten in ihren Terminals erfährt, nach der Kennung ihres Tabs. */
export interface ConversationListener {
  /** Das Gespräch des Agenten nach einer Meldung; ohne Gespräch `undefined`. */
  onConversation(tabId: string, conversation?: Conversation): void;
  /** Das Gespräch ließ sich nicht fortsetzen; der Tab wird ein gewöhnliches Terminal. */
  onResumeFailed(tabId: string): void;
}

/** Die laufenden Terminals eines Fensters, nach der Kennung ihres Tabs. */
export class RunningTerminals {
  private readonly terminals = new Map<string, RunningTerminal>();
  private font: { family: string; size: number } | null = null;

  /**
   * @param statuses Nimmt den Agentenstatus der Terminals auf, nach der
   *   Kennung ihres Tabs.
   * @param agents Erfährt, was die Aufteilung sich von den Agenten merkt.
   */
  constructor(
    private readonly host: TerminalHost,
    readonly statuses: AgentStatuses,
    private readonly agents: ConversationListener,
  ) {}

  /** Das Terminal des Tabs; gibt es noch keines, entsteht es und startet mit `start`. */
  get(tabId: string, start: TerminalStart): RunningTerminal {
    let terminal = this.terminals.get(tabId);
    if (!terminal) {
      terminal = new RunningTerminal(start, this.host, {
        onStatus: (update) => {
          this.statuses.report(tabId, update);
          this.agents.onConversation(tabId, conversationOf(update));
        },
        onResumeFailed: () => this.agents.onResumeFailed(tabId),
      });
      if (this.font) terminal.setFont(this.font.family, this.font.size);
      this.terminals.set(tabId, terminal);
    }
    return terminal;
  }

  /** Schrift aus den Einstellungen: gilt sofort für alle laufenden und für neue Terminals. */
  setFont(family: string, size: number) {
    this.font = { family, size };
    for (const terminal of this.terminals.values()) terminal.setFont(family, size);
  }

  /** Startet das Terminal des Tabs sofort, auch wenn sein Tab gerade verdeckt ist. */
  startNow(tabId: string, start: TerminalStart) {
    this.get(tabId, start).startUnseen();
  }

  find(tabId: string): RunningTerminal | undefined {
    return this.terminals.get(tabId);
  }

  /**
   * Ob in irgendeinem Terminal des Fensters noch ein Programm läuft, etwa ein
   * Agent. Die Terminals der Tabs in `except` zählen nicht.
   */
  async anyHasChildProcess(except: ReadonlySet<string> = new Set()): Promise<boolean> {
    const terminals = [...this.terminals]
      .filter(([tabId]) => !except.has(tabId))
      .map(([, terminal]) => terminal);
    const running = await Promise.all(terminals.map((terminal) => terminal.hasChildProcess()));
    return running.includes(true);
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
