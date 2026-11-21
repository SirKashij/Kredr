// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultSettings } from "./settingsStore";

/**
 * Ein Ersatz für Monaco, der dessen Vertrag durchsetzt: Ein zerstörter
 * Editor nimmt keine Aufrufe mehr an, und ein Modell darf erst zerstört
 * werden, wenn kein Editor es mehr zeigt. Jeder Verstoß wird festgehalten
 * und wirft wie das echte Monaco.
 */
const violations: string[] = [];

function violate(message: string): never {
  violations.push(message);
  throw new Error(message);
}

class FakeModel {
  attached = false;
  disposed = false;
  constructor(private text: string) {}
  getValue() {
    return this.text;
  }
  setValue(text: string) {
    this.text = text;
  }
  dispose() {
    if (this.attached) violate("Modell zerstört, während der Editor es zeigt");
    this.disposed = true;
  }
}

class FakeDiffEditor {
  disposed = false;
  model: { original: FakeModel; modified: FakeModel } | null = null;
  private use(name: string) {
    if (this.disposed) violate(`${name} auf zerstörtem Editor`);
  }
  setModel(model: { original: FakeModel; modified: FakeModel } | null) {
    this.use("setModel");
    for (const m of [this.model?.original, this.model?.modified]) if (m) m.attached = false;
    this.model = model;
    for (const m of [model?.original, model?.modified]) if (m) m.attached = true;
  }
  getModel() {
    this.use("getModel");
    return this.model;
  }
  saveViewState() {
    this.use("saveViewState");
    return null;
  }
  restoreViewState() {
    this.use("restoreViewState");
  }
  updateOptions() {
    this.use("updateOptions");
  }
  focus() {
    this.use("focus");
  }
  dispose() {
    // Wie Monaco: Der Editor gibt seine Modelle beim Zerstören nicht frei.
    for (const m of [this.model?.original, this.model?.modified]) if (m) m.attached = false;
    this.disposed = true;
  }
}

const fakeMonaco = {
  editor: {
    createDiffEditor: () => new FakeDiffEditor(),
    createModel: (text: string) => new FakeModel(text),
  },
  Uri: { file: () => ({ with: () => ({}) }) },
};

vi.mock("./monacoLoader", () => ({
  loadMonaco: () => Promise.resolve({ monaco: fakeMonaco, baseOptions: {} }),
}));
vi.mock("./settings", () => ({
  useSettings: () => ({ settings: defaultSettings }),
}));

const { DiffEditor } = await import("./VersionControlTab");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let uncaught: unknown[];

beforeEach(() => {
  violations.length = 0;
  uncaught = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
});

afterEach(() => {
  document.body.innerHTML = "";
});

function diffOf(path: string) {
  return (
    <DiffEditor
      project="C:/proj"
      path={path}
      originalPath={path}
      original="alt"
      modified="neu"
      sideBySide
      focused={false}
      focusRequest={0}
    />
  );
}

/** Wartet, bis Monaco „geladen“ ist und die Effekte danach gelaufen sind. */
async function settle() {
  for (let i = 0; i < 3; i++) await act(() => Promise.resolve());
}

test("der Diff lässt sich aushängen, ohne dass Monaco einen zerstörten Editor bedient", async () => {
  await act(() => root.render(diffOf("a.txt")));
  await settle();

  // So hängt der Tab „Versionskontrolle“ aus, wenn seine Gruppe einen anderen Tab zeigt.
  await act(() => root.unmount());

  expect(violations).toEqual([]);
  expect(uncaught).toEqual([]);
});

test("beim Wechsel der Datei werden die alten Modelle erst nach dem Lösen zerstört", async () => {
  await act(() => root.render(diffOf("a.txt")));
  await settle();
  await act(() => root.render(diffOf("b.txt")));
  await settle();
  await act(() => root.unmount());

  expect(violations).toEqual([]);
  expect(uncaught).toEqual([]);
});
