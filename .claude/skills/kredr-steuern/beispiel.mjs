// Beispiel und Rauchtest: der Bug mit dem grauen Screen (74e2482). Ein Diff in der
// Versionskontrolle, dann ein Wechsel zum Terminal. Exit 1, wenn die Oberfläche verschwindet.
import { GrauerScreen, verbinden } from "./cdp.mjs";

const kredr = await verbinden();
await kredr.neuLaden();
const ansicht = (n) => `.actbar > button:nth-child(${n})`;

try {
  // Ein eigenes Terminal, gleich was die gespeicherte Aufteilung mitbringt.
  const karten = await kredr.auswerten(`document.querySelectorAll(".cards .card").length`);
  await kredr.klicken(".side-actions .btn.ghost"); // Neues Terminal
  await kredr.warten(`document.querySelectorAll(".cards .card").length > ${karten}`);
  await kredr.klicken(ansicht(4)); // Versionskontrolle
  await kredr.klicken(".change-row"); // Diff der offenen Änderung
  await kredr.warten(`document.querySelector(".file-editor .monaco-diff-editor")`);
  await kredr.klicken(ansicht(1)); // Agenten
  await kredr.klicken(".cards .card:last-of-type"); // das neue Terminal
  await new Promise((r) => setTimeout(r, 500));
} catch (fehler) {
  if (!(fehler instanceof GrauerScreen)) throw fehler;
}

const steht = await kredr.steht();
for (const f of kredr.fehler) console.log("Fehler:", f.split("\n")[0]);
kredr.schliessen();
console.log(steht ? "GRÜN: Oberfläche steht" : "ROT: grauer Screen");
process.exit(steht ? 0 : 1);
