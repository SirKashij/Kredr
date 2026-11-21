/** Spalten und Zeilen eines Terminals. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/** So lange muss die Ausgabe ruhen, bis die neue Größe gilt. */
export const QUIET_MS = 60;
/** Spätestens dann gilt die neue Größe, auch wenn das Programm weiter ausgibt. */
export const MAX_HOLD_MS = 250;

/**
 * Hält nach einer Größenänderung die Ausgabe zurück, bis das Programm im Terminal neu
 * gezeichnet hat, und übergibt dann Größe und Ausgabe in einem Schritt.
 *
 * Ändert sich die Spaltenzahl, bricht xterm.js den Puffer sofort um, ConPTY schickt
 * seinen eigenen Umbruch und erst danach zeichnet ein Vollbildprogramm wie Claude Code
 * richtig neu. Jeder dieser Zwischenstände war ein eigenes Bild: Das Terminal flackerte
 * beim Auf- und Zuklappen der Seitenleiste. Solange gehalten wird, bleibt das alte Bild
 * stehen; die Shell kennt die neue Größe aber schon.
 */
export class ResizeHold {
  private pending: TerminalSize | null = null;
  private held: Uint8Array[] = [];
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Übernimmt die neue Größe und schreibt danach die zurückgehaltene Ausgabe. */
    private readonly apply: (size: TerminalSize, held: Uint8Array[]) => void,
  ) {}

  /** Ob gerade gehalten wird. */
  get holding(): boolean {
    return this.pending !== null;
  }

  /**
   * Beginnt zu halten, oder merkt sich während des Haltens die neueste Größe.
   * Kommt danach keine Ausgabe, gilt die Größe nach `QUIET_MS`.
   */
  start(size: TerminalSize) {
    if (!this.pending) {
      this.maxTimer = setTimeout(() => this.release(), MAX_HOLD_MS);
    }
    this.pending = size;
    this.restartQuiet();
  }

  /** Nimmt Ausgabe an, solange gehalten wird; sonst `false`, und sie geht direkt ans Terminal. */
  output(bytes: Uint8Array): boolean {
    if (!this.pending) return false;
    this.held.push(bytes);
    this.restartQuiet();
    return true;
  }

  /** Übergibt sofort, was gehalten wird. */
  release() {
    clearTimeout(this.quietTimer);
    clearTimeout(this.maxTimer);
    const size = this.pending;
    const held = this.held;
    this.pending = null;
    this.held = [];
    if (size) this.apply(size, held);
  }

  /** Verwirft, was gehalten wird; das Terminal schließt. */
  dispose() {
    clearTimeout(this.quietTimer);
    clearTimeout(this.maxTimer);
    this.pending = null;
    this.held = [];
  }

  private restartQuiet() {
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.release(), QUIET_MS);
  }
}
