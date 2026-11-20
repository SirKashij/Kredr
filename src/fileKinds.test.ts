import { expect, test } from "vitest";
import { alternateView, contentFor, imageMimeType, isMarkdown } from "./fileKinds";

test("gängige Bildformate öffnen sich als Bild", () => {
  for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.svg", "f.webp", "docs/g.PNG"]) {
    expect(contentFor(name), name).toEqual({ kind: "image", path: name });
  }
});

test("alles andere öffnet sich als Dateiansicht, auch Markdown", () => {
  for (const name of ["README.md", "src/App.tsx", "png", ".png", "bild.png.txt", "Makefile"]) {
    expect(contentFor(name), name).toEqual({ kind: "file", path: name });
  }
});

test("jedes Bildformat hat seinen festen Medientyp", () => {
  expect(imageMimeType("a.png")).toBe("image/png");
  expect(imageMimeType("a.jpg")).toBe("image/jpeg");
  expect(imageMimeType("a.JPEG")).toBe("image/jpeg");
  expect(imageMimeType("a.gif")).toBe("image/gif");
  expect(imageMimeType("a.svg")).toBe("image/svg+xml");
  expect(imageMimeType("a.webp")).toBe("image/webp");
  expect(imageMimeType("a.html")).toBeNull();
  expect(imageMimeType("a.svg.html")).toBeNull();
});

test("Markdown-Dateien erkennt man an der Endung", () => {
  expect(isMarkdown("README.md")).toBe(true);
  expect(isMarkdown("docs/Notes.MARKDOWN")).toBe(true);
  expect(isMarkdown("md")).toBe(false);
  expect(isMarkdown("readme.md.txt")).toBe(false);
});

test("eine Markdown-Datei schaltet zwischen Quelltext und Vorschau um", () => {
  expect(alternateView({ kind: "file", path: "README.md" })).toEqual({
    kind: "markdown",
    path: "README.md",
  });
  expect(alternateView({ kind: "markdown", path: "README.md" })).toEqual({
    kind: "file",
    path: "README.md",
  });
});

test("ein SVG-Bild schaltet zwischen Bild und Quelltext um", () => {
  expect(alternateView({ kind: "image", path: "logo.svg" })).toEqual({
    kind: "file",
    path: "logo.svg",
  });
  expect(alternateView({ kind: "file", path: "logo.svg" })).toEqual({
    kind: "image",
    path: "logo.svg",
  });
});

test("andere Dateien haben nur eine Ansicht", () => {
  expect(alternateView({ kind: "file", path: "src/App.tsx" })).toBeNull();
  expect(alternateView({ kind: "image", path: "foto.png" })).toBeNull();
});
