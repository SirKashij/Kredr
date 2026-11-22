import { expect, test } from "vitest";
import { firstProject, projectsOf, startPage, type WindowContent } from "./workspace";

const single: WindowContent = { kind: "project", path: "C:\\Projekte\\Kredr" };
const workspace: WindowContent = {
  kind: "workspace",
  id: "workspace-1",
  name: "Unbenannt",
  projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Kern"],
};

test("die Startseite zeigt kein Projekt", () => {
  expect(projectsOf(startPage)).toEqual([]);
  expect(firstProject(startPage)).toBeNull();
});

test("ein Projektfenster zeigt genau sein Projekt", () => {
  expect(projectsOf(single)).toEqual(["C:\\Projekte\\Kredr"]);
  expect(firstProject(single)).toBe("C:\\Projekte\\Kredr");
});

test("ein Workspace zeigt seine Projekte in Reihenfolge, das erste zuerst", () => {
  expect(projectsOf(workspace)).toEqual(["C:\\Projekte\\Web", "C:\\Projekte\\Kern"]);
  expect(firstProject(workspace)).toBe("C:\\Projekte\\Web");
});

test("ein leerer Workspace hat kein erstes Projekt", () => {
  const empty: WindowContent = { ...workspace, projects: [] };

  expect(projectsOf(empty)).toEqual([]);
  expect(firstProject(empty)).toBeNull();
});
