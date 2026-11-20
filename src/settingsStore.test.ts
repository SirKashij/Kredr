import { expect, test } from "vitest";
import { resolveKey } from "./keybindings";
import {
  defaultSettings,
  effectiveLanguage,
  parseFontSize,
  SettingsChanges,
  type Settings,
} from "./settingsStore";

test("ohne gewählte Sprache gilt die Windows-Sprache", () => {
  expect(effectiveLanguage(defaultSettings, ["de-DE", "en-US"])).toBe("de");
  expect(effectiveLanguage(defaultSettings, ["en-GB"])).toBe("en");
});

test("eine gewählte Sprache geht der Windows-Sprache vor", () => {
  expect(effectiveLanguage({ ...defaultSettings, language: "en" }, ["de-DE"])).toBe("en");
  expect(effectiveLanguage({ ...defaultSettings, language: "de" }, ["en-US"])).toBe("de");
});

test("eine Schriftgröße ist eine ganze Zahl von 6 bis 32", () => {
  expect(parseFontSize("14")).toBe(14);
  expect(parseFontSize(" 6 ")).toBe(6);
  expect(parseFontSize("32")).toBe(32);
});

test("unfertige und unzulässige Eingaben sind keine Schriftgröße", () => {
  // Wer „14“ tippt, kommt an „1“ vorbei; das darf noch nichts ändern.
  expect(parseFontSize("1")).toBeNull();
  expect(parseFontSize("33")).toBeNull();
  expect(parseFontSize("")).toBeNull();
  expect(parseFontSize("12.5")).toBeNull();
  expect(parseFontSize("groß")).toBeNull();
});

test("Strg+Komma öffnet die Einstellungen wie in VS Code", () => {
  const comma = { keyCode: 188, ctrlKey: true, shiftKey: false, altKey: false };
  expect(resolveKey(comma, false)).toEqual({ kind: "openSettings" });
  expect(resolveKey({ ...comma, ctrlKey: false }, false)).toBeNull();
});

/** Ein Kern, der wie der echte jede Speicherung erst später bestätigt. */
function slowCore() {
  const saved: Settings[] = [];
  const save = async (settings: Settings) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    saved.push(settings);
    return settings;
  };
  return { saved, save };
}

test("schnell aufeinander folgende Änderungen überschreiben einander nicht", async () => {
  const core = slowCore();
  const changes = new SettingsChanges(defaultSettings, core.save);

  changes.change({ fontSize: 16 });
  await changes.change({ agentCommand: "claude --continue" });

  expect(core.saved.at(-1)).toEqual({
    ...defaultSettings,
    fontSize: 16,
    agentCommand: "claude --continue",
  });
});

test("eine Änderung baut auf dem auf, was ein anderes Fenster geändert hat", async () => {
  const core = slowCore();
  const changes = new SettingsChanges(defaultSettings, core.save);

  changes.received({ ...defaultSettings, language: "en" });
  await changes.change({ fontSize: 18 });

  expect(core.saved).toEqual([{ ...defaultSettings, language: "en", fontSize: 18 }]);
});

test("eine gescheiterte Speicherung hält spätere Änderungen nicht auf", async () => {
  const core = slowCore();
  let fail = true;
  const changes = new SettingsChanges(defaultSettings, async (settings) => {
    if (fail) throw new Error("Datenträger voll");
    return core.save(settings);
  });

  await changes.change({ fontSize: 20 });
  fail = false;
  await changes.change({ agentCommand: "claude --verbose" });

  expect(core.saved).toEqual([{ ...defaultSettings, agentCommand: "claude --verbose" }]);
});
