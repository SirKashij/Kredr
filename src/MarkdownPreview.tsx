import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { FileView, useOpenFiles } from "./FileView";
import { useT } from "./i18n/i18n";
import { codeLanguage, headingSlug, renderMarkdown, resolveImage, resolveLink } from "./markdown";
import { loadMonaco } from "./monacoLoader";
import type { OpenFiles } from "./openFiles";
import { openUrl } from "./openExternally";
import { watchProjectFiles } from "./projectFiles";
import { ProjectImages } from "./projectImages";
import { useViewFocus } from "./useViewFocus";
import "./preview.css";

/** So lange nach der letzten Eingabe im Quelltext wartet die Vorschau, bevor sie neu rendert. */
const RENDER_DELAY = 150;
/** Mehr gefärbte Codeblöcke merkt sich eine Vorschau nicht. */
const MAX_COLORED_BLOCKS = 200;

/**
 * Die gerenderte Vorschau der Markdown-Datei `path`. Sie zeigt denselben Text
 * wie die Dateiansicht der Datei, samt ungespeicherter Änderungen, und folgt
 * jeder Änderung: der Eingabe im Quelltext daneben ebenso wie einem Agenten,
 * der die Datei schreibt.
 */
export function MarkdownPreview({
  files,
  project,
  path,
  focused,
  focusRequest,
  onOpenFile,
}: {
  files: OpenFiles;
  project: string;
  path: string;
  focused: boolean;
  focusRequest: number;
  /** Öffnet die Datei, auf die ein Link der Vorschau zeigt. */
  onOpenFile: (path: string) => void;
}) {
  const t = useT();
  useOpenFiles(files);
  const file = files.get(project, path);
  const { state, model } = file;
  const view = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [images] = useState(() => new ProjectImages(project));
  /** Gefärbte Codeblöcke nach Sprache und Text, damit Neurendern nicht flackert. */
  const [colored] = useState(() => new Map<string, string>());
  /** Steigt, wenn sich der Text in Monaco oder ein gezeigtes Bild geändert hat. */
  const [revision, setRevision] = useState(0);
  useViewFocus(view, focused, focusRequest);

  // Jede Eingabe im Quelltext rendert die Vorschau neu, sobald kurz Ruhe ist.
  useEffect(() => {
    if (!model) return;
    let timer: number | undefined;
    const listener = model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRevision((count) => count + 1), RENDER_DELAY);
    });
    return () => {
      window.clearTimeout(timer);
      listener.dispose();
    };
  }, [model]);

  // Ein geändertes Bild wird neu gelesen.
  useEffect(
    () =>
      watchProjectFiles(project, (changes) => {
        if (images.projectChanged(changes)) setRevision((count) => count + 1);
      }),
    [project, images],
  );
  useEffect(() => () => images.clear(), [images]);

  const showsText = state.phase === "text";
  const html = useMemo(
    () => (showsText ? renderMarkdown(model?.getValue() ?? state.disk ?? "") : ""),
    // `revision` steht für den Text in Monaco, der sich ohne neuen Zustand ändert.
    [showsText, model, state.disk, revision],
  );

  useEffect(() => {
    const container = content.current;
    if (!container) return;
    let current = true;
    // Die Stelle, an der gelesen wird, bleibt beim Neurendern stehen.
    const scrolled = view.current?.scrollTop ?? 0;
    // `html` kommt aus `renderMarkdown` und enthält nur geprüfte Elemente.
    container.innerHTML = html;

    for (const image of container.querySelectorAll("img")) {
      const source = resolveImage(path, image.getAttribute("data-src") ?? "");
      image.removeAttribute("data-src");
      image.draggable = false;
      if (source.kind === "inline") {
        image.src = source.url;
      } else if (source.kind === "local") {
        const show = (loaded: Awaited<ReturnType<ProjectImages["load"]>>) => {
          if ("url" in loaded) image.src = loaded.url;
          else image.classList.add("unavailable");
        };
        const known = images.peek(source.path);
        if (known) show(known);
        else images.load(source.path).then((loaded) => current && show(loaded));
      } else if (source.kind === "remote") {
        // Bilder aus dem Internet lädt Kredr nicht; an ihrer Stelle steht ein Link dorthin.
        const link = document.createElement("a");
        link.className = "remote-image";
        link.setAttribute("data-href", source.url);
        link.setAttribute("role", "link");
        link.tabIndex = 0;
        link.title = t("markdown.remoteImage");
        link.textContent = image.alt || source.url;
        image.replaceWith(link);
      } else {
        image.classList.add("unavailable");
      }
    }

    const uncolored: { block: Element; name: string; text: string; key: string }[] = [];
    for (const block of container.querySelectorAll("pre[data-lang] > code")) {
      const name = block.parentElement!.getAttribute("data-lang")!;
      const text = (block.textContent ?? "").replace(/\n$/, "");
      const key = `${name}\n${text}`;
      const known = colored.get(key);
      if (known === undefined) uncolored.push({ block, name, text, key });
      else block.innerHTML = known;
    }
    if (uncolored.length > 0) {
      loadMonaco().then(async ({ monaco }) => {
        for (const { block, name, text, key } of uncolored) {
          const language = codeLanguage(monaco.languages.getLanguages(), name);
          if (!language) continue;
          // Monaco liefert die Zeilen als eingefärbte, maskierte Textstücke.
          const colors = await monaco.editor.colorize(text, language, {});
          if (colored.size >= MAX_COLORED_BLOCKS) colored.clear();
          colored.set(key, colors);
          if (current) block.innerHTML = colors;
        }
      });
    }

    if (view.current) view.current.scrollTop = scrolled;
    return () => {
      current = false;
    };
  }, [html, path, images, colored, t]);

  if (!showsText) {
    // Lädt noch, fehlt, ist binär oder zu groß: Das meldet die Dateiansicht.
    return (
      <FileView
        files={files}
        project={project}
        path={path}
        focused={focused}
        focusRequest={focusRequest}
        onEdited={() => {}}
      />
    );
  }

  /** Folgt dem angeklickten Link; das Fenster selbst verlässt die Oberfläche nie. */
  function follow(event: MouseEvent | KeyboardEvent) {
    const link = (event.target as Element).closest("[data-href]");
    if (!link) return;
    event.preventDefault();
    const target = resolveLink(path, link.getAttribute("data-href") ?? "");
    if (target.kind === "web") openUrl(target.url);
    else if (target.kind === "file") onOpenFile(target.path);
    else if (target.kind === "heading") {
      const headings = content.current!.querySelectorAll("h1, h2, h3, h4, h5, h6");
      [...headings]
        .find((heading) => headingSlug(heading.textContent ?? "") === target.slug.toLowerCase())
        ?.scrollIntoView();
    }
  }

  return (
    <div className="markdown-view" ref={view} tabIndex={-1}>
      <div
        className="markdown-body"
        ref={content}
        onClick={follow}
        onKeyDown={(event) => event.key === "Enter" && follow(event)}
      />
    </div>
  );
}
