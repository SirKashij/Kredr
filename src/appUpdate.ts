/**
 * Der Ablauf der Aktualisierung in einem Fenster. Den Zustand hält der Kern,
 * weil alle Fenster in einem Prozess laufen: Er sucht nach einer neuen Version
 * und meldet jede Änderung an alle Fenster. Eine Aktion in einem Fenster gilt
 * daher für alle.
 */

import type { MessageKey, Translate } from "./i18n/i18n";
import { hasReasons, sumReasons, type UpdateReasons } from "./updateReasons";

/** Wie weit die Aktualisierung ist. */
export type Phase = "none" | "offered" | "later" | "downloading" | "installing" | "failed";

/** Warum eine Aktualisierung scheiterte, eingeordnet vom Kern. */
export type FailureCause = "network" | "signature" | "installer" | "unknown";

/** Was der Kern über die Aktualisierung weiß. */
export interface AppUpdateState {
  phase: Phase;
  /** Die neue Version, sobald der Kern eine gefunden hat. */
  version: string | null;
  /** Die installierte Fassung. */
  installed: string;
  /** Wie weit der Download ist, 0 bis 100; ohne bekannte Größe `null`. */
  progress: number | null;
  /** Ob die Person den Hinweis zum Download weggeklickt hat. */
  hidden: boolean;
  /** Warum die Aktualisierung zuletzt scheiterte. */
  cause: FailureCause | null;
  /** Der Originaltext des letzten Fehlschlags. */
  error: string | null;
}

/** Was „Jetzt suchen“ ergab. */
export type CheckResult =
  | { outcome: "found"; version: string }
  | { outcome: "current" }
  /** Die Entwicklungsfassung sucht nicht, damit sie sich nicht selbst überschreibt. */
  | { outcome: "development" }
  | { outcome: "failed"; cause: FailureCause; error: string };

/** Was der Ablauf vom Kern und vom Rechner braucht. */
export interface AppUpdatePort {
  /** Der Zustand, den der Kern gerade hält. */
  current(): Promise<AppUpdateState>;
  /**
   * Sucht sofort nach einer neuen Version, auch bei abgeschalteter Suche.
   * Eine gefundene bietet der Kern in allen Fenstern an.
   */
  check(): Promise<CheckResult>;
  /** Meldet jeden neuen Zustand des Kerns, solange das Fenster lebt. */
  onChange(listener: (state: AppUpdateState) => void): void;
  /** Lädt die neue Version, prüft ihre Signatur, installiert sie und startet Kredr neu. */
  install(): Promise<void>;
  /** Die Anlässe jedes offenen Fensters; ein Fenster ohne Antwort als `SILENT_WINDOW`. */
  reasons(): Promise<UpdateReasons[]>;
  /** Die Rückfrage mit den Anlässen aller Fenster; `true` heißt: trotzdem aktualisieren. */
  confirm(reasons: UpdateReasons): Promise<boolean>;
  /** Jedes offene Fenster speichert seine Aufteilung. */
  saveArrangements(): Promise<void>;
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
 * die Person „Später“ wählt oder Kredr neu startet. Den Hinweis zum Download
 * kann sie wegklicken, den zur Installation nicht.
 */
export function showsNotice(state: AppUpdateState): boolean {
  if (state.phase === "downloading") return !state.hidden;
  return state.phase !== "none" && state.phase !== "later";
}

/**
 * Ob über dem Zahnrad der Aktivitätsleiste das Symbol der Aktualisierung
 * steht: nach „Später“ und nach einem Fehlschlag, bis aktualisiert ist, und
 * mit dem Fortschritt als Ring, solange ein weggeklickter Download läuft.
 */
export function showsIcon(state: AppUpdateState): boolean {
  if (state.version === null) return false;
  if (state.phase === "downloading") return state.hidden;
  return state.phase === "later" || state.phase === "failed";
}

/** Wie weit der Download ist, als Text für Hinweis und Symbol; ohne bekannte Größe ohne Prozent. */
export function downloadingText(t: Translate, state: AppUpdateState): string {
  const version = state.version ?? "";
  return state.progress === null
    ? t("appUpdate.downloading", { version })
    : t("appUpdate.downloadingProgress", { version, progress: String(state.progress) });
}

/** Der Satz zu jedem Grund eines Fehlschlags. */
const CAUSE_TEXTS: Record<FailureCause, MessageKey> = {
  network: "appUpdate.cause.network",
  signature: "appUpdate.cause.signature",
  installer: "appUpdate.cause.installer",
  unknown: "appUpdate.cause.unknown",
};

/** Der Grund eines Fehlschlags in einem Satz, für „Mehr Infos“. */
export function failureSentence(t: Translate, state: AppUpdateState): string {
  return t(CAUSE_TEXTS[state.cause ?? "unknown"]);
}

/** Das Ergebnis von „Jetzt suchen“ als Satz; ein Fehlschlag mit dem Grund wie bei „Mehr Infos“. */
export function checkResultText(t: Translate, result: CheckResult): string {
  switch (result.outcome) {
    case "found":
      return t("appUpdate.available", { version: result.version });
    case "current":
      return t("appUpdate.check.current");
    case "development":
      return t("appUpdate.check.development");
    case "failed":
      return t("appUpdate.check.failed", { reason: t(CAUSE_TEXTS[result.cause]) });
  }
}

/** Aus diesen Phasen heraus lässt sich die Aktualisierung anstoßen. */
const CAN_START = new Set<Phase>(["offered", "later", "failed"]);

/** Der Zustand, bevor der Kern geantwortet hat. */
const UNKNOWN: AppUpdateState = {
  phase: "none",
  version: null,
  installed: "",
  progress: null,
  hidden: false,
  cause: null,
  error: null,
};

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
   * beendet dabei alle Fenster und startet neu. Gibt es in einem Fenster etwas,
   * das verloren ginge oder abbräche, fasst eine Rückfrage die Anlässe aller
   * Fenster zusammen; „Später“ bricht ab. Vorher speichert jedes Fenster seine
   * Aufteilung. Den Fortschritt melden die Phasen des Kerns. Läuft schon eine
   * Aktualisierung, geschieht nichts.
   */
  async updateNow(): Promise<void> {
    if (this.started || !CAN_START.has(this.state.phase)) return;
    this.started = true;
    try {
      const reasons = sumReasons(await this.port.reasons());
      if (hasReasons(reasons) && !(await this.port.confirm(reasons))) return;
      // Die Aufteilung ist Komfort; an ihr scheitert die Aktualisierung nicht.
      await this.port.saveArrangements().catch(() => {});
      await this.port.install();
    } catch (reason) {
      this.set({
        ...this.state,
        phase: "failed",
        progress: null,
        hidden: false,
        cause: "unknown",
        error: String(reason),
      });
    } finally {
      this.started = false;
    }
  }

  /**
   * „Jetzt suchen“: sucht sofort nach einer neuen Version, auch bei
   * abgeschalteter Suche. Eine gefundene meldet der Kern allen Fenstern als
   * Angebot. Erreicht die Frage den Kern nicht, gilt die Suche als gescheitert.
   */
  checkNow(): Promise<CheckResult> {
    return this.port
      .check()
      .catch((reason) => ({ outcome: "failed", cause: "unknown", error: String(reason) }));
  }

  /** „Neuerungen“: öffnet die Release-Seite der neuen Version im Browser. */
  showReleaseNotes() {
    if (this.state.version) this.port.openUrl(releasePage(this.state.version));
  }

  /**
   * „Später“: schließt das Angebot in allen Fenstern. Während des Downloads
   * blendet es nur den Hinweis aus; das Symbol zeigt dann den Fortschritt.
   */
  later(): Promise<void> {
    return this.port.later().catch(() => {});
  }

  private set(state: AppUpdateState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
