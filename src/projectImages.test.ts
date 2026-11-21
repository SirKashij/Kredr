import { expect, test } from "vitest";
import { ProjectImages } from "./projectImages";

/** Zeigt zwei Einträge an, die der Kern nicht lesen muss, weil sie keine Bilder sind. */
async function shownImages() {
  const images = new ProjectImages("C:/projekt");
  await images.load("docs/skizze.txt");
  await images.load("notiz.txt");
  return images;
}

test("nur ein geändertes Bild wird beim nächsten Mal neu gelesen", async () => {
  const images = await shownImages();

  expect(images.projectChanged({ paths: ["src/a.ts"], rescan: false })).toBe(false);
  expect(images.projectChanged({ paths: ["docs"], rescan: false })).toBe(true);

  expect(images.peek("docs/skizze.txt")).toBeUndefined();
  expect(images.peek("notiz.txt")).toBeDefined();
});

test("verlangt der Ereignisstrom, alles neu zu lesen, wird jedes gezeigte Bild neu gelesen", async () => {
  const images = await shownImages();

  expect(images.projectChanged({ paths: [], rescan: true })).toBe(true);

  expect(images.peek("docs/skizze.txt")).toBeUndefined();
  expect(images.peek("notiz.txt")).toBeUndefined();
});
