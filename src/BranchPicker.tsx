import { useEffect, useMemo, useState } from "react";
import { branchRows, branchTitle, loadBranches, type BranchRow } from "./branches";
import type { Branch } from "./branches";
import { useT } from "./i18n/i18n";
import { QuickPick } from "./QuickPick";
import { useVersionControlStore } from "./versionControl";
import { GitError } from "./VersionControlView";
import type { VersionControlError } from "./versionControlState";

/**
 * Die Branch-Liste: ein Eingabefeld über dem Fenster, das die lokalen und
 * die GitHub-Branches durchsucht. Eine gewählte Zeile wechselt dorthin oder
 * legt einen Branch mit dem eingegebenen Namen an. Scheitert das, bleibt die
 * Liste offen und zeigt die Meldung.
 */
export function BranchPicker({ project, onClose }: { project: string; onClose: () => void }) {
  const t = useT();
  const store = useVersionControlStore();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<VersionControlError | null>(null);
  const rows = useMemo(() => branchRows(branches ?? [], query), [branches, query]);

  useEffect(() => {
    let closed = false;
    loadBranches(project).then(
      (branches) => closed || setBranches(branches),
      (error: VersionControlError) => closed || setError(error),
    );
    return () => {
      closed = true;
    };
  }, [project]);

  function pick(row: BranchRow) {
    if (row.kind === "branch" && row.branch.current) return onClose();
    setError(null);
    // Solange Git wechselt oder etwas anderes läuft, löst eine weitere Auswahl nichts aus.
    store.changeBranch(row).then((changed) => {
      if (changed) onClose();
    }, setError);
  }

  return (
    <QuickPick
      placeholder={t("branches.placeholder")}
      query={query}
      onQuery={(query) => {
        setQuery(query);
        setError(null);
      }}
      rows={rows}
      rowKey={(row) => (row.kind === "create" ? "+" : branchTitle(row.branch))}
      renderRow={(row) =>
        row.kind === "create" ? (
          <span className="quick-open-name">{t("branches.create", { name: row.name })}</span>
        ) : (
          <>
            <span className="quick-open-name">{branchTitle(row.branch)}</span>
            <span className="quick-open-folder">
              {row.branch.current
                ? t("branches.current")
                : row.branch.remote
                  ? t("branches.remote")
                  : ""}
            </span>
          </>
        )
      }
      empty={branches ? t("branches.none") : error ? "" : t("branches.loading")}
      onPick={pick}
      onClose={onClose}
    >
      {error && <GitError error={error} />}
    </QuickPick>
  );
}
