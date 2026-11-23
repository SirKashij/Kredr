import { expect, test } from "vitest";
import { indexFiles, recordOpened, searchFiles } from "./fileNameSearch";

function search(paths: string[], query: string, recent: string[] = [], limit?: number) {
  return searchFiles(indexFiles(paths), query, recent, limit);
}

test("ein Teil des Dateinamens findet die Datei, ohne auf Großschreibung zu achten", () => {
  const paths = ["README.md", "src/App.tsx", "src/main.rs"];

  expect(search(paths, "app")).toEqual(["src/App.tsx"]);
  expect(search(paths, "READ")).toEqual(["README.md"]);
});

test("die Buchstaben müssen nicht zusammenhängen, aber in dieser Reihenfolge vorkommen", () => {
  const paths = ["src/main.rs", "src/snirm.ts"];

  expect(search(paths, "mnrs")).toEqual(["src/main.rs"]);
});

test("auch Teile des Pfads zählen", () => {
  const paths = ["src/ui/App.tsx", "src/core/App.tsx", "docs/ui.md"];

  expect(search(paths, "ui/app")).toEqual(["src/ui/App.tsx"]);
  expect(search(paths, "coreapp")).toEqual(["src/core/App.tsx"]);
});

test("Leerzeichen trennen nur, und \\ gilt wie /", () => {
  const paths = ["src/ui/App.tsx"];

  expect(search(paths, " ui app ")).toEqual(["src/ui/App.tsx"]);
  expect(search(paths, "ui\\app")).toEqual(["src/ui/App.tsx"]);
});

test("ein Treffer im Dateinamen steht vor einem Treffer nur im Ordnernamen", () => {
  const paths = ["main/other.txt", "src/deep/folder/main.rs"];

  expect(search(paths, "main")).toEqual(["src/deep/folder/main.rs", "main/other.txt"]);
});

test("zusammenhängende Buchstaben stehen vor verstreuten", () => {
  const paths = ["src/someText.ts", "src/settings.ts"];

  expect(search(paths, "set")).toEqual(["src/settings.ts", "src/someText.ts"]);
});

test("Wortanfänge zählen mehr als Buchstaben mitten im Wort", () => {
  const paths = ["src/offset.ts", "src/fileState.ts", "src/file_store.ts"];

  expect(search(paths, "fs")).toEqual(["src/fileState.ts", "src/file_store.ts", "src/offset.ts"]);
});

test("bei gleicher Güte steht der kürzere Pfad vorn", () => {
  const paths = ["src/Application.tsx", "src/App.tsx"];

  expect(search(paths, "app")).toEqual(["src/App.tsx", "src/Application.tsx"]);
});

test("zuletzt geöffnete Dateien stehen oben, die jüngste zuerst", () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts"];

  expect(search(paths, "", ["c.ts", "b.ts"])).toEqual(["c.ts", "b.ts", "a.ts", "d.ts"]);
});

test("auch mit Eingabe stehen zuletzt geöffnete Treffer vor besseren übrigen", () => {
  const paths = ["docs/snappy.md", "src/App.tsx", "src/main.rs"];

  expect(search(paths, "app", ["src/main.rs", "docs/snappy.md"])).toEqual([
    "docs/snappy.md",
    "src/App.tsx",
  ]);
});

test("mehrere zuletzt geöffnete Treffer sind unter sich nach Güte sortiert", () => {
  const paths = ["src/App.tsx", "src/snappy.ts"];

  expect(search(paths, "app", ["src/snappy.ts", "src/App.tsx"])).toEqual([
    "src/App.tsx",
    "src/snappy.ts",
  ]);
});

test("eine zuletzt geöffnete Datei, die es nicht mehr gibt, erscheint nicht", () => {
  expect(search(["a.ts"], "", ["weg.ts"])).toEqual(["a.ts"]);
  expect(search(["a.ts"], "weg", ["weg.ts"])).toEqual([]);
});

test("die Trefferliste endet an der Obergrenze mit den besten Treffern", () => {
  const paths = ["x/app1.ts", "x/app2.ts", "app.ts", "x/app3.ts"];

  expect(search(paths, "app", [], 2)).toEqual(["app.ts", "x/app1.ts"]);
});

test("eine geöffnete Datei rückt an die Spitze der zuletzt geöffneten", () => {
  expect(recordOpened(["a.ts", "b.ts"], "c.ts")).toEqual(["c.ts", "a.ts", "b.ts"]);
  expect(recordOpened(["a.ts", "b.ts", "c.ts"], "b.ts")).toEqual(["b.ts", "a.ts", "c.ts"]);
  expect(recordOpened(["a.ts", "b.ts"], "c.ts", 2)).toEqual(["c.ts", "a.ts"]);
});

/**
 * Messlauf zum Akzeptanzkriterium „zehntausende Dateien ohne spürbare
 * Verzögerung“: Die Suche läuft bei jedem Tastendruck über alle Pfade. Die
 * gemessenen Zeiten stehen in der Ausgabe und lassen den Test nie scheitern,
 * denn sie hängen vom Rechner ab; geprüft werden nur die Ergebnisse.
 */
test("50 000 Dateien werden durchsucht; die Zeiten je Tastendruck stehen in der Ausgabe", () => {
  const areas = ["components", "services", "models", "utils", "views"];
  const names = ["UserProfile", "orderList", "payment_gateway", "index", "TerminalView"];
  const paths: string[] = [];
  for (let i = 0; i < 50_000; i++) {
    const area = areas[i % areas.length];
    const name = names[(i >> 3) % names.length];
    paths.push(`packages/pkg-${i % 400}/src/${area}/feature-${i % 97}/${name}${i}.tsx`);
  }
  const started = performance.now();
  const index = indexFiles(paths);
  const indexing = performance.now() - started;
  const recent = [paths[10], paths[20_000]];

  // Erst warmlaufen lassen, dann messen: so tippt auch ein Mensch mehrfach.
  const queries = ["", "u", "us", "user", "userprofile", "pkg12/term", "ordlist499", "zzzz"];
  for (const query of queries) searchFiles(index, query, recent);
  const timings = queries.map((query) => {
    const started = performance.now();
    const found = searchFiles(index, query, recent);
    return { query, ms: performance.now() - started, found: found.length };
  });

  console.log(
    `Index über 50 000 Pfade: ${indexing.toFixed(1)} ms; Suche: ` +
      timings.map(({ query, ms }) => `„${query}“ ${ms.toFixed(1)} ms`).join(", "),
  );
  expect(timings.find(({ query }) => query === "zzzz")!.found).toBe(0);
  expect(timings.find(({ query }) => query === "user")!.found).toBe(50);
});

test("gleiche Pfade in zwei Projekten bleiben über ihre Schlüssel unterscheidbar", () => {
  const index = indexFiles(["README.md", "README.md"], ["README.md", "C:/Kern/README.md"]);

  expect(searchFiles(index, "read")).toEqual(["README.md", "C:/Kern/README.md"]);
  // Zuletzt geöffnet ist eine Datei unter ihrem Schlüssel.
  expect(searchFiles(index, "read", ["C:/Kern/README.md"])).toEqual([
    "C:/Kern/README.md",
    "README.md",
  ]);
});
