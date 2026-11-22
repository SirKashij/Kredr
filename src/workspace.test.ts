import { expect, test } from "vitest";
import {
  addProject,
  firstProject,
  projectOf,
  projectsOf,
  startPage,
  type WindowContent,
} from "./workspace";

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

const untitled = { id: "workspace-2", name: "Unbenannt" };

test("ein zweites Projekt macht aus dem Projektfenster den Workspace „Unbenannt“", () => {
  expect(addProject(single, "C:\\Projekte\\Web", untitled)).toEqual({
    kind: "added",
    content: {
      kind: "workspace",
      id: "workspace-2",
      name: "Unbenannt",
      projects: ["C:\\Projekte\\Kredr", "C:\\Projekte\\Web"],
    },
  });
});

test("ein Workspace bekommt das Projekt hinten angefügt und behält Kennung und Namen", () => {
  expect(addProject(workspace, "C:\\Projekte\\Notizen", untitled)).toEqual({
    kind: "added",
    content: {
      ...workspace,
      projects: ["C:\\Projekte\\Web", "C:\\Projekte\\Kern", "C:\\Projekte\\Notizen"],
    },
  });
});

test("ein schon enthaltenes Projekt wird abgelehnt, gleich in welcher Schreibweise", () => {
  const refused = { kind: "refused", reason: "alreadyContained" };

  expect(addProject(single, "c:\\projekte\\KREDR", untitled)).toEqual(refused);
  expect(addProject(workspace, "C:\\Projekte\\Kern\\", untitled)).toEqual(refused);
  expect(addProject(workspace, "C:/Projekte/Web", untitled)).toEqual(refused);
});

test("eine Datei gehört zu dem Projekt, in dessen Ordner sie liegt, sonst zu keinem", () => {
  const projects = ["C:\\Projekte\\Web", "C:\\Projekte\\Web\\Kern", "C:\\Projekte\\Webseite"];

  expect(projectOf(projects, "C:\\Projekte\\Web\\index.html")).toBe("C:\\Projekte\\Web");
  // Bei verschachtelten Projekten gewinnt das innere.
  expect(projectOf(projects, "c:/projekte/web/KERN/src/main.rs")).toBe("C:\\Projekte\\Web\\Kern");
  expect(projectOf(projects, "C:\\Projekte\\Webseite")).toBe("C:\\Projekte\\Webseite");
  expect(projectOf(projects, "C:\\Projekte\\Webs\\a.txt")).toBeNull();
  expect(projectOf(projects, "D:\\temp\\a.txt")).toBeNull();
});

test("ein leerer Workspace nimmt sein erstes Projekt auf", () => {
  const empty: WindowContent = { ...workspace, projects: [] };

  expect(addProject(empty, "C:\\Projekte\\Web", untitled)).toEqual({
    kind: "added",
    content: { ...empty, projects: ["C:\\Projekte\\Web"] },
  });
});
