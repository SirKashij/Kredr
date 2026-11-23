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

  files.projectChanged("C:/projekt", { paths: ["src/ui", "README.md"], rescan: false });

  expect(reads).toEqual(["src/ui/b.ts", "README.md"]);
});

test("eine unter vollem Pfad weitergeführte Datei bleibt dieselbe und folgt ihrem Projekt", () => {
  const files = openFiles("src/a.ts");
  const file = files.find("src/a.ts");

  files.rekey("src/a.ts", "C:/projekt/src/a.ts");
  files.retain(["C:/projekt/src/a.ts"]);
  files.projectChanged("C:/projekt", { paths: ["src/a.ts"], rescan: false });

  expect(files.find("c:/PROJEKT/src/a.ts")).toBe(file);
  expect(files.find("src/a.ts")).toBeUndefined();
  expect(reads).toEqual(["src/a.ts"]);
});

test("eine Datei aus einem weiteren Projekt des Workspace folgt dessen Änderungen", () => {
  // Im Workspace benennt die Oberfläche Dateien relativ zum ersten Projekt;
  // eine Datei aus dem zweiten Projekt hat deshalb ihren vollen Pfad.
  const files = openFiles("C:/zweites/src/a.ts", "C:/zweites/README.md");

  files.projectChanged("c:\\ZWEITES\\", { paths: ["src"], rescan: false });

  expect(reads).toEqual(["C:/zweites/src/a.ts"]);
});

test("eine Datei aus einem weiteren Projekt bleibt bei Änderungen im ersten Projekt unberührt", () => {
  const files = openFiles("C:/zweites/src/a.ts");

  files.projectChanged("C:/projekt", { paths: ["src/a.ts"], rescan: true });

  expect(reads).toEqual([]);
});

test("das Projekt der Änderungen gilt auch in anderer Schreibweise", () => {
  const files = openFiles("README.md");

  files.projectChanged("c:/PROJEKT", { paths: ["README.md"], rescan: false });

  expect(reads).toEqual(["README.md"]);
});

test("Änderungen in einem anderen Projekt lassen die offenen Dateien unberührt", () => {
  const files = openFiles("src/a.ts", "README.md");

  files.projectChanged("C:/anderes", { paths: ["README.md"], rescan: false });
  files.projectChanged("C:/anderes", { paths: [], rescan: true });

  expect(reads).toEqual([]);
});

test("verlangt der Ereignisstrom, alles neu zu lesen, liest sich jede offene Datei neu", () => {
  const files = openFiles("src/a.ts", "src/ui/b.ts", "README.md");

  files.projectChanged("C:/projekt", { paths: [], rescan: true });

  expect(reads).toEqual(["src/a.ts", "src/ui/b.ts", "README.md"]);
});
