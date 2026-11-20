import { useEffect, useRef, useState } from "react";
import { fileName, fullPath } from "./filePath";
import { useT } from "./i18n/i18n";
import { openFileExternally } from "./openExternally";
import { watchProjectFiles } from "./projectFiles";
import { ProjectImages, type LoadedImage } from "./projectImages";
import { useViewFocus } from "./useViewFocus";
import "./preview.css";

/**
 * Eine Bilddatei als Bild: in die Fläche des Tabs eingepasst, nie größer als
 * das Original. Ändert sich die Datei, wird sie neu gelesen.
 */
export function ImageView({
  project,
  path,
  focused,
  focusRequest,
}: {
  project: string;
  path: string;
  focused: boolean;
  focusRequest: number;
}) {
  const t = useT();
  const view = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<LoadedImage | null>(null);
  /** Die Datei wurde gelesen, ihr Inhalt ist aber kein darstellbares Bild. */
  const [broken, setBroken] = useState(false);
  /** Breite und Höhe des Originals in Pixeln. */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useViewFocus(view, focused, focusRequest);

  useEffect(() => {
    const images = new ProjectImages(project);
    let current = true;
    const show = () =>
      images.load(path).then((loaded) => {
        if (!current) return;
        setBroken(false);
        setImage(loaded);
      });
    show();
    const unwatch = watchProjectFiles(project, (changes) => {
      if (images.projectChanged(changes)) show();
    });
    return () => {
      current = false;
      unwatch();
      images.clear();
    };
  }, [project, path]);

  const name = fileName(path);
  const failure = image && "failure" in image ? image.failure : null;
  const notice = broken
    ? t("image.broken", { name })
    : failure?.kind === "tooLarge"
      ? t("image.tooLarge", { name, size: (failure.size / (1024 * 1024)).toFixed(0) })
      : failure?.kind === "missing"
        ? t("file.missing", { name })
        : failure?.kind === "failed"
          ? t("file.readFailed", { name, details: failure.details })
          : failure
            ? t("image.broken", { name })
            : null;

  return (
    <div className="image-view" ref={view} tabIndex={-1}>
      {notice ? (
        <div className="file-notice">
          <p>{notice}</p>
          {failure?.kind !== "missing" && (
            <button
              className="btn ghost"
              onClick={() => openFileExternally({ path: fullPath(project, path) })}
            >
              {t("file.openExternally")}
            </button>
          )}
        </div>
      ) : (
        image &&
        "url" in image && (
          <>
            <img
              src={image.url}
              alt={name}
              draggable={false}
              onLoad={({ currentTarget }) =>
                setSize({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })
              }
              onError={() => setBroken(true)}
            />
            {size && (
              <span className="image-size">
                {size.width} × {size.height}
              </span>
            )}
          </>
        )
      )}
    </div>
  );
}
