// Führt alle Prüfungen in der Reihenfolge aus, die CI verlangt, und bricht beim ersten Fehler ab.
// Ausgabe: je Schritt eine Zeile; die Ausgabe eines Schritts erscheint nur, wenn er scheitert.
import { spawn, spawnSync } from "node:child_process";
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

/**
 * Wie lange ein Schritt höchstens läuft. Ein hängender Test hielt den Check sonst ohne Ende auf.
 * Großzügig, weil ein kalter Build des Kerns mehrere Minuten braucht.
 */
const stepLimitMinutes = 15;

/** Beendet einen Schritt samt allem, was er gestartet hat, etwa das Testprogramm unter cargo. */
function killTree(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
  } else {
    child.kill("SIGKILL");
  }
}

function run(command, args, cwd) {
  const [program, programArgs] =
    command === npm ? [process.execPath, [process.env.npm_execpath, ...args]] : [command, args];
  return new Promise((resolve) => {
    const child = spawn(program, programArgs, { cwd });
    let output = "";
    let hung = false;
    child.stdout.setEncoding("utf8").on("data", (text) => (output += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (output += text));
    const timer = setTimeout(() => {
      hung = true;
      killTree(child);
    }, stepLimitMinutes * 60_000);
    child.on("error", (error) => (output += String(error)));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ ok: status === 0 && !hung, output, hung });
    });
  });
}

for (const [name, command, args, cwd] of steps) {
  const started = Date.now();
  let { ok, output, hung } = await run(command, args, cwd);
  const cacheBroken = (text) => command === "cargo" && brokenCache.some((sign) => sign.test(text));
  if (!ok && cacheBroken(output)) {
    console.log(`neu   ${name}: Build-Cache des Kerns beschädigt, zweiter Lauf`);
    ({ ok, output, hung } = await run(command, args, cwd));
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (ok) {
    console.log(`ok    ${name} (${seconds} s)`);
    continue;
  }
  const reason = hung ? `hängt, nach ${stepLimitMinutes} min beendet` : `${seconds} s`;
  console.log(`ROT   ${name} (${reason}): ${command} ${args.join(" ")}`);
  console.log(output.split("\n").slice(-80).join("\n"));
  if (cacheBroken(output)) {
    console.log(
      "Der Build-Cache des Kerns ist beschädigt, nicht der Code. Abhilfe: `cargo clean -p kredr` in src-tauri, dann erneut prüfen.",
    );
  }
  process.exit(1);
}
