/**
 * Der Ablauf der Aktualisierung in einem Fenster. Den Zustand hält der Kern,
 * weil alle Fenster in einem Prozess laufen: Er sucht nach einer neuen Version
 * und meldet jede Änderung an alle Fenster. Eine Aktion in einem Fenster gilt
 * daher für alle.
 */

/**
 * Wie weit die Aktualisierung ist. `confirm` (Rückfrage, wenn Agenten
 * arbeiten) meldet der Kern noch nicht; sie folgt mit #92.
 */
export type Phase =
  "none" | "offered" | "later" | "confirm" | "downloading" | "installing" | "failed";

/** Was der Kern über die Aktualisierung weiß. */
export interface AppUpdateState {
  phase: Phase;
  /** Die neue Version, sobald der Kern eine gefunden hat. */
  version: string | null;
  /** Die installierte Fassung. */
  installed: string;
  /** Warum die Aktualisierung zuletzt scheiterte. */
  error: string | null;
}

/** Was der Ablauf vom Kern und vom Rechner braucht. */
export interface AppUpdatePort {
  /** Der Zustand, den der Kern gerade hält. */
  current(): Promise<AppUpdateState>;
  /** Meldet jeden neuen Zustand des Kerns, solange das Fenster lebt. */
  onChange(listener: (state: AppUpdateState) => void): void;
  /** Lädt die neue Version, prüft ihre Signatur, installiert sie und startet Kredr neu. */
  install(): Promise<void>;
  /** Schließt das Angebot in allen Fenstern. */
  later(): Promise<void>;
  /** Öffnet eine Web-Adresse im Standardbrowser. */
  openUrl(url: string): void;
}

/** Die Release-Seite einer Version auf GitHub. */
export function releasePage(version: string): string {
  return `https://github.com/SirKashij/Kredr/releases/tag/v${version}`;
}

/**
 * Ob unten rechts der Hinweis zur Aktualisierung steht: vom Angebot an, bis
 * die Person „Später“ wählt oder Kredr neu startet.
 */
export function showsNotice(state: AppUpdateState): boolean {
  return state.phase !== "none" && state.phase !== "later";
}

/**
 * Ob über dem Zahnrad der Aktivitätsleiste das Symbol der Aktualisierung
 * steht: nach „Später“ und nach einem Fehlschlag, bis aktualisiert ist.
 */
export function showsIcon(state: AppUpdateState): boolean {
  return (state.phase === "later" || state.phase === "failed") && state.version !== null;
}

/** Aus diesen Phasen heraus lässt sich die Aktualisierung anstoßen. */
const CAN_START = new Set<Phase>(["offered", "later", "failed"]);

/** Der Zustand, bevor der Kern geantwortet hat. */
const UNKNOWN: AppUpdateState = { phase: "none", version: null, installed: "", error: null };

/** Der Ablauf der Aktualisierung für ein Fenster, als Store für `useSyncExternalStore`. */
export class AppUpdate {
  private state = UNKNOWN;
  private readonly listeners = new Set<() => void>();
  /** Ob schon eine Meldung des Kerns kam; die erste Antwort ist dann veraltet. */
  private heard = false;
  /** Ob dieses Fenster gerade eine Aktualisierung angestoßen hat. */
  private started = false;

  constructor(private readonly port: AppUpdatePort) {
    port.onChange((state) => {
      this.heard = true;
      this.set(state);
    });
    port
      .current()
      .then((state) => {
        if (!this.heard) this.set(state);
      })
      .catch(() => {});
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.state;

  /**
   * „Jetzt aktualisieren“: lädt die neue Version und installiert sie; Kredr
   * startet danach neu. Den Fortschritt melden die Phasen des Kerns. Läuft
   * schon eine Aktualisierung, geschieht nichts.
   */
  async updateNow(): Promise<void> {
    if (this.started || !CAN_START.has(this.state.phase)) return;
    this.started = true;
    try {
      await this.port.install();
    } catch (reason) {
      this.set({ ...this.state, phase: "failed", error: String(reason) });
    } finally {
      this.started = false;
    }
  }

  /** „Neuerungen“: öffnet die Release-Seite der neuen Version im Browser. */
  showReleaseNotes() {
    if (this.state.version) this.port.openUrl(releasePage(this.state.version));
  }

  /** „Später“: schließt das Angebot in allen Fenstern. */
  later(): Promise<void> {
    return this.port.later().catch(() => {});
  }

  private set(state: AppUpdateState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
