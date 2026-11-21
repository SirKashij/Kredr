/**
 * Die gerenderte Markdown-Vorschau als reine Funktionen: aus Markdown wird
 * HTML, das im Fenster nichts ausführen und nichts von selbst laden kann.
 *
 * Markdown ist fremder Inhalt (ein Agent oder ein geklontes Repository hat
 * ihn geschrieben), die Vorschau liegt aber im selben Fenster wie die
 * Tauri-Befehle. Deshalb gilt eine Positivliste: Nur bekannte Elemente und
 * Attribute überstehen `renderMarkdown`. Links und Bilder verlieren `href`
 * und `src` und tragen ihr Ziel als `data-href` bzw. `data-src`; wohin ein
 * Klick führt und was geladen wird, entscheiden allein `resolveLink` und
 * `resolveImage`.
 */

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { imageMimeType } from "./fileKinds";
import { isOutsideProject } from "./filePath";

const parser = new MarkdownIt({ html: true, linkify: true });

// Die Sprache eines Codeblocks steht als `data-lang` am Block; die
// Syntaxfarben setzt die Vorschau nachträglich.
parser.renderer.rules.fence = (tokens, index) => {
  const { info, content } = tokens[index];
  const language = info.trim().split(/\s+/)[0];
  const { escapeHtml } = parser.utils;
  const attribute = language ? ` data-lang="${escapeHtml(language)}"` : "";
  return `<pre${attribute}><code>${escapeHtml(content)}</code></pre>\n`;
};

// Die Ausrichtung einer Tabellenspalte als Attribut statt als `style`, das
// die Positivliste nicht durchlässt.
parser.core.ruler.push("cell_alignment", (state) => {
  for (const token of state.tokens) {
    if (token.type !== "th_open" && token.type !== "td_open") continue;
    const alignment = /text-align:\s*(left|center|right)/.exec(String(token.attrGet("style")));
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== "style");
    if (alignment) token.attrSet("align", alignment[1]);
  }
});

const ALLOWED_TAGS =
  "h1 h2 h3 h4 h5 h6 p br hr blockquote pre code em strong b i u s del ins sub sup kbd mark small abbr a img ul ol li dl dt dd table thead tbody tfoot tr th td caption details summary div span figure figcaption".split(
    " ",
  );
const ALLOWED_ATTR =
  "href src alt title width height align colspan rowspan start open data-lang".split(" ");

const sanitizer = DOMPurify(window);

// Was nach der Prüfung noch `href` oder `src` trägt, ist als Adresse
// zulässig; trotzdem folgt das Fenster ihr nie von selbst.
sanitizer.addHook("afterSanitizeAttributes", (node) => {
  for (const attribute of ["href", "src"]) {
    const value = node.getAttribute(attribute);
    if (value === null) continue;
    node.removeAttribute(attribute);
    node.setAttribute(`data-${attribute}`, value);
  }
  if (node.tagName === "A" && node.hasAttribute("data-href")) {
    node.setAttribute("role", "link");
    node.setAttribute("tabindex", "0");
  }
});

/** Rendert Markdown zu HTML, das gefahrlos als Inhalt der Vorschau eingesetzt werden kann. */
export function renderMarkdown(source: string): string {
  return sanitizer.sanitize(parser.render(source), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

/** Wohin ein Klick auf einen Link der Vorschau führt. */
export type LinkTarget =
  /** Eine Web-Adresse für den Standardbrowser. */
  | { kind: "web"; url: string }
  /** Eine Datei, in der Schreibweise der Oberfläche (siehe `toProjectPath`). */
  | { kind: "file"; path: string }
  /** Eine Überschrift derselben Vorschau, siehe `headingSlug`. */
  | { kind: "heading"; slug: string }
  /** Nichts: unbekanntes oder ausführbares Ziel. */
  | { kind: "none" };

/** Entscheidet, wohin der Link `href` aus der Markdown-Datei `documentPath` führt. */
export function resolveLink(documentPath: string, href: string): LinkTarget {
  const target = href.trim();
  if (/^https?:/i.test(target)) return { kind: "web", url: target };
  if (target.startsWith("#")) return { kind: "heading", slug: decode(target.slice(1)) };
  const path = resolvePath(documentPath, target);
  return path === null ? { kind: "none" } : { kind: "file", path };
}

/** Was ein Bild der Vorschau zeigt. */
export type ImageSource =
  /** Eine Bilddatei von der Festplatte, in der Schreibweise der Oberfläche. */
  | { kind: "local"; path: string }
  /** Ein in das Markdown eingebettetes Bild (`data:image/…`). */
  | { kind: "inline"; url: string }
  /** Ein Bild aus dem Internet; es wird nicht geladen. */
  | { kind: "remote"; url: string }
  | { kind: "none" };

/** Entscheidet, was das Bild mit der Quelle `src` aus der Markdown-Datei `documentPath` zeigt. */
export function resolveImage(documentPath: string, src: string): ImageSource {
  const source = src.trim();
  if (/^https?:/i.test(source)) return { kind: "remote", url: source };
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon|avif)[;,]/i.test(source)) {
    return { kind: "inline", url: source };
  }
  const path = resolvePath(documentPath, source);
  return path !== null && imageMimeType(path) ? { kind: "local", path } : { kind: "none" };
}

/**
 * Die Sprungmarke einer Überschrift, gebildet wie bei GitHub: klein
 * geschrieben, ohne Satzzeichen, Leerzeichen als Bindestriche.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replaceAll(" ", "-");
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Der Pfad, den eine relative Angabe aus der Datei `documentPath` meint;
 * `null`, wenn sie keine Datei neben dem Dokument bezeichnet (Adressen mit
 * Schema, Netzwerkpfade, Laufwerkspfade).
 */
function resolvePath(documentPath: string, reference: string): string | null {
  const relative = decode(reference.replace(/[?#].*$/s, ""));
  // Kein Schema, kein Laufwerk, kein Netzwerkpfad, keine Steuerzeichen.
  if (!relative || /[:\\\u0000-\u001f]/.test(relative) || relative.startsWith("//")) return null;
  const outside = isOutsideProject(documentPath);
  const base = documentPath.split("/").slice(0, -1);
  // Außerhalb des Projekts beginnt der volle Pfad mit dem Laufwerk; es bleibt stehen.
  const root = outside ? base.splice(0, 1) : [];
  const segments = relative.startsWith("/") ? [] : base;
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else if (!outside) segments.push("..");
  }
  return [...root, ...segments].join("/");
}

/**
 * Die Monaco-Sprache für die Angabe hinter den Backticks eines Codeblocks
 * (`ts`, `bash`, `PowerShell` …): ihre Kennung, einer ihrer Namen oder eine
 * ihrer Dateiendungen. `null`, wenn keine passt.
 */
export function codeLanguage(
  languages: readonly { id: string; aliases?: string[]; extensions?: string[] }[],
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  const matches = (candidates: string[] = []) =>
    candidates.some((candidate) => candidate.toLowerCase() === wanted);
  const language =
    languages.find(({ id }) => id === wanted) ??
    languages.find(({ aliases }) => matches(aliases)) ??
    languages.find(({ extensions }) => matches(extensions?.map((extension) => extension.slice(1))));
  return language?.id ?? null;
}
