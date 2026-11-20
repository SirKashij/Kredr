import { expect, test } from "vitest";
import { fileName, toProjectPath } from "./filePath";

const project = "C:\\Users\\kevin\\Kredr";

test("ein voller Pfad im Projekt wird projekt-relativ mit Schrägstrichen", () => {
  expect(toProjectPath(project, "C:\\Users\\kevin\\Kredr\\src\\ui\\App.tsx")).toBe(
    "src/ui/App.tsx",
  );
  expect(toProjectPath(project, "C:/Users/kevin/Kredr/README.md")).toBe("README.md");
});

test("Groß- und Kleinschreibung des Projektordners spielt keine Rolle", () => {
  expect(toProjectPath(project, "c:\\users\\KEVIN\\kredr\\src\\App.tsx")).toBe("src/App.tsx");
  expect(toProjectPath(project + "\\", "C:\\Users\\kevin\\Kredr\\a.txt")).toBe("a.txt");
});

test("ein voller Pfad außerhalb des Projekts bleibt ein voller Pfad", () => {
  expect(toProjectPath(project, "C:\\Users\\kevin\\Kredr-wt\\notes\\a.md")).toBe(
    "C:/Users/kevin/Kredr-wt/notes/a.md",
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
