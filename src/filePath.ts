/**
 * Bringt einen Dateipfad in die Form, in der die Oberfläche Dateien benennt:
 * relativ zum Projektordner und mit `/` getrennt (wie im Explorer und im
 * Ereignisstrom der Projektdateien). Eine Datei außerhalb des Projekts behält
 * ihren vollen Pfad.
 */
export function toProjectPath(project: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const root = project.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  // Windows unterscheidet bei Pfaden keine Groß- und Kleinschreibung.
  if (normalized.toLowerCase().startsWith(root.toLowerCase())) return normalized.slice(root.length);
  return normalized.replace(/^(\.\/)+/, "");
}

/** Der Name der Datei ohne ihre Ordner. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Ob der Pfad voll ist, also auf eine Datei außerhalb des Projekts zeigt. */
export function isOutsideProject(path: string): boolean {
  return /^([A-Za-z]:)?\//.test(path);
}

/** Der volle Pfad in der Schreibweise von Windows, wie ihn andere Programme erwarten. */
export function fullPath(project: string, path: string): string {
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
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && externalExtensions.has(name.slice(dot + 1).toLowerCase());
}
