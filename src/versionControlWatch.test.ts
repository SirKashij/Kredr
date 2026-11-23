import { expect, test, vi } from "vitest";

/** Was der Kern über den Kanal der Beobachtung meldet. */
const channels: { onmessage: (state: unknown) => void }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (state: unknown) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
  invoke: vi.fn(async (command: string) => (command === "version_control_watch" ? 1 : null)),
}));

const { VersionControlStore } = await import("./versionControl");

test("nach dem Ende der Beobachtung zeigt die Versionskontrolle kein Projekt mehr", () => {
  const store = new VersionControlStore();
  const stop = store.watch("C:\\Projekte\\Web");
  channels.at(-1)!.onmessage({ kind: "noRepository" });
  expect(store.snapshot().state).toEqual({ kind: "noRepository" });

  // Etwa weil das letzte Projekt aus dem Workspace entfernt wurde.
  stop();

  expect(store.snapshot().project).toBeNull();
  expect(store.snapshot().state).toBeNull();
});
