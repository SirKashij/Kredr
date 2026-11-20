import { message } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { editor } from "monaco-editor/editor/editor.api";
import { fileName } from "./filePath";
import { useT } from "./i18n/i18n";
import { loadMonaco } from "./monacoLoader";
import type { OpenFile, OpenFiles } from "./openFiles";
import { useSettings } from "./settings";

/** Rendert neu, sobald sich der Zustand einer offenen Datei ändert. */
export function useOpenFiles(files: OpenFiles) {
  useSyncExternalStore(files.subscribe, files.version);
}

/**
 * Die Dateiansicht eines Tabs: der Inhalt der Datei `path` mit Syntaxfarben,
 * bearbeitbar und mit Strg+S zu speichern. Mit `focused` erhält sie die
 * Tastatureingaben, erneut bei jedem neuen `focusRequest`. `onEdited` meldet
 * die erste Bearbeitung.
 */
export function FileView({
  files,
  project,
  path,
  focused,
  focusRequest,
  onEdited,
}: {
  files: OpenFiles;
  project: string;
  path: string;
  focused: boolean;
  focusRequest: number;
  onEdited: () => void;
}) {
  const t = useT();
  useOpenFiles(files);
  const file = files.get(project, path);
  const { state, model } = file;
  const name = fileName(path);

  const edited = useRef(onEdited);
  edited.current = onEdited;
  useEffect(() => {
    if (state.dirty) edited.current();
  }, [state.dirty]);

  if (state.phase !== "text") {
    const notice =
      state.phase === "loading"
        ? null
        : state.phase === "binary"
          ? t("file.binary", { name })
          : state.phase === "tooLarge"
            ? t("file.tooLarge", { name, size: megabytes(state.size ?? 0) })
            : state.phase === "missing"
              ? t("file.missing", { name })
              : t("file.readFailed", { name, details: state.error ?? "" });
    return <div className="file-view">{notice && <p className="file-notice">{notice}</p>}</div>;
  }

  return (
    <div className="file-view">
      {state.conflict !== null && (
        <div className="file-banner" role="alert">
          <span>{t("file.conflict", { name })}</span>
          <button className="btn ghost" onClick={() => file.resolve("mine")}>
            {t("file.conflict.mine")}
          </button>
          <button className="btn" onClick={() => file.resolve("theirs")}>
            {t("file.conflict.theirs")}
          </button>
        </div>
      )}
      {state.deleted && (
        <div className="file-banner" role="alert">
          <span>{t("file.deleted", { name })}</span>
        </div>
      )}
      {model && (
        <FileEditor
          file={file}
          model={model}
          focused={focused}
          focusRequest={focusRequest}
          saveFailed={(details) => t("file.saveFailed", { name, details })}
        />
      )}
    </div>
  );
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Speichert die Datei und meldet ein Scheitern; `false` heißt: nicht gespeichert. */
export async function saveFile(file: OpenFile, failed: (details: string) => string) {
  try {
    await file.save();
    return true;
  } catch (reason) {
    await message(failed(String(reason)), { kind: "error" });
    return false;
  }
}

/** Die Monaco-Ansicht einer geladenen Textdatei. */
function FileEditor({
  file,
  model,
  focused,
  focusRequest,
  saveFailed,
}: {
  file: OpenFile;
  model: editor.ITextModel;
  focused: boolean;
  focusRequest: number;
  saveFailed: (details: string) => string;
}) {
  const { settings } = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<editor.IStandaloneCodeEditor | null>(null);
  const font = useRef(settings);
  font.current = settings;
  const failed = useRef(saveFailed);
  failed.current = saveFailed;

  useEffect(() => {
    let created: editor.IStandaloneCodeEditor | null = null;
    let cancelled = false;
    // Monaco ist bereits geladen, sonst gäbe es `model` nicht.
    loadMonaco().then(({ monaco, baseOptions }) => {
      if (cancelled) return;
      created = monaco.editor.create(host.current!, {
        ...baseOptions,
        model,
        fontFamily: font.current.fontFamily,
        fontSize: font.current.fontSize,
      });
      created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveFile(file, failed.current);
      });
      file.attach(created);
      setShown(created);
    });
    return () => {
      cancelled = true;
      if (!created) return;
      file.detach(created);
      created.dispose();
      setShown(null);
    };
  }, [file, model]);

  useEffect(() => {
    shown?.updateOptions({ fontFamily: settings.fontFamily, fontSize: settings.fontSize });
  }, [shown, settings.fontFamily, settings.fontSize]);

  useEffect(() => {
    // Wer gerade in ein Feld der Ansicht klickt (etwa die Suche), behält dort den Fokus.
    if (focused && shown && !host.current!.contains(document.activeElement)) shown.focus();
  }, [focused, focusRequest, shown]);

  return <div className="file-editor" ref={host} />;
}
