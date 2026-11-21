import type { ReactNode } from "react";
import { fileName, parentOf } from "./filePath";
import { useT } from "./i18n/i18n";
import { statusLabels, statusLetter, type ChangedFile } from "./versionControlState";

/** Was eine Zeile von einer Datei wissen muss: eine Änderung oder eine Datei eines Commits. */
export type RowFile = Pick<ChangedFile, "path" | "originalPath" | "status">;

/**
 * Die Zeile einer geänderten Datei, in der Liste der Änderungen wie im
 * Verlauf: Name, Ordner und Statusbuchstabe. Ein Klick zeigt ihren Diff.
 * `children` sind die Knöpfe der Zeile; sie stehen vor dem Statusbuchstaben.
 */
export function ChangeRow({
  file,
  selected,
  onShow,
  children,
}: {
  file: RowFile;
  selected: boolean;
  onShow: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const status = t(statusLabels[file.status]);
  const moved = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  return (
    <div
      role="listitem"
      className={selected ? "change-row sel" : "change-row"}
      title={`${moved} · ${status}`}
      onClick={onShow}
    >
      <span className={`change-name git-${file.status}`}>{fileName(file.path)}</span>
      <span className="change-folder">{parentOf(file.path)}</span>
      {children}
      <span className={`change-status git-${file.status}`} aria-label={status}>
        {statusLetter(file.status)}
      </span>
    </div>
  );
}
