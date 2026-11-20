import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useT } from "./i18n/i18n";

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

/** Ein Terminal im Hauptbereich: eine Shell, die im Ordner `cwd` startet. */
export function TerminalView({ cwd }: { cwd: string }) {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  // Ein Sprachwechsel soll die laufende Shell nicht neu starten.
  const translate = useRef(t);
  translate.current = t;

  useEffect(() => {
    const xterm = new Terminal({
      theme,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    // Breiten von Sonderzeichen und Emoji wie in aktuellen Terminals.
    xterm.loadAddon(new Unicode11Addon());
    xterm.unicode.activeVersion = "11";
    xterm.open(container.current!);
    try {
      const webgl = new WebglAddon();
      // Verliert die Grafikkarte den Kontext, zeichnet xterm.js ohne Beschleunigung weiter.
      webgl.onContextLoss(() => webgl.dispose());
      xterm.loadAddon(webgl);
    } catch {
      // Ohne WebGL bleibt die langsamere Standarddarstellung.
    }
    fit.fit();
    xterm.focus();

    let closed = false;
    /** Kennung des Terminals im Kern, sobald die Shell läuft. */
    let id: number | null = null;
    // Die erste Ausgabe kann vor der Kennung eintreffen. ConPTY wartet dann
    // schon auf die Antwort von xterm.js auf seine Cursorabfrage.
    let earlyInput = "";

    // Eingaben und Größenänderungen an eine bereits beendete Shell scheitern;
    // das ist kein Fehler, den der Nutzer sehen müsste.
    const write = (data: string) => invoke("terminal_write", { id, data }).catch(() => {});
    const resize = () =>
      invoke("terminal_resize", { id, cols: xterm.cols, rows: xterm.rows }).catch(() => {});

    const onOutput = new Channel<ArrayBuffer>((bytes) => {
      if (!closed) xterm.write(new Uint8Array(bytes));
    });
    const onExit = new Channel<null>(() => {
      if (!closed) xterm.write(`\r\n\x1b[90m${translate.current("terminal.exited")}\x1b[0m\r\n`);
    });
    invoke<number>("terminal_open", { cwd, cols: xterm.cols, rows: xterm.rows, onOutput, onExit })
      .then((openedId) => {
        if (closed) {
          invoke("terminal_close", { id: openedId });
          return;
        }
        id = openedId;
        // Das Fenster kann sich geändert haben, während die Shell startete.
        resize();
        if (earlyInput) write(earlyInput);
      })
      .catch((details) => {
        if (closed) return;
        const message = translate.current("terminal.startFailed", { details: String(details) });
        xterm.write(`\x1b[31m${message}\x1b[0m`);
      });

    const input = xterm.onData((data) => {
      if (id !== null) write(data);
      else earlyInput += data;
    });
    const resized = xterm.onResize(() => {
      if (id !== null) resize();
    });

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit.fit());
    });
    observer.observe(container.current!);

    return () => {
      closed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      input.dispose();
      resized.dispose();
      xterm.dispose();
      if (id !== null) invoke("terminal_close", { id });
    };
  }, [cwd]);

  return (
    <div className="terminal-view">
      <div ref={container} />
    </div>
  );
}
