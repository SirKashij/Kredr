/** Das Symbol eines Dateityps: ein kurzes Zeichen in der Farbe des Typs. */
export interface FileIcon {
  glyph: string;
  color: string;
}

const typescript: FileIcon = { glyph: "TS", color: "#519aba" };
const javascript: FileIcon = { glyph: "JS", color: "#cbcb41" };
const shell: FileIcon = { glyph: ">_", color: "#89e051" };
const config: FileIcon = { glyph: "≡", color: "#8b9aa5" };
const image: FileIcon = { glyph: "▣", color: "#a074c4" };
const git: FileIcon = { glyph: "◆", color: "#e8573f" };

/** Symbole nach Dateiendung, ohne Punkt und kleingeschrieben. */
const byExtension: Record<string, FileIcon> = {
  ts: typescript,
  tsx: typescript,
  mts: typescript,
  cts: typescript,
  js: javascript,
  jsx: javascript,
  mjs: javascript,
  cjs: javascript,
  json: { glyph: "{}", color: "#cbcb41" },
  jsonc: { glyph: "{}", color: "#cbcb41" },
  md: { glyph: "M↓", color: "#519aba" },
  rs: { glyph: "RS", color: "#dea584" },
  py: { glyph: "PY", color: "#4b9cd3" },
  html: { glyph: "<>", color: "#e37933" },
  htm: { glyph: "<>", color: "#e37933" },
  css: { glyph: "#", color: "#519aba" },
  scss: { glyph: "#", color: "#f55385" },
  ps1: shell,
  psm1: shell,
  sh: shell,
  bash: shell,
  cmd: shell,
  bat: shell,
  toml: config,
  yaml: config,
  yml: config,
  ini: config,
  lock: config,
  png: image,
  jpg: image,
  jpeg: image,
  gif: image,
  webp: image,
  ico: image,
  svg: { glyph: "▣", color: "#e8a33d" },
  pdf: { glyph: "PDF", color: "#e8573f" },
  txt: { glyph: "≣", color: "#8b9aa5" },
  log: { glyph: "≣", color: "#8b9aa5" },
};

/** Symbole für Dateien, die am ganzen Namen erkannt werden. */
const byName: Record<string, FileIcon> = {
  ".gitignore": git,
  ".gitattributes": git,
  ".gitmodules": git,
};

/** Das Symbol für eine Datei; `null` heißt: das allgemeine Dateisymbol. */
export function fileIcon(name: string): FileIcon | null {
  const lower = name.toLowerCase();
  if (lower in byName) return byName[lower];
  const dot = lower.lastIndexOf(".");
  // Ein führender Punkt (etwa `.env`) ist keine Endung.
  if (dot <= 0) return null;
  return byExtension[lower.slice(dot + 1)] ?? null;
}
