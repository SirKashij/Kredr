import { expect, test } from "vitest";
import { projectName } from "./project";

test("der Projektname ist der Name des Ordners", () => {
  expect(projectName("C:\\Users\\kevin\\Kredr")).toBe("Kredr");
  expect(projectName("C:/Users/kevin/Mein Projekt")).toBe("Mein Projekt");
});

test("ein abschließender Trenner ändert den Projektnamen nicht", () => {
  expect(projectName("C:\\Users\\kevin\\Kredr\\")).toBe("Kredr");
});

test("ein Laufwerk als Projekt heißt wie das Laufwerk", () => {
  expect(projectName("D:\\")).toBe("D:");
});
