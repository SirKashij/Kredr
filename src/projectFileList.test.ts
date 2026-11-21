import { expect, test } from "vitest";
import type { ProjectChanges } from "./projectFiles";
import { ProjectFileList } from "./projectFileList";

/** Ein Projektordner im Speicher anstelle des Kerns. */
function fakeProject(initial: string[]) {
  const listeners = new Set<(changes: ProjectChanges) => void>();
  const state = {
    files: initial,
    /** Wie oft die Dateiliste gelesen wurde. */
    reads: 0,
    change(changes: Partial<ProjectChanges>) {
      listeners.forEach((notify) => notify({ paths: [], rescan: false, ...changes }));
    },
  };
  const list = new ProjectFileList({
    list: async () => {
      state.reads += 1;
      return [...state.files];
    },
    watch: (_project, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return Object.assign(state, { list });
}

/** Wartet, bis angestoßenes Lesen fertig ist. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("die Dateiliste ist gelesen, sobald das Projekt geöffnet ist", async () => {
  const project = fakeProject(["a.ts", "b.ts"]);

  project.list.open("C:/projekt");
  await settled();

  expect(project.list.index.paths).toEqual(["a.ts", "b.ts"]);
});

test("solange jemand zusieht, erscheinen neue Dateien und verschwinden gelöschte", async () => {
  const project = fakeProject(["a.ts", "b.ts"]);
  project.list.open("C:/projekt");
  let notified = 0;
  project.list.subscribe(() => (notified += 1));
  await settled();
  notified = 0;

  project.files = ["a.ts", "neu.ts"];
  project.change({ paths: ["neu.ts", "b.ts"] });
  await settled();

  expect(project.list.index.paths).toEqual(["a.ts", "neu.ts"]);
  expect(notified).toBe(1);
});

test("sieht niemand zu, wird erst beim nächsten Hinsehen neu gelesen", async () => {
  const project = fakeProject(["a.ts"]);
  project.list.open("C:/projekt");
  await settled();

  project.files = ["a.ts", "neu.ts"];
  project.change({ paths: ["neu.ts"] });
  project.change({ paths: ["neu.ts"] });
  await settled();
  expect(project.reads).toBe(1);

  project.list.subscribe(() => {});
  await settled();

  expect(project.reads).toBe(2);
  expect(project.list.index.paths).toEqual(["a.ts", "neu.ts"]);
});

test("ohne Änderung liest erneutes Hinsehen nichts neu", async () => {
  const project = fakeProject(["a.ts"]);
  project.list.open("C:/projekt");
  await settled();

  const stop = project.list.subscribe(() => {});
  stop();
  project.list.subscribe(() => {});
  await settled();

  expect(project.reads).toBe(1);
});

test("auch ein Überlauf des Ereignisstroms lässt neu lesen", async () => {
  const project = fakeProject(["a.ts"]);
  project.list.open("C:/projekt");
  project.list.subscribe(() => {});
  await settled();

  project.files = [];
  project.change({ rescan: true });
  await settled();

  expect(project.list.index.paths).toEqual([]);
});

test("Änderungen nur im Ordner .git lassen die Dateiliste in Ruhe", async () => {
  const project = fakeProject(["a.ts"]);
  project.list.open("C:/projekt");
  project.list.subscribe(() => {});
  await settled();

  project.change({ paths: [".git/index", ".git/objects/ab/cd"] });
  await settled();

  expect(project.reads).toBe(1);
});

test("eine Änderung während des Lesens geht nicht verloren", async () => {
  const project = fakeProject(["a.ts"]);
  project.list.open("C:/projekt");
  project.list.subscribe(() => {});
  // Das erste Lesen läuft noch und hat den alten Stand gesehen.
  project.files = ["a.ts", "neu.ts"];
  project.change({ paths: ["neu.ts"] });
  await settled();
  await settled();

  expect(project.list.index.paths).toEqual(["a.ts", "neu.ts"]);
});

test("nach dem Schließen des Projekts ist die Dateiliste leer", async () => {
  const project = fakeProject(["a.ts"]);
  const close = project.list.open("C:/projekt");
  await settled();

  close();

  expect(project.list.index.paths).toEqual([]);
});
