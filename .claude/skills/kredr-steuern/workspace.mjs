// Vorlage für Abläufe mit Workspace und Dateiansicht (#67): Ein zweites Projekt kommt
// hinzu, eine Datei daraus öffnet sich, ändert sich außerhalb von Kredr, und die
// Dateiansicht zeigt den neuen Inhalt. Exit 1, wenn nicht.
//
// Start: start.ps1 -Ordner <zweites Projekt>; das Projekt braucht eine Datei zwei.txt.
// Aufruf: node workspace.mjs <zweites Projekt>
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { verbinden } from "./cdp.mjs";

const zweites = process.argv[2];
if (!zweites) throw new Error("Aufruf: node workspace.mjs <zweites Projekt>");
const kredr = await verbinden();
await kredr.neuLaden();

let ok = false;
try {
  writeFileSync(join(zweites, "zwei.txt"), "alter Inhalt\n");
  await kredr.projektHinzufuegen(basename(zweites));
  await kredr.ordnerAufklappen(basename(zweites));
  await kredr.dateiOeffnen("zwei.txt");
  await kredr.editorZeigt("alter Inhalt");
  // Außerhalb ändern, wie es ein Agent täte.
  writeFileSync(join(zweites, "zwei.txt"), "neuer Inhalt vom Agenten\n");
  await kredr.editorZeigt("neuer Inhalt vom Agenten", { zeit: 8000 });
  ok = true;
} catch (fehler) {
  console.log(String(fehler).split("\n")[0]);
}

const steht = await kredr.steht();
for (const f of kredr.fehler) console.log("Fehler:", f.split("\n")[0]);
kredr.schliessen();
console.log(ok && steht ? "GRÜN: Dateiansicht zeigt den neuen Inhalt" : "ROT");
process.exit(ok && steht ? 0 : 1);
