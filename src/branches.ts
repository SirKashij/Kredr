/**
 * Die Branches eines Projekts, wie sie das Kern-Modul Versionskontrolle
 * liefert, und die Zeilen der Branch-Liste. Reine Daten und reine Funktionen;
 * die Aufrufe in den Kern stehen am Ende.
 */

import { invoke } from "@tauri-apps/api/core";
import type { VersionControlError } from "./versionControlState";

/** Ein Branch, zu dem sich wechseln lässt. */
export interface Branch {
  /** Der Name ohne das Remote davor. */
  name: string;
  /** Das Remote (in der Regel `origin`, also GitHub), wenn es den Branch nur dort gibt. */
  remote: string | null;
  /** Ob dies der aktuelle Branch ist. */
  current: boolean;
}

/** Eine Zeile der Branch-Liste: ein Branch zum Wechseln oder das Angebot, einen anzulegen. */
export type BranchRow = { kind: "branch"; branch: Branch } | { kind: "create"; name: string };

/** Wie die Liste einen Branch nennt: einen des Remotes mit dem Remote davor. */
export function branchTitle(branch: Branch): string {
  return branch.remote ? `${branch.remote}/${branch.name}` : branch.name;
}

/**
 * Die Zeilen zur Eingabe: alle Branches, deren Name die Eingabe enthält, in
 * der gelieferten Reihenfolge. Nennt die Eingabe keinen lokalen Branch, folgt
 * das Angebot, einen Branch dieses Namens anzulegen.
 */
export function branchRows(branches: readonly Branch[], query: string): BranchRow[] {
  const name = query.trim();
  const wanted = name.toLowerCase();
  const rows: BranchRow[] = branches
    .filter((branch) => branchTitle(branch).toLowerCase().includes(wanted))
    .map((branch) => ({ kind: "branch", branch }));
  if (name !== "" && !branches.some((branch) => !branch.remote && branch.name === name)) {
    rows.push({ kind: "create", name });
  }
  return rows;
}

/** Macht aus allem, woran ein Aufruf scheitern kann, eine Meldung der Versionskontrolle. */
function asError(reason: unknown): VersionControlError {
  if (typeof reason === "object" && reason !== null && "reason" in reason) {
    return reason as VersionControlError;
  }
  return { reason: "failed", details: String(reason) };
}

function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((reason) => Promise.reject(asError(reason)));
}

/** Die lokalen Branches und die des Remotes; scheitert mit einem `VersionControlError`. */
export function loadBranches(project: string): Promise<Branch[]> {
  return call("version_control_branches", { project });
}

/**
 * Führt die gewählte Zeile aus: wechselt zum Branch oder legt den neuen an
 * und wechselt dorthin. Scheitert mit einem `VersionControlError`; der Zustand
 * der Versionskontrolle folgt dem Wechsel von selbst.
 */
export function applyBranchRow(project: string, row: BranchRow): Promise<void> {
  return row.kind === "create"
    ? call("version_control_create_branch", { project, name: row.name })
    : call("version_control_switch_branch", { project, branch: row.branch });
}
