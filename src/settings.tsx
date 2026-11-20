import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  defaultSettings,
  loadSettings,
  onSettingsChanged,
  SettingsChanges,
  type Settings,
} from "./settingsStore";

interface SettingsAccess {
  settings: Settings;
  /** Ändert einzelne Einstellungen; die Änderung wirkt sofort in allen Fenstern. */
  change: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsAccess>({
  settings: defaultSettings,
  change: () => {},
});

/**
 * Hält die Einstellungen des Kerns für das Fenster bereit und folgt jeder
 * Änderung, auch aus anderen Fenstern. Bis sie geladen sind, bleibt das
 * Fenster leer, damit es nicht kurz in der falschen Sprache erscheint.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [changes] = useState(() => new SettingsChanges(defaultSettings));

  useEffect(() => {
    let reported = false;
    const receive = (received: Settings) => {
      reported = true;
      changes.received(received);
      setSettings(received);
    };
    const stop = onSettingsChanged(receive);
    loadSettings()
      .catch(() => defaultSettings)
      .then((loaded) => {
        // Eine Änderung, die während des Ladens gemeldet wurde, ist neuer.
        if (!reported) receive(loaded);
      });
    return stop;
  }, [changes]);

  if (!settings) return null;
  return (
    <SettingsContext.Provider value={{ settings, change: (patch) => void changes.change(patch) }}>
      {children}
    </SettingsContext.Provider>
  );
}

/** Die aktuellen Einstellungen; rendert bei jeder Änderung neu. */
export function useSettings(): SettingsAccess {
  return useContext(SettingsContext);
}
