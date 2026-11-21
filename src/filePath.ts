/**
 * Bringt einen Dateipfad in die Form, in der die Oberfläche Dateien benennt:
 * relativ zum Projektordner und mit `/` getrennt (wie im Explorer und im
 * Ereignisstrom der Projektdateien). Eine Datei außerhalb des Projekts behält
 * ihren vollen Pfad.
 */
export function toProjectPath(project: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const root = project.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  if (pathKey(normalized).startsWith(pathKey(root))) return normalized.slice(root.length);
  return normalized.replace(/^(\.\/)+/, "");
}

/**
 * Woran ein Pfad wiedererkannt wird: Windows unterscheidet bei Pfaden keine
 * Groß- und Kleinschreibung. Die eine Stelle der Oberfläche, die das weiß.
 */
export function pathKey(path: string): string {
  return path.toLowerCase();
}

/** Ob beide Pfade dieselbe Datei oder denselben Ordner meinen. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Der Name der Datei ohne ihre Ordner. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Der Ordner, in dem die Datei oder der Ordner liegt; leer für einen Eintrag direkt im Projektordner. */
export function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** Die Endung in Kleinbuchstaben ohne Punkt; leer, wenn die Datei keine hat (auch bei `.env`). */
export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Ob der Pfad voll ist, also auf eine Datei außerhalb des Projekts zeigt. */
export function isOutsideProject(path: string): boolean {
  return /^([A-Za-z]:)?\//.test(path);
}

/**
 * Der volle Pfad in der Schreibweise von Windows, wie ihn andere Programme
 * erwarten; ein leerer Pfad meint den Projektordner selbst.
 */
export function fullPath(project: string, path: string): string {
  if (path === "") return project;
  const full = isOutsideProject(path) ? path : `${project.replace(/[\\/]+$/, "")}/${path}`;
  return full.replaceAll("/", "\\");
}

const externalExtensions = new Set(
  "pdf doc docx docm dot dotx rtf odt xls xlsx xlsm xlsb ods ppt pptx pps ppsx odp vsd vsdx".split(
    " ",
  ),
);

/** Ob die Datei statt in der Dateiansicht im Windows-Standardprogramm öffnet: PDFs und Office-Dateien. */
export function opensExternally(path: string): boolean {
  return externalExtensions.has(extensionOf(path));
}
