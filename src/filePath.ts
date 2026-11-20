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
