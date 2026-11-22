import { pathKey } from "./filePath";

/**
 * Ein Beobachter je Projekt des Fensterinhalts. Kommt ein Projekt hinzu,
 * startet sein Beobachter; fällt eines weg, endet seiner. Die übrigen laufen
 * ungestört weiter, auch wenn sich nur die Reihenfolge oder die Schreibweise
 * eines Ordners ändert.
 */
export class ProjectWatches {
  /** Je Projekt, erkannt an seinem Pfadschlüssel, wie die Beobachtung endet. */
  private readonly running = new Map<string, () => void>();

  /** `start` beginnt die Beobachtung eines Projekts; sein Rückgabewert beendet sie. */
  constructor(private readonly start: (project: string) => () => void) {}

  /** Beobachtet genau diese Projekte. */
  follow(projects: readonly string[]) {
    const wanted = new Map(projects.map((project) => [pathKey(project), project]));
    for (const [key, stop] of this.running) {
      if (wanted.has(key)) continue;
      this.running.delete(key);
      stop();
    }
    for (const [key, project] of wanted) {
      if (!this.running.has(key)) this.running.set(key, this.start(project));
    }
  }
}
