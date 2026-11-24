// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateState, CheckResult } from "./appUpdate";
import { I18nProvider } from "./i18n/i18n";
import { defaultSettings } from "./settingsStore";

vi.mock("./settings", () => ({
  useSettings: () => ({ settings: { ...defaultSettings, checkForUpdates: false } }),
}));

const none: AppUpdateState = {
  phase: "none",
  version: null,
  installed: "0.6.1",
  progress: null,
  hidden: false,
  cause: null,
  error: null,
};

/** Was der Kern auf „Jetzt suchen“ antwortet, und wie oft er gefragt wurde. */
const core = { result: { outcome: "current" } as CheckResult, checks: 0 };
/** Wer im Fenster auf neue Zustände der Aktualisierung hört. */
const listeners: ((event: { payload: AppUpdateState }) => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "app_update_state") return none;
    if (command === "available_shells") return ["powershell"];
    if (command !== "app_update_check") return undefined;
    core.checks += 1;
    // Wie der Kern: Eine gefundene Version bietet sich in allen Fenstern an.
    if (core.result.outcome === "found") {
      const offered = { ...none, phase: "offered", version: core.result.version } as const;
      listeners.forEach((listener) => listener({ payload: offered }));
    }
    return core.result;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event: string, listener: (event: { payload: AppUpdateState }) => void) => {
    listeners.push(listener);
    return () => {};
  },
}));

const { SettingsPage } = await import("./SettingsPage");
const { AppUpdateNotice } = await import("./AppUpdateNotice");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Jetzt suchen bei abgeschalteter Suche", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    core.checks = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <I18nProvider language="de">
          <SettingsPage onClose={() => {}} />
          <AppUpdateNotice />
        </I18nProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const searchSwitch = () =>
    [...host.querySelectorAll<HTMLLabelElement>(".setting")]
      .find((row) => row.textContent?.includes("Nach Aktualisierungen suchen"))!
      .querySelector<HTMLInputElement>("input[type=checkbox]")!;

  async function searchNow() {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Jetzt suchen",
    )!;
    await act(async () => button.click());
  }

  it("zeigt den abgeschalteten Schalter und die installierte Version", () => {
    expect(searchSwitch().checked).toBe(false);
    expect(host.textContent).toContain("Installiert ist 0.6.1.");
  });

  it("findet eine neue Version und zeigt das Angebot", async () => {
    core.result = { outcome: "found", version: "0.7.0" };

    await searchNow();

    expect(core.checks).toBe(1);
    expect(host.textContent).toContain("Kredr 0.7.0 ist verfügbar.");
    expect(host.querySelector(".notice")?.textContent).toContain("Jetzt aktualisieren");
  });

  it("meldet, dass Kredr aktuell ist", async () => {
    core.result = { outcome: "current" };

    await searchNow();

    expect(core.checks).toBe(1);
    expect(host.textContent).toContain("Kredr ist aktuell.");
  });

  it("nennt bei gescheiterter Suche den Grund wie „Mehr Infos“", async () => {
    core.result = { outcome: "failed", cause: "network", error: "error sending request" };

    await searchNow();

    expect(host.textContent).toContain("Suche fehlgeschlagen. Keine Verbindung zu GitHub.");
  });
});
