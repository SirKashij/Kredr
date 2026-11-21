import { expect, test } from "vitest";
import { fileName, fullPath, isOutsideProject, opensExternally, toProjectPath } from "./filePath";

const project = "C:\\Users\\test\\Kredr";

test("ein voller Pfad im Projekt wird projekt-relativ mit Schrägstrichen", () => {
  expect(toProjectPath(project, "C:\\Users\\test\\Kredr\\src\\ui\\App.tsx")).toBe("src/ui/App.tsx");
  expect(toProjectPath(project, "C:/Users/test/Kredr/README.md")).toBe("README.md");
});

test("Groß- und Kleinschreibung des Projektordners spielt keine Rolle", () => {
  expect(toProjectPath(project, "c:\\users\\TEST\\kredr\\src\\App.tsx")).toBe("src/App.tsx");
  expect(toProjectPath(project + "\\", "C:\\Users\\test\\Kredr\\a.txt")).toBe("a.txt");
});

test("ein voller Pfad außerhalb des Projekts bleibt ein voller Pfad", () => {
  expect(toProjectPath(project, "C:\\Users\\test\\Kredr-wt\\notes\\a.md")).toBe(
    "C:/Users/test/Kredr-wt/notes/a.md",
  );
  expect(toProjectPath(project, "D:\\anderes\\b.txt")).toBe("D:/anderes/b.txt");
  expect(toProjectPath(project, "\\\\server\\freigabe\\c.txt")).toBe("//server/freigabe/c.txt");
});

test("ein projekt-relativer Pfad bleibt, wie er ist", () => {
  expect(toProjectPath(project, "src/App.tsx")).toBe("src/App.tsx");
  expect(toProjectPath(project, "src\\App.tsx")).toBe("src/App.tsx");
  expect(toProjectPath(project, "./src/App.tsx")).toBe("src/App.tsx");
});

test("der Dateiname ist der letzte Teil des Pfads", () => {
  expect(fileName("src/ui/App.tsx")).toBe("App.tsx");
  expect(fileName("README.md")).toBe("README.md");
  expect(fileName("C:/anderes/b.txt")).toBe("b.txt");
});

test("der volle Pfad steht in der Schreibweise von Windows", () => {
  expect(fullPath(project, "src/ui/App.tsx")).toBe("C:\\Users\\test\\Kredr\\src\\ui\\App.tsx");
  expect(fullPath(project + "\\", "a.txt")).toBe("C:\\Users\\test\\Kredr\\a.txt");
  expect(fullPath(project, "D:/anderes/b.txt")).toBe("D:\\anderes\\b.txt");
  expect(fullPath(project, "//server/freigabe/c.txt")).toBe("\\\\server\\freigabe\\c.txt");
});

test("nur volle Pfade liegen außerhalb des Projekts", () => {
  expect(isOutsideProject("D:/anderes/b.txt")).toBe(true);
  expect(isOutsideProject("//server/freigabe/c.txt")).toBe(true);
  expect(isOutsideProject("src/App.tsx")).toBe(false);
});

test("PDFs und Office-Dateien öffnen im Windows-Standardprogramm", () => {
  expect(opensExternally("docs/Handbuch.PDF")).toBe(true);
  expect(opensExternally("Angebot.docx")).toBe(true);
  expect(opensExternally("zahlen.xlsx")).toBe(true);
  expect(opensExternally("src/App.tsx")).toBe(false);
  expect(opensExternally("README")).toBe(false);
  expect(opensExternally("ordner.pdf/notiz.txt")).toBe(false);
});
