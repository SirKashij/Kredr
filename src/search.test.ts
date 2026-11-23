import { expect, test } from "vitest";
import { searchProjects, type SearchOutcome, type TextQuery, type TextSearch } from "./search";
import type { FileMatches } from "./searchResults";

const query: TextQuery = {
  text: "x",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: [],
  exclude: [],
};

/** Eine Suche je Projekt, die der Test von Hand liefern und beenden lässt. */
function fakeCore() {
  const runs: {
    project: string;
    deliver: (files: FileMatches[]) => void;
    finish: (outcome?: Partial<SearchOutcome>) => void;
    cancelled: boolean;
  }[] = [];
  const searchOne = (
    project: string,
    _query: TextQuery,
    onMatches: (files: FileMatches[]) => void,
  ): TextSearch => {
    let finish!: (outcome: SearchOutcome) => void;
    const done = new Promise<SearchOutcome>((resolve) => (finish = resolve));
    const run = {
      project,
      cancelled: false,
      deliver: (files: FileMatches[]) => {
        if (!run.cancelled) onMatches(files);
      },
      finish: (outcome: Partial<SearchOutcome> = {}) =>
        finish({ cancelled: run.cancelled, limitReached: false, ...outcome }),
    };
    runs.push(run);
    return {
      done,
      cancel: () => {
        run.cancelled = true;
        finish({ cancelled: true, limitReached: false });
      },
    };
  };
  return { runs, searchOne };
}

const file = (path: string): FileMatches => ({ path, lines: [] });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("die Projekte werden nacheinander in der Reihenfolge des Workspace durchsucht", async () => {
  const core = fakeCore();
  const found: string[] = [];

  const search = searchProjects(
    ["C:/web", "C:/kern"],
    query,
    (project, files) => found.push(...files.map((match) => `${project}: ${match.path}`)),
    core.searchOne,
  );
  // Das zweite Projekt beginnt erst, wenn das erste fertig ist.
  expect(core.runs.map((run) => run.project)).toEqual(["C:/web"]);
  core.runs[0].deliver([file("index.ts")]);
  core.runs[0].finish({ limitReached: true });
  await settled();
  core.runs[1].deliver([file("lib.rs")]);
  core.runs[1].finish();

  // Erreicht ein Projekt die Obergrenze, gilt sie für die ganze Suche.
  expect(await search.done).toEqual({ cancelled: false, limitReached: true });
  expect(found).toEqual(["C:/web: index.ts", "C:/kern: lib.rs"]);
});

test("nach dem Abbrechen kommt nichts mehr an und kein weiteres Projekt beginnt", async () => {
  const core = fakeCore();
  const found: string[] = [];
  const search = searchProjects(
    ["C:/web", "C:/kern", "C:/doku"],
    query,
    (_project, files) => found.push(...files.map((match) => match.path)),
    core.searchOne,
  );
  core.runs[0].finish();
  await settled();

  search.cancel();
  core.runs[1].deliver([file("spät.rs")]);
  await settled();

  expect(await search.done).toMatchObject({ cancelled: true });
  expect(found).toEqual([]);
  expect(core.runs.map((run) => run.project)).toEqual(["C:/web", "C:/kern"]);
});

test("bricht der Kern ein Projekt ab, endet die ganze Suche", async () => {
  const core = fakeCore();
  const search = searchProjects(["C:/web", "C:/kern"], query, () => {}, core.searchOne);

  core.runs[0].finish({ cancelled: true });

  expect(await search.done).toMatchObject({ cancelled: true });
  expect(core.runs).toHaveLength(1);
});
