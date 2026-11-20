import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor/editor/editor.api";
import { fileName, fullPath } from "./filePath";
import { useT } from "./i18n/i18n";
import { loadMonaco } from "./monacoLoader";
import { watchProjectFiles } from "./projectFiles";
import { useSettings } from "./settings";
import {
  loadDiff,
  useVersionControl,
  useVersionControlStore,
  type Diff,
  type Version,
} from "./versionControl";
import { GitError } from "./VersionControlView";
import { statusLabels, type ChangedFile, type VersionControlError } from "./versionControlState";

/**
 * Der Tab „Versionskontrolle“ im Hauptbereich: der große Diff der Änderung,
 * die in der Seitenleiste gewählt ist. Mit `focused` erhält der Diff die
 * Tastatureingaben, erneut bei jedem neuen `focusRequest`.
 */
export function VersionControlTab({
  focused,
  focusRequest,
}: {
  focused: boolean;
  focusRequest: number;
}) {
  const t = useT();
  const store = useVersionControlStore();
  const { project, state, selected, sideBySide } = useVersionControl();

  return (
    <div className="vc-tab">
      <div className="vc-diff">
        {project && selected ? (
          <>
            <div className="vc-head">
              <span className="vc-path" title={selected.path}>
                {selected.path}
              </span>
              <span className={`git-${selected.status}`}>{t(statusLabels[selected.status])}</span>
              <div className="seg" role="group">
                <button
                  className={sideBySide ? "on" : ""}
                  aria-pressed={sideBySide}
                  onClick={() => store.setSideBySide(true)}
                >
                  {t("versionControl.sideBySide")}
                </button>
                <button
                  className={sideBySide ? "" : "on"}
                  aria-pressed={!sideBySide}
                  onClick={() => store.setSideBySide(false)}
                >
                  {t("versionControl.inline")}
                </button>
              </div>
            </div>
            <ChangeDiff
              project={project}
              file={selected}
              sideBySide={sideBySide}
              focused={focused}
              focusRequest={focusRequest}
            />
          </>
        ) : state?.kind === "unavailable" ? (
          <GitError error={state} />
        ) : (
          state && (
            <p className="vc-empty">
              {t(
                state.files.length > 0 ? "versionControl.selectChange" : "versionControl.noChanges",
              )}
            </p>
          )
        )}
      </div>
      {/* Rechts neben dem Diff folgt die Spalte „Verlauf“ mit den letzten Commits (#17). */}
    </div>
  );
}

/** Was der Diff zuletzt geladen hat. */
type Loaded = { file: ChangedFile; diff: Diff } | { file: ChangedFile; error: VersionControlError };

/** Der Text einer Fassung; eine fehlende Fassung (neue oder gelöschte Datei) ist leer. */
function textOf(version: Version): string | null {
  if (version.kind === "text") return version.text;
  return version.kind === "missing" ? "" : null;
}

/**
 * Der Diff einer Änderung. Er lädt sich neu, sobald sich die Datei oder das
 * Repository ändert (ein Agent schreibt, im Terminal wird festgeschrieben).
 */
function ChangeDiff({
  project,
  file,
  ...view
}: {
  project: string;
  file: ChangedFile;
  sideBySide: boolean;
  focused: boolean;
  focusRequest: number;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // `file` ist nach jedem neuen Zustand ein neues Objekt; auch dann lädt der Diff neu.
  useEffect(() => {
    let stopped = false;
    let loading = false;
    let again = false;
    async function load() {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      do {
        again = false;
        const next: Loaded = await loadDiff(project, file).then(
          (diff) => ({ file, diff }),
          (error: VersionControlError) => ({ file, error }),
        );
        if (stopped) return;
        setLoaded(next);
      } while (again);
      loading = false;
    }
    void load();
    const stop = watchProjectFiles(project, (changes) => {
      const concerned = (path: string) =>
        path === file.path || path === file.originalPath || path.startsWith(".git/");
      if (changes.rescan || changes.paths.some(concerned)) void load();
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [project, file]);

  // Bis der Diff der neu gewählten Datei da ist, bleibt der bisherige stehen.
  if (!loaded) return <div className="vc-body" />;
  if ("error" in loaded) {
    return (
      <div className="vc-body">
        <GitError error={loaded.error} />
      </div>
    );
  }
  const original = textOf(loaded.diff.original);
  const modified = textOf(loaded.diff.modified);
  if (original === null || modified === null) {
    const { original: before, modified: after } = loaded.diff;
    const tooLarge = before.kind === "tooLarge" || after.kind === "tooLarge";
    return (
      <div className="vc-body">
        <p className="vc-empty">
          {t(tooLarge ? "versionControl.tooLarge" : "versionControl.binary", {
            name: fileName(loaded.file.path),
          })}
        </p>
      </div>
    );
  }
  return (
    <DiffEditor
      project={project}
      path={loaded.file.path}
      originalPath={loaded.file.originalPath ?? loaded.file.path}
      original={original}
      modified={modified}
      {...view}
    />
  );
}

let modelCount = 0;

/** Der Diff-Editor von Monaco für zwei Fassungen einer Datei, nur zum Lesen. */
function DiffEditor({
  project,
  path,
  originalPath,
  original,
  modified,
  sideBySide,
  focused,
  focusRequest,
}: {
  project: string;
  path: string;
  originalPath: string;
  original: string;
  modified: string;
  sideBySide: boolean;
  focused: boolean;
  focusRequest: number;
}) {
  const { settings } = useSettings();
  const host = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<editor.IStandaloneDiffEditor | null>(null);
  const initial = useRef({ settings, sideBySide });
  const texts = useRef({ original, modified });
  texts.current = { original, modified };

  useEffect(() => {
    let created: editor.IStandaloneDiffEditor | null = null;
    let cancelled = false;
    loadMonaco().then(({ monaco, baseOptions }) => {
      if (cancelled) return;
      created = monaco.editor.createDiffEditor(host.current!, {
        ...baseOptions,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: initial.current.sideBySide,
        // Die Darstellung wählt der Nutzer, nicht die Breite der Gruppe.
        useInlineViewWhenSpaceIsLimited: false,
        fontFamily: initial.current.settings.fontFamily,
        fontSize: initial.current.settings.fontSize,
      });
      setShown(created);
    });
    return () => {
      cancelled = true;
      created?.dispose();
      setShown(null);
    };
  }, []);

  // Je Datei zwei Texte in Monaco; die Sprache ergibt sich aus dem Dateinamen.
  useEffect(() => {
    if (!shown) return;
    let models: editor.IDiffEditorModel | null = null;
    let cancelled = false;
    loadMonaco().then(({ monaco }) => {
      if (cancelled) return;
      // Die laufende Nummer hält die Adressen eindeutig, auch neben einer Dateiansicht.
      const address = (file: string) =>
        monaco.Uri.file(fullPath(project, file)).with({ query: `diff-${(modelCount += 1)}` });
      models = {
        original: monaco.editor.createModel(
          texts.current.original,
          undefined,
          address(originalPath),
        ),
        modified: monaco.editor.createModel(texts.current.modified, undefined, address(path)),
      };
      shown.setModel(models);
    });
    return () => {
      cancelled = true;
      shown.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
    };
  }, [shown, project, path, originalPath]);

  // Ändert sich eine Fassung, bleibt die Stelle stehen, an der gelesen wird.
  useEffect(() => {
    const models = shown?.getModel();
    if (!shown || !models) return;
    const view = shown.saveViewState();
    if (models.original.getValue() !== original) models.original.setValue(original);
    if (models.modified.getValue() !== modified) models.modified.setValue(modified);
    shown.restoreViewState(view);
  }, [shown, original, modified]);

  useEffect(() => {
    shown?.updateOptions({
      renderSideBySide: sideBySide,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
    });
  }, [shown, sideBySide, settings.fontFamily, settings.fontSize]);

  useEffect(() => {
    if (!focused || !shown) return;
    const active = document.activeElement;
    // Wer in der Seitenleiste durch die Änderungen klickt, behält dort die Tastatur.
    if (host.current!.contains(active) || active?.closest(".sidebar")) return;
    shown.focus();
  }, [focused, focusRequest, shown]);

  return <div className="file-editor" ref={host} />;
}
