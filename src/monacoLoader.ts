type MonacoModule = typeof import("./monaco");

let loading: Promise<MonacoModule> | null = null;

/**
 * Lädt Monaco beim ersten Aufruf nach; bis dahin kostet es weder Startzeit
 * noch Arbeitsspeicher. Jede Ansicht, die Monaco braucht (Dateiansicht,
 * Diff), holt es sich hierüber und teilt sich Thema, Sprachen und Worker.
 */
export function loadMonaco(): Promise<MonacoModule> {
  loading ??= import("./monaco");
  return loading;
}
