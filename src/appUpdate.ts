/**
 * Der Ablauf der Aktualisierung in einem Fenster. Den Zustand hält der Kern,
 * weil alle Fenster in einem Prozess laufen: Er sucht nach einer neuen Version
 * und meldet jede Änderung an alle Fenster. Eine Aktion in einem Fenster gilt
 * daher für alle.
 */

import type { MessageKey, Translate } from "./i18n/translate";
import { hasNewReasons, hasReasons, sumReasons, type UpdateReasons } from "./updateReasons";

/** Wie weit die Aktualisierung ist. */
export type Phase =
  | "none"
  | "offered"
  | "later"
  /** Ein Fenster fragt nach den Anlässen; alle anderen zeigen das nur. */
  | "confirm"
  | "downloading"
  | "installing"
  | "failed";

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
  /**
   * Beginnt die Rückfrage in diesem Fenster; der Kern meldet sie allen
   * Fenstern. `false` heißt: Ein anderes Fenster fragt schon, oder die
   * Aktualisierung läuft.
   */
  ask(): Promise<boolean>;
  /** Beendet die Rückfrage dieses Fensters; der Kern kehrt zur Phase davor zurück. */
  cancel(): Promise<void>;
  /**
   * Ein Aufruf in diesem Fenster ist gescheitert; der Kern meldet allen
   * Fenstern den Fehlschlag mit `error` als Originaltext und beendet die
   * Rückfrage. `false` heißt: Dieses Fenster führt die Aktualisierung nicht.
   */
  fail(error: string): Promise<boolean>;
  /**
   * Lädt die neue Version und prüft ihre Signatur. Nur aus der Rückfrage
   * dieses Fensters heraus. `true` heißt: Sie liegt bereit, und das Fenster
   * hält wieder die Rückfrage, bis es installiert oder abbricht. Bei `false`
   * meldet der Kern den Fehlschlag, oder es gab nichts zu laden.
   */
  download(): Promise<boolean>;
  /**
   * Installiert die geladene Version und startet Kredr neu; der Kern merkt
   * sich dabei die offenen Fenster. Nur nach `download` in diesem Fenster.
   */
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
 * In diesen Phasen entscheidet `hidden`, ob der Hinweis oder das Symbol
 * steht: nach dem Wegklicken des Downloads und bei einer Rückfrage aus dem
 * Symbol heraus.
 */
const MAY_HIDE = new Set<Phase>(["confirm", "downloading"]);

/**
 * Ob unten rechts der Hinweis zur Aktualisierung steht: vom Angebot an, bis
 * die Person „Später“ wählt oder Kredr neu startet. Den Hinweis zum Download
 * kann sie wegklicken, den zur Installation nicht.
 */
export function showsNotice(state: AppUpdateState): boolean {
  if (MAY_HIDE.has(state.phase)) return !state.hidden;
  return state.phase !== "none" && state.phase !== "later";
}

/**
 * Ob über dem Zahnrad der Aktivitätsleiste das Symbol der Aktualisierung
 * steht: nach „Später“ und nach einem Fehlschlag, bis aktualisiert ist, und
 * mit dem Fortschritt als Ring, solange ein weggeklickter Download läuft.
 * Eine Rückfrage aus dem Symbol heraus zeigt es weiter.
 */
export function showsIcon(state: AppUpdateState): boolean {
  if (state.version === null) return false;
  if (MAY_HIDE.has(state.phase)) return state.hidden;
  return state.phase === "later" || state.phase === "failed";
}

/**
 * Ob Hinweis und Symbol „Jetzt aktualisieren“ und „Später“ anbieten. Während
 * der Rückfrage nicht: Sie läuft schon in einem Fenster.
 */
export function offersActions(state: AppUpdateState): boolean {
  return CAN_START.has(state.phase);
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

  constructor(private readonly port: AppUpdatePort) {
    port.onChange((state) => {
      this.heard = true;
      this.set(state);
    });
    // Nach dem Neuladen ist die Rückfrage dieses Fensters verloren; im Kern
    // darf sie nicht hängen bleiben. Hält das Fenster keine, ändert das nichts.
    port.cancel().catch(() => {});
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
   * Fenster zusammen; „Später“ bricht ab. Nach dem Download prüft Kredr die
   * Anlässe erneut, denn er kann dauern: Ist ein neuer dazugekommen, kommt die
   * Rückfrage noch einmal. Erst unmittelbar vor der Installation speichert
   * jedes Fenster seine Aufteilung; gleich danach merkt sich der Kern beim
   * Start des Installers die offenen Fenster. Den Fortschritt melden die Phasen des Kerns.
   * Solange die Rückfrage offen ist, meldet der Kern sie allen Fenstern als
   * `confirm` und lässt kein zweites Fenster fragen. Läuft schon eine
   * Aktualisierung oder Rückfrage, geschieht nichts.
   */
  async updateNow(): Promise<void> {
    if (!offersActions(this.state)) return;
    let asking = false;
    try {
      if (!(await this.port.ask())) return;
      asking = true;
      const before = sumReasons(await this.port.reasons());
      if (!(await this.confirmed(before, hasReasons(before)))) return;
      asking = false;
      if (!(await this.port.download())) return;
      asking = true;
      const after = sumReasons(await this.port.reasons());
      if (!(await this.confirmed(after, hasNewReasons(after, before)))) return;
      // Die Aufteilung ist Komfort; an ihr scheitert die Aktualisierung nicht.
      await this.port.saveArrangements().catch(() => {});
      asking = false;
      await this.port.install();
    } catch (reason) {
      await this.failed(String(reason), asking);
    }
  }

  /**
   * Ein Aufruf ist mit `error` gescheitert. Der Kern meldet den Fehlschlag
   * allen Fenstern und beendet dabei die Rückfrage. Erreicht ihn die Meldung
   * nicht, zeigt nur dieses Fenster den Fehlschlag; eine Rückfrage, die es
   * hält (`asking`), darf im Kern trotzdem nicht hängen bleiben.
   */
  private async failed(error: string, asking: boolean): Promise<void> {
    if (await this.port.fail(error).catch(() => false)) return;
    if (asking) await this.port.cancel().catch(() => {});
    this.set({
      ...this.state,
      phase: "failed",
      progress: null,
      hidden: false,
      cause: "unknown",
      error,
    });
  }

  /**
   * Fragt mit den Anlässen `reasons` nach, wenn `ask` es verlangt. „Später“
   * beendet die Rückfrage im Kern. Gibt zurück, ob die Aktualisierung weitergeht.
   */
  private async confirmed(reasons: UpdateReasons, ask: boolean): Promise<boolean> {
    if (!ask || (await this.port.confirm(reasons))) return true;
    await this.port.cancel();
    return false;
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
   * Während der Rückfrage gilt nur ihr eigenes „Später“.
   */
  async later(): Promise<void> {
    if (this.state.phase === "confirm") return;
    return this.port.later().catch(() => {});
  }

  private set(state: AppUpdateState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
