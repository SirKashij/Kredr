import { Component, type ReactNode } from "react";
import { useT } from "./i18n/i18n";

/** Eine gefangene Ausnahme. Eingepackt, weil auch `null` oder `undefined` geworfen werden kann. */
interface Crash {
  thrown: unknown;
}

interface TabErrorBoundaryProps {
  /** Ob der Tab gerade sichtbar ist; nur dann zeigt die Grenze ihren Inhalt. */
  active: boolean;
  children: ReactNode;
}

/**
 * Die Fehlergrenze eines Tabs. Sie lebt so lange wie ihr Tab (mit dessen
 * Kennung als `key` einhängen) und zeigt den Inhalt nur, solange er sichtbar
 * ist.
 *
 * Wirft der sichtbare Inhalt beim Zeichnen, in einem Effekt oder beim
 * Aufräumen, steht statt seiner eine Fehlermeldung mit der Möglichkeit, den Tab
 * neu zu laden. Wirft er beim Aufräumen, nachdem ein anderer Tab sichtbar
 * wurde, bleibt es bei einem Eintrag in der Entwicklerkonsole: Der Tab ist
 * nicht mehr zu sehen, und beim nächsten Anzeigen startet er frisch.
 *
 * Eine Grenze, die einen Fehler fängt, hängt alle ihre Kinder neu ein. Weil
 * jeder Tab seine eigene hat, trifft das nur ihn und nie die übrigen Tabs.
 */
export class TabErrorBoundary extends Component<
  TabErrorBoundaryProps,
  { crash: Crash | null; active: boolean }
> {
  state = { crash: null as Crash | null, active: this.props.active };

  static getDerivedStateFromError(thrown: unknown) {
    return { crash: { thrown } };
  }

  static getDerivedStateFromProps(
    props: TabErrorBoundaryProps,
    state: { active: boolean },
  ): { crash: null; active: boolean } | null {
    // Mit jedem Anzeigen oder Verlassen beginnt der Tab ohne Fehler.
    return props.active === state.active ? null : { crash: null, active: props.active };
  }

  componentDidCatch(thrown: unknown) {
    console.error("Ausnahme im Inhalt eines Tabs", thrown);
  }

  render() {
    const { active, children } = this.props;
    if (!active) return null;
    const { crash } = this.state;
    if (!crash) return children;
    return <TabCrash thrown={crash.thrown} onReload={() => this.setState({ crash: null })} />;
  }
}

function TabCrash({ thrown, onReload }: { thrown: unknown; onReload: () => void }) {
  const t = useT();
  const details = thrown instanceof Error ? thrown.message : String(thrown);
  return (
    <div className="tab-crash">
      <p>{t("tab.crashed", { details })}</p>
      <button className="btn ghost" onClick={onReload}>
        {t("tab.reload")}
      </button>
    </div>
  );
}

/**
 * Die letzte Rettung für Ausnahmen beim Aufräumen von Tab-Inhalten, deren
 * `TabErrorBoundary` mit ausgehängt wurde: beim Schließen des sichtbaren Tabs,
 * einer Gruppe oder beim Umbau der Aufteilung. Ohne sie leerte eine solche
 * Ausnahme das ganze Fenster. Fängt sie eine, hängt React den Hauptbereich neu
 * ein; die Terminals laufen außerhalb von React weiter und hängen sich wieder an.
 *
 * Wirft der Hauptbereich selbst beim Zeichnen, fängt React den zweiten Versuch
 * hier nicht mehr ab, und die Ausnahme geht weiter nach oben.
 */
export class UnmountedContentGuard extends Component<{ children: ReactNode }> {
  static getDerivedStateFromError() {
    return null;
  }

  componentDidCatch(thrown: unknown) {
    console.error("Ausnahme beim Aufräumen eines ausgehängten Tab-Inhalts", thrown);
  }

  render() {
    return this.props.children;
  }
}
