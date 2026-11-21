import { beforeEach, expect, test, vi } from "vitest";
import { OpenFiles } from "./openFiles";

/** Welche Dateien der Kern lesen sollte, in dieser Reihenfolge. */
const reads: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: { path: string }) => {
    if (command === "project_files_read") reads.push(args.path);
    return { kind: "missing" };
  },
}));

beforeEach(() => {
  reads.length = 0;
});

function openFiles(...paths: string[]) {
  const files = new OpenFiles();
  for (const path of paths) files.get("C:/projekt", path);
  reads.length = 0;
  return files;
}

test("eine geänderte Datei und alles unter einem geänderten Ordner liest sich neu", () => {
  const files = openFiles("src/a.ts", "src/ui/b.ts", "README.md");

  files.projectChanged({ paths: ["src/ui", "README.md"], rescan: false });

  expect(reads).toEqual(["src/ui/b.ts", "README.md"]);
});

test("verlangt der Ereignisstrom, alles neu zu lesen, liest sich jede offene Datei neu", () => {
  const files = openFiles("src/a.ts", "src/ui/b.ts", "README.md");

  files.projectChanged({ paths: [], rescan: true });

  expect(reads).toEqual(["src/a.ts", "src/ui/b.ts", "README.md"]);
});
