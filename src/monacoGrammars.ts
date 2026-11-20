import type { languages } from "monaco-editor/editor/editor.api";

/** Syntaxfarben für JSON, auch mit Kommentaren (`.jsonc`, `tsconfig.json`). */
export const jsonLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".json",
  tokenizer: {
    root: [
      [/\s+/, ""],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"],
      [/"/, "string.value", "@string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}]/, "delimiter.bracket"],
      [/[[\]]/, "delimiter.array"],
      [/:/, "delimiter.colon"],
      [/,/, "delimiter.comma"],
    ],
    string: [
      [/[^"\\]+/, "string.value"],
      [/\\./, "string.escape"],
      [/"/, "string.value", "@pop"],
      // Eine Zeichenkette endet spätestens mit ihrer Zeile.
      [/$/, "", "@pop"],
    ],
    comment: [
      [/[^*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/\*/, "comment"],
    ],
  },
};

export const jsonConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}", notIn: ["string"] },
    { open: "[", close: "]", notIn: ["string"] },
    { open: '"', close: '"', notIn: ["string"] },
  ],
};

/** Syntaxfarben für TOML (`Cargo.toml`, `pyproject.toml`). */
export const tomlLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".toml",
  tokenizer: {
    root: [
      [/\s+/, ""],
      [/#.*$/, "comment"],
      // Tabellen: [paket] und [[bin]]
      [/^\s*\[\[?[^\]]*\]\]?/, "type"],
      // Schlüssel vor dem Gleichheitszeichen
      [
        /(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*(?=\s*=)/,
        "key",
      ],
      [/=/, "delimiter", "@value"],
    ],
    value: [[/[ \t]+/, ""], [/#.*$/, "comment", "@pop"], [/$/, "", "@pop"], { include: "@values" }],
    values: [
      [/"""/, "string", "@multilineBasic"],
      [/'''/, "string", "@multilineLiteral"],
      [/"/, "string", "@basic"],
      [/'[^']*'/, "string"],
      [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?/, "number"],
      [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, "number"],
      [/[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)/, "number"],
      [/[+-]?(?:inf|nan)\b/, "number"],
      [/[+-]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?/, "number"],
      [/\b(?:true|false)\b/, "keyword"],
      [/[[{]/, "delimiter.bracket", "@nested"],
      [/,/, "delimiter"],
    ],
    // Listen und eingebettete Tabellen dürfen über mehrere Zeilen gehen.
    nested: [
      [/\s+/, ""],
      [/#.*$/, "comment"],
      [/[\]}]/, "delimiter.bracket", "@pop"],
      [/(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?=\s*=)/, "key"],
      [/=/, "delimiter"],
      { include: "@values" },
    ],
    basic: [
      [/[^"\\]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
      [/$/, "", "@pop"],
    ],
    multilineBasic: [
      [/"""/, "string", "@pop"],
      [/\\./, "string.escape"],
      [/[^"\\]+|"/, "string"],
    ],
    multilineLiteral: [
      [/'''/, "string", "@pop"],
      [/[^']+|'/, "string"],
    ],
  },
};

export const tomlConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [
    ["[", "]"],
    ["{", "}"],
  ],
  autoClosingPairs: [
    { open: "[", close: "]", notIn: ["string"] },
    { open: "{", close: "}", notIn: ["string"] },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
};
