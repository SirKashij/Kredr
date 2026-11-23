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

for (const [name, command, args, cwd] of steps) {
  const started = Date.now();
  const [program, programArgs] =
    command === npm ? [process.execPath, [process.env.npm_execpath, ...args]] : [command, args];
  const result = spawnSync(program, programArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.status === 0) {
    console.log(`ok    ${name} (${seconds} s)`);
    continue;
  }
  console.log(`ROT   ${name} (${seconds} s): ${command} ${args.join(" ")}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
  console.log(output.split("\n").slice(-80).join("\n"));
  process.exit(1);
}
