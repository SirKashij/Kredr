import { invoke } from "@tauri-apps/api/core";
import { imageMimeType } from "./fileKinds";
import type { ProjectChanges } from "./projectFiles";

/** Warum ein Bild nicht angezeigt werden kann, wie es das Kern-Modul Projektdateien meldet. */
export type ImageFailure =
  | { kind: "notAnImage" }
  | { kind: "tooLarge"; size: number }
  | { kind: "missing" }
  | { kind: "failed"; details: string };

/** Ein gelesenes Bild als Adresse für ein `<img>`, oder der Grund, warum es fehlt. */
export type LoadedImage = { url: string } | { failure: ImageFailure };

/**
 * Die Bilder, die eine Ansicht gerade zeigt. Jedes wird einmal über das
 * Kern-Modul Projektdateien gelesen und liegt dann als `blob:`-Adresse mit
 * festem Bild-Medientyp im Speicher des Fensters. So braucht das Fenster
 * kein Recht, Dateien selbst von der Festplatte zu laden, und ein `<img>`
 * führt auch in einem SVG keine Skripte aus.
 */
export class ProjectImages {
  private readonly loading = new Map<string, Promise<LoadedImage>>();
  private readonly loaded = new Map<string, LoadedImage>();

  constructor(private readonly project: string) {}

  /** Das Bild, wenn es schon gelesen ist. */
  peek(path: string): LoadedImage | undefined {
    return this.loaded.get(path.toLowerCase());
  }

  /** Liest das Bild; `path` in der Schreibweise der Oberfläche (siehe `toProjectPath`). */
  load(path: string): Promise<LoadedImage> {
    const key = path.toLowerCase();
    let image = this.loading.get(key);
    if (!image) {
      image = this.read(path);
      this.loading.set(key, image);
      const reading = image;
      image.then((result) => {
        // Inzwischen geändert oder nicht mehr gebraucht: Die Adresse zeigt niemand mehr an.
        if (this.loading.get(key) === reading) this.loaded.set(key, result);
        else release(result);
      });
    }
    return image;
  }

  /**
   * Der Ereignisstrom der Projektdateien: Geänderte Bilder werden beim
   * nächsten `load` neu gelesen. Liefert, ob ein gezeigtes Bild betroffen ist.
   */
  projectChanged(changes: ProjectChanges): boolean {
    const paths = changes.paths.map((path) => path.toLowerCase());
    let affected = false;
    for (const key of [...this.loading.keys()]) {
      // Auch ein umbenannter oder gelöschter Ordner über dem Bild betrifft es.
      const hit = paths.some((path) => key === path || key.startsWith(`${path}/`));
      if (!changes.rescan && !hit) continue;
      this.forget(key);
      affected = true;
    }
    return affected;
  }

  /** Gibt alle Bilder frei, auch die, die gerade noch gelesen werden. */
  clear() {
    for (const key of [...this.loading.keys()]) this.forget(key);
  }

  private forget(key: string) {
    const result = this.loaded.get(key);
    if (result) release(result);
    this.loaded.delete(key);
    this.loading.delete(key);
  }

  private async read(path: string): Promise<LoadedImage> {
    const type = imageMimeType(path);
    if (!type) return { failure: { kind: "notAnImage" } };
    try {
      const { project } = this;
      const bytes = await invoke<ArrayBuffer>("project_files_read_image", { project, path });
      return { url: URL.createObjectURL(new Blob([bytes], { type })) };
    } catch (reason) {
      return { failure: asFailure(reason) };
    }
  }
}

function release(image: LoadedImage) {
  if ("url" in image) URL.revokeObjectURL(image.url);
}

function asFailure(reason: unknown): ImageFailure {
  if (typeof reason === "object" && reason !== null && "kind" in reason) {
    return reason as ImageFailure;
  }
  return { kind: "failed", details: String(reason) };
}
