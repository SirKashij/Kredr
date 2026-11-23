import { invoke } from "@tauri-apps/api/core";
import type { editor } from "monaco-editor/editor/editor.api";
import { fullPath, isOutsideProject, pathKey, toProjectPath } from "./filePath";
import {
  edited,
  loadingFile,
  received,
  resolveConflict,
  saved,
  type FileContent,
  type FileState,
  type Step,
} from "./fileState";
import { loadMonaco } from "./monacoLoader";
import type { ProjectChanges } from "./projectFiles";

/** Eine Stelle in einer Datei; Zeile und Spalte zählen ab 1. */
export interface FilePosition {
  line: number;
  column?: number;
  /** Mit Ende wird der Bereich markiert, etwa ein Fund der Textsuche. */
  endLine?: number;
  endColumn?: number;
}

/**
 * Eine geöffnete Datei: ihr Zustand, ihr Text in Monaco und die Stelle, an der
 * zuletzt gelesen wurde. Sie lebt, solange ihr Tab offen ist, unabhängig davon,
 * ob und in welcher Gruppe er gerade angezeigt wird.
 */
export class OpenFile {
  private current: FileState = loadingFile;
  private textModel: editor.ITextModel | null = null;
  /** Der zuletzt gelesene Text, bis Monaco geladen ist und ihn übernimmt. */
  private pendingText: string | null = null;
  /** Der Bearbeitungsstand von Monaco, der dem gespeicherten Inhalt entspricht. */
  private savedVersion = 0;
  /** Gesetzt, während ein Inhalt von der Festplatte übernommen wird. */
  private loading = false;
  private shown: editor.ICodeEditor | null = null;
  private viewState: editor.ICodeEditorViewState | null = null;
  private pendingPosition: FilePosition | null = null;
  private focusWanted = false;
  private reads = 0;
  private disposed = false;

  constructor(
    /**
     * Der Ordner des Projekts, relativ zu dem `path` gemeint ist und mit dem
     * der Kern die Datei liest. Im Workspace ist das das erste Projekt, auch
     * wenn die Datei in einem anderen liegt.
     */
    readonly project: string,
    /** Relativ zum Projektordner; außerhalb des Projekts der volle Pfad. */
    readonly path: string,
    private readonly changed: () => void,
  ) {
    this.read();
  }

  get state(): FileState {
    return this.current;
  }

  /** Der Text der Datei in Monaco, sobald beides geladen ist. */
  get model(): editor.ITextModel | null {
    return this.textModel;
  }

  /** Liest die Datei (erneut) und übernimmt, was sich daraus ergibt. */
  read() {
    const read = (this.reads += 1);
    const { project, path } = this;
    invoke<FileContent>("project_files_read", { project, path })
      .catch((reason): FileContent => ({ kind: "error", message: String(reason) }))
      .then((content) => {
        // Von mehreren Lesevorgängen zählt nur der jüngste.
        if (read === this.reads && !this.disposed) this.apply(received(this.current, content));
      });
  }

  /** Speichert den Text; scheitert das, bleibt die Datei ungespeichert. */
  async save(): Promise<void> {
    const model = this.textModel;
    if (!model || this.current.phase !== "text") return;
    // Zeilenenden und Byte-Order-Mark bleiben, wie sie in der Datei waren.
    const text = model.getValue(undefined, true);
    const version = model.getAlternativeVersionId();
    const { project, path } = this;
    await invoke("project_files_write", { project, path, text });
    if (this.disposed) return;
    this.savedVersion = version;
    this.current = saved(this.current, text, model.getAlternativeVersionId() !== version);
    this.changed();
  }

  /** Entscheidet einen Konflikt: die eigene Fassung behalten oder die neue laden. */
  resolve(keep: "mine" | "theirs") {
    this.apply(resolveConflict(this.current, keep));
  }

  /** Springt an die Stelle, sobald die Datei angezeigt wird. */
  reveal(position: FilePosition) {
    this.pendingPosition = position;
    this.applyPosition();
  }

  /** Merkt vor, dass die Ansicht dieser Datei die Tastatureingaben erhalten soll. */
  wantFocus() {
    this.focusWanted = true;
  }

  /** Ob die Tastatureingaben vorgemerkt waren; die Vormerkung ist damit eingelöst. */
  takeFocusWish(): boolean {
    const wanted = this.focusWanted;
    this.focusWanted = false;
    return wanted;
  }

  /** Meldet die Monaco-Ansicht an, die diese Datei gerade zeigt. */
  attach(shown: editor.ICodeEditor) {
    this.shown = shown;
    if (this.viewState) shown.restoreViewState(this.viewState);
    this.applyPosition();
  }

  /** Meldet die Ansicht ab und merkt sich Scrollposition und Cursor. */
  detach(shown: editor.ICodeEditor) {
    if (this.shown !== shown) return;
    this.viewState = shown.saveViewState();
    this.shown = null;
  }

  dispose() {
    this.disposed = true;
    this.textModel?.dispose();
    this.textModel = null;
  }

  private apply({ state, load }: Step) {
    const before = this.current;
    this.current = state;
    if (load !== undefined) this.load(load);
    if (state !== before || load !== undefined) this.changed();
  }

  /** Übernimmt einen Inhalt von der Festplatte als neuen gespeicherten Stand. */
  private load(text: string) {
    const model = this.textModel;
    if (!model) {
      this.pendingText = text;
      loadMonaco().then(({ monaco }) => this.createModel(monaco));
      return;
    }
    // Die Scrollposition bleibt, auch wenn sich der Inhalt ändert.
    const view = this.shown?.saveViewState();
    this.loading = true;
    model.setValue(text);
    this.loading = false;
    if (view) this.shown?.restoreViewState(view);
    this.savedVersion = model.getAlternativeVersionId();
  }

  private createModel(monaco: typeof import("./monaco").monaco) {
    if (this.disposed || this.textModel || this.pendingText === null) return;
    // Die Sprache ergibt sich aus Dateiname und Endung. Die laufende Nummer
    // hält die Adresse eindeutig, falls die Datei gerade erst geschlossen wurde.
    const uri = monaco.Uri.file(fullPath(this.project, this.path)).with({
      query: String((modelCount += 1)),
    });
    const model = monaco.editor.createModel(this.pendingText, undefined, uri);
    this.pendingText = null;
    this.textModel = model;
    this.savedVersion = model.getAlternativeVersionId();
    model.onDidChangeContent(() => {
      if (this.loading) return;
      const dirty = model.getAlternativeVersionId() !== this.savedVersion;
      const state = edited(this.current, dirty);
      if (state === this.current) return;
      this.current = state;
      this.changed();
    });
    this.changed();
  }

  private applyPosition() {
    const position = this.pendingPosition;
    if (!position || !this.shown) return;
    this.pendingPosition = null;
    const { line, column = 1 } = position;
    this.shown.setSelection({
      startLineNumber: line,
      startColumn: column,
      endLineNumber: position.endLine ?? line,
      endColumn: position.endColumn ?? column,
    });
    this.shown.revealLineInCenterIfOutsideViewport(line);
  }
}

let modelCount = 0;

/**
 * Die offenen Dateien eines Fensters, nach ihrem Pfad. Wer etwas anzeigt,
 * das von ihrem Zustand abhängt, abonniert Änderungen über `subscribe`.
 */
export class OpenFiles {
  private readonly files = new Map<string, OpenFile>();
  private readonly listeners = new Set<() => void>();
  private count = 0;

  /** Die offene Datei zu diesem Pfad; beim ersten Mal wird sie gelesen. */
  get(project: string, path: string): OpenFile {
    const key = pathKey(path);
    let file = this.files.get(key);
    if (!file) {
      file = new OpenFile(project, path, this.changed);
      this.files.set(key, file);
    }
    return file;
  }

  find(path: string): OpenFile | undefined {
    return this.files.get(pathKey(path));
  }

  /** Ob irgendeine offene Datei ungespeicherte Änderungen hat. */
  anyDirty(): boolean {
    return [...this.files.values()].some((file) => file.state.dirty);
  }

  /**
   * Die offene Datei heißt im Tab jetzt `to` statt `from`, etwa mit vollem
   * statt relativem Pfad. Sie bleibt dieselbe, samt ungespeicherten Änderungen.
   */
  rekey(from: string, to: string) {
    const file = this.files.get(pathKey(from));
    if (!file || this.files.has(pathKey(to))) return;
    this.files.delete(pathKey(from));
    this.files.set(pathKey(to), file);
  }

  /** Schließt alle Dateien, deren Tab es nicht mehr gibt. */
  retain(paths: Iterable<string>) {
    const kept = new Set([...paths].map(pathKey));
    for (const [key, file] of this.files) {
      if (kept.has(key)) continue;
      file.dispose();
      this.files.delete(key);
    }
  }

  /**
   * Der Ereignisstrom eines Projekts: Betroffene offene Dateien, die in
   * diesem Projekt liegen, lesen sich neu. Eine Datei gehört zu dem Projekt,
   * in dessen Ordner sie liegt, auch wenn sie im Workspace mit vollem Pfad
   * relativ zum ersten Projekt geöffnet wurde.
   */
  projectChanged(project: string, changes: ProjectChanges) {
    const paths = changes.paths.map(pathKey);
    for (const file of this.files.values()) {
      const inProject = toProjectPath(project, fullPath(file.project, file.path));
      if (isOutsideProject(inProject)) continue;
      const key = pathKey(inProject);
      // Auch ein umbenannter oder gelöschter Ordner über der Datei betrifft sie.
      const affected = paths.some((path) => key === path || key.startsWith(`${path}/`));
      if (changes.rescan || affected) file.read();
    }
  }

  /** Meldet jede Zustandsänderung einer offenen Datei; der Rückgabewert beendet das. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Steigt mit jeder Zustandsänderung (für `useSyncExternalStore`). */
  version = (): number => this.count;

  private changed = () => {
    this.count += 1;
    this.listeners.forEach((notify) => notify());
  };
}
