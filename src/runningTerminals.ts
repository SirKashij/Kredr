import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import type { StatusUpdate } from "./agentStatus";
import type { Conversation } from "./arrangement";
import type { AgentTerminals } from "./windowAgents";
import type { Translate } from "./i18n/i18n";
import type { Shell } from "./settingsStore";
import { shellLabel } from "./tabLabel";
import { clipboardCommand } from "./terminalClipboard";
import { linkProvider, type LinkActions } from "./terminalLinkProvider";
import { ResizeHold, type TerminalSize } from "./terminalResizeHold";

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

/** Was ein Terminal über seinen Agenten meldet, so wie der Kern es schickt. */
export interface AgentSignals {
  /** Jede Meldung des Agentenstatus, auch die über das Ende der Sitzung. */
  onStatus(update: StatusUpdate): void;
  /** Die Shell läuft; `agentStarted` sagt, ob mit ihr ein Agent gestartet ist. */
  onOpened(agentStarted: boolean): void;
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
 * Eine OSC-Nummer, die kein bekanntes Terminal belegt. Kredr stellt sie der zurückgehaltenen
 * Ausgabe nach einer Größenänderung voran (`applySize`); schickt ein Programm sie selbst,
 * passiert nichts.
 */
const SIZE_OSC = 7347;
const sizeMarker = new TextEncoder().encode(`\x1b]${SIZE_OSC};\x07`);

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
  // Sofort und nicht erst im nächsten Frame: Sonst malt der Browser ein Bild, in dem das
  // Terminal noch die alte Breite hat und abgeschnitten ist.
  private readonly observer = new ResizeObserver(() => this.fit());
  private readonly hold = new ResizeHold((_size, held) => this.applySize(held));
  /** Die Größe, die die Shell zuletzt erfahren hat. */
  private sentSize = "";
  /** `applySize` hat eine neue Größe angekündigt, die noch nicht gilt. */
  private sizePending = false;
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
    private readonly signals: AgentSignals,
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
    this.xterm.parser.registerOscHandler(SIZE_OSC, () => {
      this.takeSize();
      return true;
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
    this.hold.dispose();
    this.element.remove();
    this.xterm.dispose();
    if (this.id !== null) invoke("terminal_close", { id: this.id });
  }

  private start() {
    const onOutput = new Channel<ArrayBuffer>((bytes) => {
      if (this.closed) return;
      const output = new Uint8Array(bytes);
      if (!this.hold.output(output)) this.xterm.write(output);
    });
    const onExit = new Channel<null>(() => {
      if (this.closed) return;
      this.xterm.write(`\r\n\x1b[90m${this.host.translate()("terminal.exited")}\x1b[0m\r\n`);
    });
    const onAgentStatus = new Channel<StatusUpdate>((update) => {
      if (this.closed) return;
      this.signals.onStatus(update);
    });
    const { cols, rows } = this.xterm;
    this.sentSize = `${cols}x${rows}`;
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
        this.signals.onOpened(agentStarted);
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

  /**
   * Passt Spalten und Zeilen an den Platz an; unsichtbar gibt es nichts zu messen.
   * Läuft die Shell schon, erfährt sie die neue Größe sofort, das Terminal aber erst,
   * wenn ihr Neuzeichnen da ist (`ResizeHold`). Bis dahin bleibt das alte Bild stehen.
   */
  private fit() {
    if (this.screen.clientWidth === 0 || this.screen.clientHeight === 0) return;
    if (this.id === null) {
      this.fitAddon.fit();
      this.renderNow();
      return;
    }
    const size = this.fitAddon.proposeDimensions();
    if (!size || !(size.cols > 0) || !(size.rows > 0)) return;
    const changed = size.cols !== this.xterm.cols || size.rows !== this.xterm.rows;
    if (!changed && !this.hold.holding) return;
    this.resize(size);
    this.hold.start(size);
  }

  /**
   * Übernimmt die neue Größe und die zurückgehaltene Ausgabe so, dass dazwischen kein Bild
   * gemalt wird. Alles geht als ein einziger Schub in die Schreibschlange von xterm.js, denn
   * zwischen zwei Schüben darf sie die Arbeit unterbrechen, und der Browser malt dann. Den
   * Anfang macht eine eigene OSC-Sequenz, die die neue Größe mitten im Schub setzt
   * (`sizeMarker`); verschluckt sie eine angefangene Sequenz der Shell, setzt sie der Rückruf.
   * `fit` misst dabei neu; hat sich der Platz inzwischen wieder geändert, erfährt es die Shell.
   */
  private applySize(held: Uint8Array[]) {
    if (this.closed) return;
    const chunks = [sizeMarker, ...held];
    const output = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0));
    let offset = 0;
    for (const bytes of chunks) {
      output.set(bytes, offset);
      offset += bytes.length;
    }
    this.sizePending = true;
    this.xterm.write(output, () => {
      this.takeSize();
      this.renderNow();
    });
  }

  /** Setzt die gemessene Größe, wenn `applySize` sie angekündigt hat. */
  private takeSize() {
    if (!this.sizePending) return;
    this.sizePending = false;
    this.fitAddon.fit();
    this.resize();
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

  /** Teilt der Shell eine Größe mit; dieselbe zweimal hintereinander nur einmal. */
  private resize({ cols, rows }: TerminalSize = this.xterm) {
    const size = `${cols}x${rows}`;
    if (size === this.sentSize) return;
    this.sentSize = size;
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

/**
 * Die laufenden Terminals eines Fensters, nach der Kennung ihres Tabs. Was
 * ihre Agenten melden, reichen sie nur durch; gedeutet wird es in `windowAgents`.
 */
export class RunningTerminals implements AgentTerminals<RunningTerminal> {
  private readonly terminals = new Map<string, RunningTerminal>();
  private font: { family: string; size: number } | null = null;

  constructor(private readonly host: TerminalHost) {}

  /**
   * Legt das Terminal eines Tabs an, der noch keines hat; seine Shell startet
   * beim ersten Anzeigen oder mit `startNow`.
   */
  open(tabId: string, start: TerminalStart, signals: AgentSignals): RunningTerminal {
    const terminal = new RunningTerminal(start, this.host, signals);
    if (this.font) terminal.setFont(this.font.family, this.font.size);
    this.terminals.set(tabId, terminal);
    return terminal;
  }

  /** Schrift aus den Einstellungen: gilt sofort für alle laufenden und für neue Terminals. */
  setFont(family: string, size: number) {
    this.font = { family, size };
    for (const terminal of this.terminals.values()) terminal.setFont(family, size);
  }

  /** Startet das Terminal des Tabs sofort, auch wenn sein Tab gerade verdeckt ist. */
  startNow(tabId: string) {
    this.terminals.get(tabId)?.startUnseen();
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
  }
}
