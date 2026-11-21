// Beispiel und Rauchtest: Flackert das Terminal, wenn eine Seitenleiste zu- und aufgeht?
// Behoben mit `renderNow` in src/runningTerminals.ts: `fit` leert die WebGL-Fläche, xterm.js
// zeichnet erst im nächsten Frame neu, dazwischen malte der Browser ein leeres Terminal.
//
// Nimmt jedes gemalte Bild per Screencast auf und prüft, ob die erste Terminalzeile leer ist.
// Exit 1 (ROT), sobald ein leeres Bild auftaucht; Exit 2, wenn kein Terminal sichtbar wird.
// Aufruf: node flackern.mjs [runden=5]
//   BREMSE=n  CPU-Drosselung (Standard 6); gebremst bleibt das leere Bild länger stehen,
//             und der Screencast erwischt es zuverlässig. BREMSE=1 misst ungebremst.
//   ZEIGEN=1  Hellpixel je Bild ausgeben und die Bilder als probe-<n>.png ablegen.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const runden = Number(process.argv[2] ?? 5);
const laufend = join(tmpdir(), "kredr-steuern", "laufend.json");
const port = JSON.parse(readFileSync(laufend, "utf8").replace(/^﻿/, "")).port;

const ziele = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const seite = ziele.find((z) => z.type === "page" && z.url.includes("localhost:1420"));
const ws = new WebSocket(seite.webSocketDebuggerUrl);
await new Promise((fertig) => ws.addEventListener("open", fertig));

let naechste = 1;
const offen = new Map();
let bilder = [];
ws.addEventListener("message", (ereignis) => {
  const m = JSON.parse(ereignis.data);
  if (m.id && offen.has(m.id)) {
    offen.get(m.id)(m.result);
    offen.delete(m.id);
  }
  if (m.method === "Page.screencastFrame") {
    bilder.push(m.params.data);
    senden("Page.screencastFrameAck", { sessionId: m.params.sessionId });
  }
});
function senden(method, params = {}) {
  return new Promise((fertig) => {
    const id = naechste++;
    offen.set(id, fertig);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const auswerten = async (expression) =>
  (await senden("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result
    .value;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const ansicht = (n) => `document.querySelector(".actbar > button:nth-child(${n})")`;

// Vorbedingung: ein sichtbares Terminal mit Prompt. Erst einen vorhandenen Terminal-Tab nach
// vorn holen (die Versionskontrolle öffnet einen eigenen Tab), sonst eins neu öffnen.
const sichtbar = `(() => {
  const s = document.querySelector("main .xterm-screen");
  return !!s && s.getBoundingClientRect().width > 0;
})()`;
await auswerten(`[...document.querySelectorAll("[role=tab]")]
  .find((t) => t.querySelector(".tab-name")?.textContent.includes("PowerShell"))?.click()`);
await warte(300);
if (!(await auswerten(sichtbar))) {
  await auswerten(`${ansicht(1)}.classList.contains("on") || ${ansicht(1)}.click()`);
  await warte(300);
  await auswerten(`document.querySelector(".side-actions .btn.ghost").click()`); // Neues Terminal
  for (let i = 0; i < 50 && !(await auswerten(sichtbar)); i++) await warte(100);
  await warte(2000); // bis der Prompt steht
}
const oben = await auswerten(`(() => {
  const s = document.querySelector("main .xterm-screen");
  return s && s.getBoundingClientRect().width > 0 ? s.getBoundingClientRect().y : null;
})()`);
if (oben === null) {
  console.log("Vorbedingung fehlt: kein sichtbares Terminal im Hauptbereich");
  process.exit(2);
}

// Zählt helle Pixel in der ersten Terminalzeile, x 340–580: Dort steht der Prompt bei offener
// wie bei geschlossener Seitenleiste (der Hauptbereich beginnt bei 48 bzw. 328).
const textPixel = (png) =>
  auswerten(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${png}";
    await img.decode();
    const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(340, ${Math.round(oben)}, 240, 18).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 400) n++;
    return n;
  })()`);

await senden("Page.enable");
await senden("Emulation.setCPUThrottlingRate", { rate: Number(process.env.BREMSE ?? 6) });
let leere = 0;
let gesamt = 0;
for (let runde = 0; runde < runden; runde++) {
  // Agenten, Explorer, Suche. Die Versionskontrolle (4) holt ihren eigenen Tab nach vorn,
  // dort verschwindet das Terminal zu Recht.
  for (const n of [1, 2, 3]) {
    const aktiv = await auswerten(
      `${ansicht(n)}.classList.contains("on") && !!document.querySelector(".sidebar")`,
    );
    if (!aktiv) await auswerten(`${ansicht(n)}.click()`);
    await warte(400);
    bilder = [];
    await senden("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await warte(300);
    await auswerten(`${ansicht(n)}.click()`); // zu
    await warte(400);
    await auswerten(`${ansicht(n)}.click()`); // auf
    await warte(400);
    await senden("Page.stopScreencast");
    for (const bild of bilder) {
      gesamt++;
      const pixel = await textPixel(bild);
      if (process.env.ZEIGEN) {
        console.log(`Ansicht ${n} Bild ${gesamt}: ${pixel}`);
        writeFileSync(`probe-${gesamt}.png`, Buffer.from(bild, "base64"));
      }
      if (pixel === 0) leere++;
    }
  }
}
await senden("Emulation.setCPUThrottlingRate", { rate: 1 });
ws.close();
console.log(`${leere} von ${gesamt} Bildern ohne Terminaltext (${runden} Runden x 3 Ansichten)`);
console.log(leere > 0 ? "ROT: Terminal flackert" : "GRÜN: kein Flackern");
process.exit(leere > 0 ? 1 : 0);
