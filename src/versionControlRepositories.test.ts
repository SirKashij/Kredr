import { beforeEach, expect, test, vi } from "vitest";
import type { ChangedFile, VersionControlState } from "./versionControlState";

/** Was der Kern über den Kanal einer Beobachtung meldet, je Projekt. */
const channels = new Map<string, { onmessage: (state: unknown) => void }>();
const watched: string[] = [];
const unwatched: number[] = [];

vi.mock("@tauri-apps/api/core", () => {
  let pending: { onmessage: (state: unknown) => void } | null = null;
  return {
    Channel: class {
      onmessage: (state: unknown) => void = () => {};
      constructor() {
        pending = this;
      }
    },
    invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === "version_control_watch") {
        const project = args.project as string;
        channels.set(project, pending!);
        watched.push(project);
        return watched.length;
      }
      if (command === "version_control_unwatch") unwatched.push(args.id as number);
      return null;
    }),
  };
});

const { VersionControls } = await import("./versionControl");

const web = "C:\\Projekte\\Web";
const core = "C:\\Projekte\\Kern";

function repository(files: ChangedFile[]): VersionControlState {
  return {
    kind: "repository",
    branch: "main",
    commit: "abc",
    files,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}
const change: ChangedFile = { path: "a.ts", originalPath: null, status: "modified", staged: false };

interface Call {
  command: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
}

/** Die Versionskontrolle eines Fensters, deren Operationen der Test beantwortet. */
function controlsWithCore() {
  const calls: Call[] = [];
  const controls = new VersionControls(
    (command, args) => new Promise((resolve) => calls.push({ command, args: args ?? {}, resolve })),
  );
  return { controls, calls };
}

beforeEach(() => {
  channels.clear();
  watched.length = 0;
  unwatched.length = 0;
});

test("jedes Projekt des Fensters hat seine eigene Versionskontrolle, in Reihenfolge", () => {
  const { controls } = controlsWithCore();
  controls.follow([web, core]);
  channels.get(core)!.onmessage(repository([change]));

  const entries = controls.snapshot().projects;
  expect(entries.map((entry) => entry.project)).toEqual([web, core]);
  expect(entries[0].snapshot.state).toBeNull();
  expect(entries[1].snapshot.state).toEqual(repository([change]));
});

test("ein Commit schreibt nur im eigenen Repository fest; der Text des anderen bleibt", async () => {
  const { controls, calls } = controlsWithCore();
  controls.follow([web, core]);
  channels.get(web)!.onmessage(repository([change]));
  channels.get(core)!.onmessage(repository([change]));
  controls.store(web)!.setMessage("Web: Kopfzeile");
  controls.store(core)!.setMessage("Kern: Speicher");

  const committed = controls.store(core)!.commit();
  expect(calls.map(({ command, args }) => [command, args])).toEqual([
    ["version_control_commit", { project: core, message: "Kern: Speicher" }],
  ]);
  calls[0].resolve(null);
  await committed;

  expect(controls.store(core)!.snapshot().message).toBe("");
  expect(controls.store(web)!.snapshot().message).toBe("Web: Kopfzeile");
  // Solange im einen Repository etwas läuft, ist das andere frei.
  expect(controls.store(web)!.snapshot().busy).toBeNull();
});

test("die gezeigte Änderung gehört zu genau einem Repository", () => {
  const { controls } = controlsWithCore();
  controls.follow([web, core]);
  channels.get(web)!.onmessage(repository([change]));
  channels.get(core)!.onmessage(repository([change]));

  controls.select(web, change);
  controls.select(core, change);

  expect(controls.snapshot().shown).toBe(core);
  expect(controls.store(core)!.snapshot().selected).toEqual(change);
  expect(controls.store(web)!.snapshot().selected).toBeNull();
});

test("ein entferntes Projekt endet mit seiner Beobachtung", async () => {
  const { controls } = controlsWithCore();
  controls.follow([web, core]);
  controls.select(core, change);

  controls.follow([web]);
  await Promise.resolve();
  await Promise.resolve();

  expect(controls.snapshot().projects.map((entry) => entry.project)).toEqual([web]);
  expect(controls.store(core)).toBeUndefined();
  expect(controls.snapshot().shown).toBeNull();
  expect(unwatched).toEqual([2]);
  // Ein bleibendes Projekt wird nicht neu beobachtet.
  expect(watched).toEqual([web, core]);
});
