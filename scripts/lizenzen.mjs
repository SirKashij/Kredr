// Sammelt die Lizenzen aller Pakete, die im Installer landen, in dist/THIRD_PARTY_LICENSES.txt.
// Läuft am Ende von `npm run build`; die Datei wird mit der Oberfläche in Kredr eingebettet und
// ist in den Einstellungen zu lesen. MIT, Apache-2.0 und Co. verlangen, dass ihr Text mitkommt.
//
// Rust: alle Crates, die für Windows (x86_64-pc-windows-msvc) gebaut werden, ohne Dev-Abhängigkeiten.
// npm: alle Pakete aus package-lock.json, die keine Dev-Abhängigkeiten sind.
// Gleiche Texte erscheinen nur einmal, mit der Liste der Pakete, für die sie gelten.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const core = join(root, "src-tauri");
const output = join(root, "dist", "THIRD_PARTY_LICENSES.txt");
const target = "x86_64-pc-windows-msvc";

// LICENSE, LICENCE, COPYING, NOTICE, UNLICENSE, ThirdPartyNotices samt Endungen wie -MIT oder .md.
const licenseFile = /^(licen[cs]e|copying|notice|unlicense|thirdpartynotices)([-._].*)?$/i;

function licenseTexts(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseFile.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readFileSync(join(folder, entry.name), "utf8").replace(/\r\n/g, "\n").trim());
}

function rustPackages() {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--filter-platform", target],
      { cwd: core, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  const byId = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const rootId = metadata.resolve.root;
  // Vom Kern aus allen Kanten folgen, die nicht nur für Tests gelten.
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.pop()).deps) {
      const used = dep.dep_kinds.some((k) => k.kind !== "dev");
      if (used && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  seen.delete(rootId);
  return [...seen].map((id) => {
    const p = byId.get(id);
    const folder = dirname(p.manifest_path);
    const texts = licenseTexts(folder);
    if (p.license_file) {
      const file = join(folder, p.license_file);
      if (existsSync(file)) texts.push(readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim());
    }
    return {
      name: p.name,
      version: p.version,
      license: p.license ?? "siehe Lizenztext",
      source: p.repository ?? `https://crates.io/crates/${p.name}`,
      authors: p.authors ?? [],
      texts: [...new Set(texts)],
    };
  });
}

function npmPackages() {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path !== "" && !entry.dev && !entry.devOptional)
    .map(([path, entry]) => {
      const folder = join(root, path);
      const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      const repository =
        typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
      const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
      return {
        name,
        version: entry.version,
        license: entry.license ?? manifest.license ?? "siehe Lizenztext",
        source: repository ?? `https://www.npmjs.com/package/${name}`,
        authors: author ? [author] : [],
        texts: licenseTexts(folder),
      };
    });
}

// Für Pakete, die ihren Lizenztext nicht mitliefern. Nur MIT braucht einen Copyright-Vermerk,
// den die Autoren aus dem Manifest liefern; Apache-2.0 liefert fast jedes andere Crate mit.
function mitText(authors) {
  const holders = authors.length > 0 ? authors.join(", ") : "the authors";
  return `Copyright (c) ${holders}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
}

const packages = [
  ...rustPackages().map((p) => ({ ...p, kind: "Rust" })),
  ...npmPackages().map((p) => ({ ...p, kind: "npm" })),
].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

// Lizenzen ohne Copyright-Vermerk im Text: Ein Exemplar aus einem anderen Paket gilt wörtlich.
const standardHeads = {
  "Apache-2.0": /^\s*Apache License\s+Version 2\.0, January 2004/,
  "MPL-2.0": /^\s*Mozilla Public License Version 2\.0/,
  "BSL-1.0": /^\s*Boost Software License - Version 1\.0/,
};
const allTexts = packages.flatMap((p) => p.texts);
const standardText = (id) => allTexts.find((t) => standardHeads[id].test(t));

// Ohne eigenen Text: zuerst der Text eines Pakets aus demselben Repository (etwa
// alloc-stdlib und alloc-no-stdlib), dann der Standardtext der Lizenz.
const missing = [];
for (const p of packages) {
  if (p.texts.length > 0) continue;
  const sibling = packages.find(
    (o) => o !== p && o.source === p.source && o.license === p.license && o.texts.length > 0,
  );
  const standard = Object.keys(standardHeads).find((id) => p.license.includes(id));
  if (sibling) p.texts.push(...sibling.texts);
  else if (/\bMIT\b/.test(p.license)) p.texts.push(mitText(p.authors));
  else if (standard && standardText(standard)) p.texts.push(standardText(standard));
  else missing.push(`${p.kind} ${p.name} ${p.version} (${p.license})`);
}
if (missing.length > 0) {
  console.error(`Ohne Lizenztext:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const groups = new Map();
for (const p of packages) {
  for (const text of p.texts) {
    const key = text.replace(/\s+/g, " ");
    if (!groups.has(key)) groups.set(key, { text, users: [] });
    groups.get(key).users.push(`${p.name} ${p.version}`);
  }
}

const rule = "=".repeat(80);
const lines = [
  "Kredr – Lizenzen von Drittsoftware",
  "",
  "Kredr enthält die folgenden Pakete. Ihre Lizenzen stehen weiter unten.",
  "",
  rule,
  "",
  ...packages.map((p) => `${p.kind.padEnd(5)} ${p.name} ${p.version} – ${p.license} – ${p.source}`),
];
for (const { text, users } of groups.values()) {
  lines.push("", rule, "", `Gilt für: ${users.join(", ")}`, "", text);
}
writeFileSync(output, `${lines.join("\n")}\n`);
console.log(
  `${packages.length} Pakete, ${groups.size} Lizenztexte -> dist/THIRD_PARTY_LICENSES.txt`,
);
