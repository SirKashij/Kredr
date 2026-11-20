/**
 * Welche Ansichten es für eine Datei gibt: Dateiansicht, gerenderte
 * Markdown-Vorschau oder Bild. Entschieden wird allein nach der Endung.
 */

import type { TabContent } from "./arrangement";
import { fileName } from "./filePath";

/**
 * Die Bildformate, die Kredr anzeigt, mit ihrem Medientyp. Das Kern-Modul
 * Projektdateien liefert genau diese Formate (`IMAGE_EXTENSIONS`).
 */
const imageMimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const markdownExtensions = new Set(["md", "markdown", "mdown", "mkd"]);

/** Die Endung in Kleinbuchstaben ohne Punkt; leer, wenn die Datei keine hat. */
function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Der Medientyp einer Bilddatei; `null`, wenn Kredr die Datei nicht als Bild anzeigt. */
export function imageMimeType(path: string): string | null {
  return imageMimeTypes[extensionOf(path)] ?? null;
}

export function isMarkdown(path: string): boolean {
  return markdownExtensions.has(extensionOf(path));
}

/** Was ein Tab zeigt, wenn die Datei geöffnet wird: Bilder als Bild, alles andere als Dateiansicht. */
export function contentFor(path: string): TabContent {
  return { kind: imageMimeType(path) ? "image" : "file", path };
}

/**
 * Die andere Ansicht derselben Datei, zwischen der sich umschalten lässt:
 * Quelltext und Vorschau bei Markdown, Bild und Quelltext bei SVG. `null`,
 * wenn es nur eine Ansicht gibt.
 */
export function alternateView({ kind, path }: TabContent): TabContent | null {
  if (isMarkdown(path)) {
    if (kind === "file") return { kind: "markdown", path };
    if (kind === "markdown") return { kind: "file", path };
  }
  if (extensionOf(path) === "svg") {
    if (kind === "file") return { kind: "image", path };
    if (kind === "image") return { kind: "file", path };
  }
  return null;
}
