// Löst im Fenster mit dem Label argv[2] (Vorgabe `main`) die Rückfrage vor der
// Aktualisierung aus. Ohne Anlass entfällt sie, deshalb startet das Skript dort
// zuerst ein Terminal mit laufendem Prozess; `--ohne-anlass` lässt das weg.
// Braucht start.ps1 -Aktualisierung. Wartet nicht auf die Antwort: Den Dialog
// beantwortet dialoge.ps1.
import { fenster, verbinden } from "./cdp.mjs";

const label = process.argv[2] ?? "main";
const mitAnlass = !process.argv.includes("--ohne-anlass");

let kredr = null;
for (let nummer = 0; nummer < (await fenster()).length; nummer++) {
  const kandidat = await verbinden({ nummer });
  if ((await kandidat.auswerten("__TAURI_INTERNALS__.metadata.currentWindow.label")) === label) {
    kredr = kandidat;
    break;
  }
  kandidat.schliessen();
}
if (!kredr) {
  console.log(`ROT: kein Fenster mit dem Label ${label}`);
  process.exit(1);
}

if (mitAnlass) {
  const karten = await kredr.auswerten(`document.querySelectorAll(".cards .card").length`);
  await kredr.klicken(".side-actions .btn.ghost"); // Neues Terminal
  await kredr.warten(`document.querySelectorAll(".cards .card").length > ${karten}`);
  await kredr.warten(`document.querySelector(".xterm-helper-textarea")`);
  await new Promise((r) => setTimeout(r, 2000)); // bis die Shell bereit ist
  await kredr.tippen("ping -t 127.0.0.1");
  await new Promise((r) => setTimeout(r, 1500));
}

// Der Klick wartet nicht auf die Antwort des Dialogs.
const geklickt = await kredr.auswerten(`(() => {
  const knopf = [...document.querySelectorAll(".notice button")]
    .find((b) => b.textContent.trim() === "Jetzt aktualisieren");
  if (!knopf) return false;
  setTimeout(() => knopf.click(), 0);
  return true;
})()`);
kredr.schliessen();
console.log(
  geklickt ? `Rückfrage in ${label} ausgelöst` : `ROT: kein „Jetzt aktualisieren“ in ${label}`,
);
process.exit(geklickt ? 0 : 1);
