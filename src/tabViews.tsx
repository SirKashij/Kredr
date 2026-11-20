import { lazy, Suspense } from "react";
import { holdsFileText, type Arrangement, type Tab, type TabContent } from "./arrangement";
import { fileIcon } from "./fileIcons";
import { fileName } from "./filePath";
import { FileView, useOpenFiles } from "./FileView";
import { useT } from "./i18n/i18n";
import { ImageView } from "./ImageView";
import type { OpenFiles } from "./openFiles";
import { VersionControlTab } from "./VersionControlTab";
import { ViewSwitch } from "./ViewSwitch";

/**
 * Darstellung der Tabs, die kein Terminal sind. Eine neue Tab-Art braucht
 * hier je einen Fall in `ContentTabFace` (Symbol und Beschriftung in der
 * Tab-Leiste) und in `ContentTabBody` (die Fläche darunter).
 */

// Die Markdown-Vorschau bringt Parser und Prüfung mit; beides lädt erst mit der ersten Vorschau.
const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);

/** Ein Tab mit eigenem Inhalt. */
export type ContentTab = Tab & { content: TabContent };

/** Symbol und Beschriftung eines Tabs in der Tab-Leiste. */
export function ContentTabFace({ tab, files }: { tab: ContentTab; files: OpenFiles }) {
  useOpenFiles(files);
  const t = useT();
  const { content } = tab;
  switch (content.kind) {
    case "versionControl":
      return (
        <>
          <span className="tab-icon">±</span>
          <span className="tab-label">{t("activity.versionControl")}</span>
        </>
      );
    case "file":
    case "markdown":
    case "image": {
      const name = fileName(content.path);
      const icon = fileIcon(name);
      // Ein Bild hat keinen Text und damit weder ungespeicherte Änderungen noch einen Zustand.
      const state = holdsFileText(content) ? files.find(content.path)?.state : undefined;
      const classes = ["tab-label", tab.preview && "preview", state?.deleted && "deleted"];
      return (
        <>
          {icon ? (
            <span className="tab-icon glyph" style={{ color: icon.color }}>
              {icon.glyph}
            </span>
          ) : (
            <svg className="tab-icon file" viewBox="0 0 16 16">
              <path d="M9.5 1.5h-6v13h9v-10zM9.5 1.5v3h3" />
            </svg>
          )}
          <span className={classes.filter(Boolean).join(" ")} title={content.path}>
            {content.kind === "markdown" ? t("markdown.tabLabel", { name }) : name}
          </span>
          {state?.dirty && <span className="tab-dirty" />}
        </>
      );
    }
  }
}

/** Die Fläche eines sichtbaren Tabs unter der Tab-Leiste. */
export function ContentTabBody({
  tab,
  files,
  project,
  focused,
  focusRequest,
  onKeep,
  update,
  onOpenFile,
}: {
  tab: ContentTab;
  files: OpenFiles;
  /** Der Ordner des Projekts. */
  project: string;
  focused: boolean;
  focusRequest: number;
  /** Macht aus dem Vorschau-Tab einen dauerhaften. */
  onKeep: () => void;
  /** Wendet eine Operation auf die Aufteilung an. */
  update: (change: (arrangement: Arrangement) => Arrangement) => void;
  /** Öffnet eine Datei dauerhaft als Tab. */
  onOpenFile: (path: string) => void;
}) {
  const { content } = tab;
  switch (content.kind) {
    case "versionControl":
      return <VersionControlTab focused={focused} focusRequest={focusRequest} />;
    case "file":
      return (
        <ViewSwitch tab={tab} update={update}>
          <FileView
            // Jede Datei bekommt ihre eigene Ansicht, auch wenn die Vorschau den Tab weiterverwendet.
            key={content.path}
            files={files}
            project={project}
            path={content.path}
            focused={focused}
            focusRequest={focusRequest}
            onEdited={() => tab.preview && onKeep()}
          />
        </ViewSwitch>
      );
    case "markdown":
      return (
        <ViewSwitch tab={tab} update={update}>
          <Suspense fallback={<div className="file-view" />}>
            <MarkdownPreview
              key={content.path}
              files={files}
              project={project}
              path={content.path}
              focused={focused}
              focusRequest={focusRequest}
              onOpenFile={onOpenFile}
            />
          </Suspense>
        </ViewSwitch>
      );
    case "image":
      return (
        <ViewSwitch tab={tab} update={update}>
          <ImageView
            key={content.path}
            project={project}
            path={content.path}
            focused={focused}
            focusRequest={focusRequest}
          />
        </ViewSwitch>
      );
  }
}
