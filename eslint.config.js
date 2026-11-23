// Lints der Oberfläche. Formatierung und Typen prüfen Prettier und tsc; hier stehen nur
// Regeln, die beide nicht kennen: die Regeln von React und die Grenzen der reinen Module.
import { readdirSync, readFileSync } from "node:fs";
import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Reine Module: Daten und Funktionen ohne React und ohne Aufrufe an den Kern, damit sie
 * sich ohne Fenster testen lassen. Ein neues reines Modul gehört in diese Liste.
 */
const pureModules = [
  "closeWindow",
  "explorerGit",
  "fileIcons",
  "fileNameSearch",
  "filePath",
  "fileState",
  "projectWatches",
  "repositories",
  "terminalLinks",
  "terminalResizeHold",
  "versionControlState",
  "workspace",
];

// Pakete, die an React, am Kern oder am Fenster hängen.
const boundPackages = ["react", "react-dom", "@tauri-apps/*", "@xterm/*", "monaco-editor*"];
const bindsPackage =
  /^\s*import\s+(?!type\b)[^;]*?from\s+["'](react|react-dom|@tauri-apps\/|@xterm\/|monaco-editor)/m;

// Module der Oberfläche, die selbst solche Pakete laden. Ein reines Modul darf aus ihnen
// nur Typen importieren, sonst hinge es über sie doch am Kern (so geschehen in #60).
const boundModules = readdirSync("src")
  .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
  .filter((file) => file.endsWith(".tsx") || bindsPackage.test(readFileSync(`src/${file}`, "utf8")))
  .map((file) => file.replace(/\.tsx?$/, ""));

const pureBoundary = {
  "no-restricted-imports": [
    "error",
    {
      paths: boundModules.map((name) => ({
        name: `./${name}`,
        allowTypeImports: true,
        message: `Ein reines Modul importiert aus ./${name} nur Typen, denn ./${name} hängt an React oder am Kern.`,
      })),
      patterns: [
        {
          group: boundPackages,
          allowTypeImports: true,
          message: "Ein reines Modul hängt nicht an React, am Kern oder am Fenster.",
        },
      ],
    },
  ],
};

// Babel liest TypeScript ohne das Paket typescript; dessen Version 7 hat keine JavaScript-API,
// die typescript-eslint bräuchte. JSX nur in .tsx, sonst kollidiert es mit `<T>`-Schreibweisen.
const parsing = (plugins) => ({
  parser: babelParser,
  parserOptions: {
    requireConfigFile: false,
    babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins } },
  },
});

export default [
  { ignores: ["dist/", "src-tauri/", "node_modules/", ".ua/", "scripts/"] },
  { files: ["src/**/*.ts"], languageOptions: parsing(["typescript"]) },
  { files: ["src/**/*.tsx"], languageOptions: parsing(["typescript", "jsx"]) },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/refs": "error",
    },
  },
  {
    files: pureModules.map((name) => `src/${name}.ts`),
    rules: pureBoundary,
  },
];
