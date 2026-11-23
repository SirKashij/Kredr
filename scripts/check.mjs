// Führt alle Prüfungen in der Reihenfolge aus, die CI verlangt, und bricht beim ersten Fehler ab.
// Ausgabe: je Schritt eine Zeile; die Ausgabe eines Schritts erscheint nur, wenn er scheitert.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const core = fileURLToPath(new URL("../src-tauri", import.meta.url));
// npm startet dieses Skript und nennt in npm_execpath sein eigenes JavaScript. Darüber läuft npm
// ohne Shell, denn npm.cmd ließe sich unter Windows nur über die Shell starten.
if (!process.env.npm_execpath) {
  console.log("Über `npm run check` starten.");
  process.exit(1);
}
const npm = "npm";

const steps = [
  ["Formatierung der Oberfläche", npm, ["run", "format:check"], root],
  ["Typprüfung der Oberfläche", npm, ["run", "typecheck"], root],
  ["Lints der Oberfläche", npm, ["run", "lint"], root],
  ["Tests der Oberfläche", npm, ["test"], root],
  // Der Kern bettet die gebaute Oberfläche ein und übersetzt ohne sie nicht.
  ["Oberfläche bauen", npm, ["run", "build"], root],
  ["Formatierung des Kerns", "cargo", ["fmt", "--check"], core],
  [
    "Lints des Kerns",
    "cargo",
    ["clippy", "--all-targets", "--locked", "--", "-D", "warnings"],
    core,
  ],
  ["Tests des Kerns", "cargo", ["test", "--locked"], core],
];

/**
 * Woran ein beschädigter Build-Cache des Kerns zu erkennen ist, nicht ein Fehler im Code:
 * Der Compiler stürzt ab oder findet bereits übersetzte Crates nicht mehr. Ein zweiter
 * Lauf ist dann meist grün.
 */
const brokenCache = [
  /internal compiler error/,
  /required to be available in rlib format, but was not found/,
];

function run(command, args, cwd) {
  const [program, programArgs] =
    command === npm ? [process.execPath, [process.env.npm_execpath, ...args]] : [command, args];
  const result = spawnSync(program, programArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
  return { ok: result.status === 0, output };
}

for (const [name, command, args, cwd] of steps) {
  const started = Date.now();
  let { ok, output } = run(command, args, cwd);
  const cacheBroken = (text) => command === "cargo" && brokenCache.some((sign) => sign.test(text));
  if (!ok && cacheBroken(output)) {
    console.log(`neu   ${name}: Build-Cache des Kerns beschädigt, zweiter Lauf`);
    ({ ok, output } = run(command, args, cwd));
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (ok) {
    console.log(`ok    ${name} (${seconds} s)`);
    continue;
  }
  console.log(`ROT   ${name} (${seconds} s): ${command} ${args.join(" ")}`);
  console.log(output.split("\n").slice(-80).join("\n"));
  if (cacheBroken(output)) {
    console.log(
      "Der Build-Cache des Kerns ist beschädigt, nicht der Code. Abhilfe: `cargo clean -p kredr` in src-tauri, dann erneut prüfen.",
    );
  }
  process.exit(1);
}
