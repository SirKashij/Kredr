import { expect, test } from "vitest";
import glossary from "../GLOSSARY.md?raw";
import de from "./i18n/locales/de.json";

/** Alle Quelltexte des Repos, die ein Agent schreibt: Oberfläche und Kern samt Tests. */
const sources = import.meta.glob<string>(
  [
    "../src/**/*.{ts,tsx,css,json}",
    "../src-tauri/{src,tests}/**/*.rs",
    "../src-tauri/*.{json,toml}",
  ],
  { query: "?raw", import: "default", eager: true },
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("kein Quelltext enthält den Benutzerordner dieses Rechners", () => {
  // Nur lokal wirksam: Hier schreibt ein Agent versehentlich seinen eigenen Pfad hinein.
  const user = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env.USERNAME;
  if (!user) return;
  const ownFolder = new RegExp(`Users[\\\\/]+${escape(user)}([\\\\/"']|$)`, "i");

  const hits = Object.entries(sources)
    .filter(([, text]) => ownFolder.test(text))
    .map(([path]) => path);

  expect(hits, "Beispielpfade wie C:\\Users\\test verwenden").toEqual([]);
});

test("deutsche Oberflächentexte vermeiden die Wörter aus dem Glossar", () => {
  const avoided = [...glossary.matchAll(/^_Vermeiden_:(.*)$/gm)].flatMap((match) =>
    match[1]
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean),
  );
  expect(avoided.length).toBeGreaterThan(0);

  const hits = Object.entries(de).flatMap(([key, text]) =>
    avoided
      .filter((word) => new RegExp(`(^|[^\\p{L}])${escape(word)}($|[^\\p{L}])`, "iu").test(text))
      .map((word) => `${key}: „${word}“`),
  );

  expect(hits).toEqual([]);
});
