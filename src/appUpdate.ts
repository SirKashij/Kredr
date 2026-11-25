/**
 * Die Aktualisierung in einem Fenster. Zustand und Ablauf hält der Kern, weil
 * alle Fenster in einem Prozess laufen: Er sucht nach einer neuen Version,
 * führt „Jetzt aktualisieren“ mit Rundfrage und Rückfrage und meldet jede
 * Änderung an alle Fenster. Eine Aktion in einem Fenster gilt daher für alle.
 * Das Fenster zeigt nur den Zustand und, wenn es fragt, den Dialog der
 * Rückfrage in seiner Sprache.
 */

import type { MessageKey, Translate } from "./i18n/translate";
import type { UpdateReasons } from "./updateReasons";

/** Wie weit die Aktualisierung ist. */
export type Phase =
  | "none"
  | "offered"
  | "later"
  /** Der Kern führt die Rückfrage; den Dialog zeigt nur das fragende Fenster. */
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
  /** Das Fenster, das „Jetzt aktualisieren“ ausgelöst hat und die Rückfrage zeigt. */
  asker: string | null;
  /**
   * Die Anlässe aller Fenster, solange der Kern auf die Antwort der Person
   * wartet; dann zeigt das fragende Fenster den Dialog.
   */
  reasons: UpdateReasons | null;
}

/** Was „Jetzt suchen“ ergab. */
export type CheckResult =
  | { outcome: "found"; version: string }
  | { outcome: "current" }
  /** Die Entwicklungsfassung sucht nicht, damit sie sich nicht selbst überschreibt. */
  | { outcome: "development" }
  | { outcome: "failed"; cause: FailureCause; error: string };

/** Was ein Fenster vom Kern und vom Rechner braucht. */
export interface AppUpdatePort {
  /** Das Label dieses Fensters. */
  window(): string;
  /** Der Zustand, den der Kern gerade hält. */
  current(): Promise<AppUpdateState>;
  /**
   * Sucht sofort nach einer neuen Version, auch bei abgeschalteter Suche.
   * Eine gefundene bietet der Kern in allen Fenstern an.
   */
  check(): Promise<CheckResult>;
  /** Meldet jeden neuen Zustand des Kerns, solange das Fenster lebt. */
  onChange(listener: (state: AppUpdateState) => void): void;
  /** „Jetzt aktualisieren“ aus diesem Fenster; der Kern führt den Ablauf. */
  updateNow(): Promise<void>;
  /** Der Dialog der Rückfrage mit den Anlässen aller Fenster; `true` heißt: trotzdem aktualisieren. */
  confirm(reasons: UpdateReasons): Promise<boolean>;
  /** Schickt die Antwort auf den Dialog an den Kern. */
  answer(proceed: boolean): Promise<void>;
  /** Beendet die Rückfrage dieses Fensters; der Kern kehrt zur Phase davor zurück. */
  cancel(): Promise<void>;
  /**
   * Der Dialog ist gescheitert; der Kern meldet allen Fenstern den
   * Fehlschlag mit `error` als Originaltext und beendet die Rückfrage.
   * `false` heißt: Dieses Fenster führt die Aktualisierung nicht.
   */
  fail(error: string): Promise<boolean>;
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
  asker: null,
  reasons: null,
};

/**
 * Die Aktualisierung in einem Fenster, als Store für `useSyncExternalStore`.
 * Den Ablauf führt der Kern; das Fenster zeigt seinen Zustand und, wenn es
 * fragt, den Dialog der Rückfrage.
 */
export class AppUpdate {
  private state = UNKNOWN;
  private readonly listeners = new Set<() => void>();
  /** Ob schon eine Meldung des Kerns kam; die erste Antwort ist dann veraltet. */
  private heard = false;
  /** Ob dieses Fenster gerade den Dialog der Rückfrage zeigt. */
  private asking = false;

  constructor(private readonly port: AppUpdatePort) {
    port.onChange((state) => {
      this.heard = true;
      this.set(state);
      this.askIfAsker(state);
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
   * „Jetzt aktualisieren“: Der Kern lädt die neue Version und installiert
   * sie; Kredr beendet dabei alle Fenster und startet neu. Läuft schon eine
   * Aktualisierung oder Rückfrage, geschieht nichts. Erreicht der Auftrag den
   * Kern nicht, zeigt wenigstens dieses Fenster den Fehlschlag.
   */
  async updateNow(): Promise<void> {
    if (!offersActions(this.state)) return;
    await this.port.updateNow().catch((reason) => this.showFailure(String(reason)));
  }

  /**
   * Verlangt der Kern die Rückfrage von diesem Fenster, zeigt es den Dialog
   * mit den Anlässen aller Fenster und schickt die Antwort zurück. Scheitert
   * der Dialog, zeigen alle Fenster den Fehlschlag.
   */
  private askIfAsker(state: AppUpdateState) {
    const reasons = state.reasons;
    if (state.phase !== "confirm" || !reasons || this.asking) return;
    if (state.asker !== this.port.window()) return;
    this.asking = true;
    this.port
      .confirm(reasons)
      .then((proceed) => this.port.answer(proceed))
      .catch((reason) => this.dialogFailed(String(reason)))
      .finally(() => {
        this.asking = false;
      });
  }

  /**
   * Der Dialog der Rückfrage ist gescheitert: Der Kern zeigt den Fehlschlag
   * in allen Fenstern. Erreicht ihn die Meldung nicht oder nimmt er sie nicht
   * an, darf die Rückfrage im Kern trotzdem nicht hängen bleiben; dann gibt
   * das Fenster sie auf und zeigt den Fehlschlag wenigstens selbst.
   */
  private async dialogFailed(error: string): Promise<void> {
    if (await this.port.fail(error).catch(() => false)) return;
    await this.port.cancel().catch(() => {});
    this.showFailure(error);
  }

  /**
   * Zeigt einen Fehlschlag mit `error` als Originaltext nur in diesem
   * Fenster, wenn der Kern ihn nicht melden kann, weil ihn ein Aufruf nicht
   * erreicht. Den Zustand dazu hält sonst der Kern.
   */
  private showFailure(error: string) {
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
