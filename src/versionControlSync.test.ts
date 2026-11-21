import { expect, test } from "vitest";
import { VersionControlStore } from "./versionControl";
import {
  canCommit,
  canPull,
  canPush,
  commitsEverything,
  errorMessages,
  offersPullAndPush,
  syncCounts,
  type ChangedFile,
  type RepositoryState,
  type VersionControlError,
  type VersionControlState,
} from "./versionControlState";

function change(path: string, staged = false): ChangedFile {
  return { path, originalPath: null, status: "modified", staged };
}

function repository(changes: Partial<RepositoryState> = {}): RepositoryState {
  return {
    kind: "repository",
    branch: "main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    files: [change("a.ts")],
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    ...changes,
  };
}

const noRepository: VersionControlState = {
  kind: "unavailable",
  reason: "notARepository",
  details: "fatal: not a git repository",
};

const rejected: VersionControlError = {
  reason: "pushRejected",
  details: "! [rejected] main -> main (fetch first)",
};

test("ohne Nachricht ist der Commit gesperrt", () => {
  expect(canCommit(repository(), "", null)).toBe(false);
  expect(canCommit(repository(), "  \n ", null)).toBe(false);
  expect(canCommit(repository(), "Nachricht", null)).toBe(true);
});

test("ohne Änderungen und ohne Repository ist der Commit gesperrt", () => {
  expect(canCommit(repository({ files: [] }), "Nachricht", null)).toBe(false);
  expect(canCommit(noRepository, "Nachricht", null)).toBe(false);
  expect(canCommit(null, "Nachricht", null)).toBe(false);
});

test("während etwas läuft, sind Commit, Push und Pull gesperrt", () => {
  expect(canCommit(repository(), "Nachricht", "push")).toBe(false);
  expect(canPush(repository(), "pull")).toBe(false);
  expect(canPull(repository(), "commitAndPush")).toBe(false);
});

test("ohne Auswahl schreibt der Commit alles fest, mit Auswahl nur die Auswahl", () => {
  expect(commitsEverything(repository({ files: [change("a.ts"), change("b.ts")] }))).toBe(true);
  expect(commitsEverything(repository({ files: [change("a.ts", true), change("b.ts")] }))).toBe(
    false,
  );
});

test("ein Branch ohne Gegenstück lässt sich pushen, aber nicht pullen", () => {
  const unpublished = repository({ upstream: null });

  expect(canPush(unpublished, null)).toBe(true);
  expect(canPull(unpublished, null)).toBe(false);
  expect(canPull(repository(), null)).toBe(true);
});

test("ohne ausgecheckten Branch gibt es nichts zu pushen", () => {
  expect(canPush(repository({ branch: null, upstream: null }), null)).toBe(false);
  expect(canPush(noRepository, null)).toBe(false);
});

test("die Statusleiste nennt Vorsprung und Rückstand nur mit Gegenstück", () => {
  expect(syncCounts(repository({ ahead: 2, behind: 1 }))).toEqual({ ahead: 2, behind: 1 });
  expect(syncCounts(repository({ upstream: null }))).toBeNull();
  expect(syncCounts(noRepository)).toBeNull();
  expect(syncCounts(null)).toBeNull();
});

test("nur ein abgelehnter Push bietet „Erst holen, dann pushen“ an", () => {
  expect(offersPullAndPush(rejected)).toBe(true);
  expect(offersPullAndPush({ reason: "unreachable", details: "" })).toBe(false);
  expect(offersPullAndPush(null)).toBe(false);
});

test("jeder Grund eines Fehlers hat eine eigene Meldung", () => {
  const keys = Object.values(errorMessages);

  expect(new Set(keys).size).toBe(keys.length);
  expect(errorMessages.pushRejected).toBe("versionControl.error.pushRejected");
  expect(errorMessages.authenticationRequired).toBe("versionControl.error.authenticationRequired");
});

// Die Operationen des Fensters gegen einen Kern, der im Test antwortet.

interface Call {
  command: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Ein Store, dessen Aufrufe an den Kern der Test beantwortet. */
function storeWithCore() {
  const calls: Call[] = [];
  const store = new VersionControlStore(
    (command, args) =>
      new Promise((resolve, reject) => calls.push({ command, args: args ?? {}, resolve, reject })),
    "C:/projekt",
  );
  return { store, calls };
}

test("ein zweiter Klick während eines laufenden Abgleichs löst nichts aus", async () => {
  const { store, calls } = storeWithCore();

  const first = store.push();
  const second = store.push();
  const other = store.pull();

  expect(calls.map((call) => call.command)).toEqual(["version_control_push"]);
  expect(store.snapshot().busy).toBe("push");
  calls[0].resolve(null);
  await Promise.all([first, second, other]);
  expect(store.snapshot().busy).toBeNull();
});

test("Commit & Push leert die Nachricht und meldet den abgelehnten Push", async () => {
  const { store, calls } = storeWithCore();
  store.setMessage("Meine Änderung");

  const done = store.commitAndPush();

  expect(calls[0].command).toBe("version_control_commit_and_push");
  expect(calls[0].args).toEqual({ project: "C:/projekt", message: "Meine Änderung" });
  calls[0].resolve({ pushError: rejected });
  await done;
  expect(store.snapshot().message).toBe("");
  expect(store.snapshot().failure).toEqual(rejected);
  expect(store.snapshot().busy).toBeNull();
});

test("scheitert der Commit, bleibt die Nachricht stehen", async () => {
  const { store, calls } = storeWithCore();
  store.setMessage("Meine Änderung");
  const failed: VersionControlError = { reason: "failed", details: "hook failed" };

  const done = store.commit();
  calls[0].reject(failed);
  await done;

  expect(store.snapshot().message).toBe("Meine Änderung");
  expect(store.snapshot().failure).toEqual(failed);
});

test("ein gelungener Commit leert Nachricht und frühere Fehlermeldung", async () => {
  const { store, calls } = storeWithCore();
  store.setMessage("Erster Versuch");
  const failing = store.commit();
  calls[0].reject({ reason: "failed", details: "hook failed" });
  await failing;

  const done = store.commit();
  calls[1].resolve(null);
  await done;

  expect(store.snapshot().message).toBe("");
  expect(store.snapshot().failure).toBeNull();
});

test("„Erst holen, dann pushen“ ruft die eine Operation des Kerns", async () => {
  const { store, calls } = storeWithCore();

  const done = store.pullAndPush();

  expect(calls.map((call) => call.command)).toEqual(["version_control_pull_and_push"]);
  expect(store.snapshot().busy).toBe("pullAndPush");
  calls[0].resolve(null);
  await done;
});

test("während „Commit & Push“ läuft, wechselt kein Branch", async () => {
  const { store, calls } = storeWithCore();
  store.setMessage("Meine Änderung");
  const committing = store.commitAndPush();

  const switched = await store.changeBranch({
    kind: "branch",
    branch: { name: "andere", remote: null, current: false },
  });

  expect(switched).toBe(false);
  expect(calls.map((call) => call.command)).toEqual(["version_control_commit_and_push"]);
  calls[0].resolve({ pushError: null });
  await committing;
});

test("ein Branch-Wechsel sperrt die übrigen Operationen, bis er fertig ist", async () => {
  const { store, calls } = storeWithCore();
  const branch = { name: "andere", remote: null, current: false };

  const switching = store.changeBranch({ kind: "branch", branch });
  const pushing = store.push();

  expect(store.snapshot().busy).toBe("changeBranch");
  expect(calls.map((call) => call.command)).toEqual(["version_control_switch_branch"]);
  expect(calls[0].args).toEqual({ project: "C:/projekt", branch });
  calls[0].resolve(null);
  expect(await switching).toBe(true);
  await pushing;
  expect(store.snapshot().busy).toBeNull();
});

test("ein neuer Branch entsteht über dieselbe Sperre; ein Scheitern erfährt die Branch-Liste", async () => {
  const { store, calls } = storeWithCore();
  const exists: VersionControlError = { reason: "branchExists", details: "already exists" };

  const creating = store.changeBranch({ kind: "create", name: "feature" });

  expect(calls[0].command).toBe("version_control_create_branch");
  expect(calls[0].args).toEqual({ project: "C:/projekt", name: "feature" });
  calls[0].reject(exists);
  await expect(creating).rejects.toEqual(exists);
  expect(store.snapshot().busy).toBeNull();
  // Die Meldung gehört der Branch-Liste, nicht dem Feld unter der Commit-Nachricht.
  expect(store.snapshot().failure).toBeNull();
});

test("Auswählen ohne Dateien meint alle, mit Dateien genau diese", async () => {
  const { store, calls } = storeWithCore();
  const file = change("a.ts");

  const all = store.stage();
  calls[0].resolve(null);
  await all;
  const one = store.unstage([file]);
  calls[1].resolve(null);
  await one;

  expect(calls[0].command).toBe("version_control_stage");
  expect(calls[0].args).toEqual({ project: "C:/projekt", files: null });
  expect(calls[1].command).toBe("version_control_unstage");
  expect(calls[1].args).toEqual({ project: "C:/projekt", files: [file] });
});
