import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fileIcon } from "./fileIcons";
import { useT, type MessageKey } from "./i18n/i18n";
import type { FilePosition } from "./openFiles";
import { searchText, type SearchError } from "./search";
import {
  addMatches,
  emptyResults,
  parsePatterns,
  positionOf,
  rowsOf,
  textParts,
  toggleFile,
  type Row,
} from "./searchResults";

/** Höhe einer Zeile in Pixeln; muss zu `.tree-row` passen. */
const ROW_HEIGHT = 22;
/** So viele Zeilen werden über und unter dem sichtbaren Ausschnitt mitgezeichnet. */
const OVERSCAN = 10;
/** So lange ruht die Eingabe, bevor die Suche beginnt (in Millisekunden). */
const INPUT_DELAY = 200;

export interface SearchViewProps {
  project: string;
  hidden: boolean;
  /** Steigt, wenn die Suche aufgerufen wird; dann erhält das Suchfeld die Tastatur. */
  focusRequest: number;
  /** Öffnet die Datei als Dateiansicht an der Fundstelle, mit `preview` als Vorschau-Tab. */
  onOpenFile: (request: { path: string; preview: boolean } & FilePosition) => void;
}

/** Wie weit die Suche zur aktuellen Eingabe ist. */
type Progress =
  | { state: "idle" | "running" | "done" | "limitReached" }
  | { state: "failed"; message: MessageKey; details: string };

/**
 * Die Ansicht Suche: Textsuche über die Dateien des Projekts. Gesucht wird
 * beim Tippen; die Treffer erscheinen nach Datei gruppiert, sobald der Kern
 * sie findet. Gezeichnet wird nur der sichtbare Ausschnitt der Trefferliste.
 */
export function SearchView({ project, hidden, focusRequest, onOpenFile }: SearchViewProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  /** Steigt mit der Eingabetaste: dieselbe Suche noch einmal. */
  const [submitted, setSubmitted] = useState(0);
  const [results, setResults] = useState(emptyResults);
  const [progress, setProgress] = useState<Progress>({ state: "idle" });
  /** Die angeklickte Zeile der Trefferliste. */
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusRequest === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  // Jede Änderung der Eingabe bricht die laufende Suche ab und beginnt eine neue.
  useEffect(() => {
    if (text === "") {
      setResults(emptyResults);
      setProgress({ state: "idle" });
      return;
    }
    let search: ReturnType<typeof searchText> | undefined;
    const timer = setTimeout(() => {
      // Die alte Trefferliste bleibt stehen, bis die neue Suche etwas liefert.
      let first = true;
      const query = {
        text,
        caseSensitive,
        wholeWord,
        regex,
        include: parsePatterns(include),
        exclude: parsePatterns(exclude),
      };
      setProgress({ state: "running" });
      const running = searchText(project, query, (files) => {
        setResults((current) => addMatches(first ? emptyResults : current, files));
        if (first) viewport.current?.scrollTo(0, 0);
        first = false;
      });
      search = running;
      running.done.then(
        (outcome) => {
          if (outcome.cancelled) return;
          if (first) setResults(emptyResults);
          first = false;
          setProgress({ state: outcome.limitReached ? "limitReached" : "done" });
        },
        (error: Partial<SearchError> | null) => {
          if (search !== running) return;
          setResults(emptyResults);
          setProgress({
            state: "failed",
            message:
              error?.kind === "invalidPattern"
                ? "search.invalidPattern"
                : error?.kind === "invalidGlob"
                  ? "search.invalidGlob"
                  : "search.failed",
            details: error?.details ?? String(error),
          });
        },
      );
    }, INPUT_DELAY);
    return () => {
      clearTimeout(timer);
      search?.cancel();
      search = undefined;
    };
  }, [project, text, caseSensitive, wholeWord, regex, include, exclude, submitted]);

  useEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => rowsOf(results), [results]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  function summary(): string {
    if (progress.state === "idle" || progress.state === "failed") return "";
    const matches = String(results.matchCount);
    if (progress.state === "limitReached") return t("search.limitReached", { matches });
    if (results.matchCount === 0) {
      return t(progress.state === "running" ? "search.running" : "search.none");
    }
    if (results.matchCount === 1) return t("search.summary.oneInOne");
    if (results.files.length === 1) return t("search.summary.manyInOne", { matches });
    return t("search.summary.manyInMany", { matches, files: String(results.files.length) });
  }

  function open(row: Row & { kind: "line" }, preview: boolean) {
    onOpenFile({ path: row.path, preview, ...positionOf(row.line) });
  }

  const toggle = (
    label: MessageKey,
    glyph: string,
    pressed: boolean,
    set: (value: boolean) => void,
  ) => (
    <button
      className={pressed ? "on" : ""}
      title={t(label)}
      aria-label={t(label)}
      aria-pressed={pressed}
      onClick={() => set(!pressed)}
    >
      {glyph}
    </button>
  );

  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") setSubmitted((count) => count + 1);
  };

  return (
    <div className="search" hidden={hidden}>
      <div className="search-form">
        <div className="search-field">
          <input
            ref={input}
            value={text}
            placeholder={t("search.input")}
            aria-label={t("search.input")}
            aria-invalid={progress.state === "failed"}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={submitOnEnter}
          />
          {toggle("search.caseSensitive", "Aa", caseSensitive, setCaseSensitive)}
          {toggle("search.wholeWord", "ab", wholeWord, setWholeWord)}
          {toggle("search.regex", ".*", regex, setRegex)}
        </div>
        <input
          value={include}
          placeholder={t("search.include")}
          aria-label={t("search.include")}
          spellCheck={false}
          onChange={(event) => setInclude(event.target.value)}
          onKeyDown={submitOnEnter}
        />
        <input
          value={exclude}
          placeholder={t("search.exclude")}
          aria-label={t("search.exclude")}
          spellCheck={false}
          onChange={(event) => setExclude(event.target.value)}
          onKeyDown={submitOnEnter}
        />
        {progress.state === "failed" ? (
          <div className="search-error" role="alert">
            {t(progress.message, { details: progress.details })}
          </div>
        ) : (
          <div className="search-summary" role="status">
            {summary()}
          </div>
        )}
      </div>
      <div
        className="tree"
        role="tree"
        ref={viewport}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}>
          {rows.slice(first, last).map((row) => {
            if (row.kind === "file") {
              const icon = fileIcon(row.name);
              return (
                <div
                  key={row.path}
                  role="treeitem"
                  aria-expanded={!row.collapsed}
                  className="tree-row"
                  title={row.path}
                  style={{ paddingLeft: 8 }}
                  onClick={() => setResults((current) => toggleFile(current, row.path))}
                >
                  <svg
                    className={row.collapsed ? "tree-twist" : "tree-twist open"}
                    viewBox="0 0 16 16"
                  >
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                  {icon ? (
                    <span className="tree-icon glyph" style={{ color: icon.color }}>
                      {icon.glyph}
                    </span>
                  ) : (
                    <svg className="tree-icon" viewBox="0 0 16 16">
                      <path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3" />
                    </svg>
                  )}
                  <span className="search-file">{row.name}</span>
                  <span className="search-folder">{row.folder}</span>
                  <span className="search-count">{row.count}</span>
                </div>
              );
            }
            const key = `${row.path}:${row.line.line}`;
            return (
              <div
                key={key}
                role="treeitem"
                aria-selected={key === selected}
                className={key === selected ? "tree-row search-line sel" : "tree-row search-line"}
                onClick={() => {
                  setSelected(key);
                  open(row, true);
                }}
                onDoubleClick={() => open(row, false)}
              >
                <span className="tree-name">
                  {textParts(row.line).map((part, index) =>
                    part.hit ? <mark key={index}>{part.text}</mark> : part.text,
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
