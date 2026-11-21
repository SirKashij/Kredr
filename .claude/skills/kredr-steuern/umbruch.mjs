// Rauchtest: Flackert ein Terminal mit Vollbildprogramm (Claude Code), wenn die Seitenleiste
// auf- und zugeht? Ändert sich die Spaltenzahl, brach erst xterm.js den Puffer um, dann schickte
// ConPTY seinen eigenen Umbruch und erst danach zeichnete Claude Code richtig neu; jeder
// Zwischenstand war ein eigenes Bild. Behoben mit `ResizeHold` (src/terminalResizeHold.ts).
//
// Startet bei Bedarf einen Agenten, nimmt jedes Bild per Screencast auf und prüft, ob jedes
// Bild entweder dem alten Inhalt (an alter oder um die Seitenleiste verschobener Stelle) oder
// dem Endbild entspricht. Exit 1 (ROT) bei einem Zwischenbild, Exit 2 ohne Vorbedingung.
// Aufruf: node umbruch.mjs [runden=3]
//   BREMSE=n  CPU-Drosselung (Standard 6). Gebremst und gleich nach `neuLaden()` ist `fit`
//             langsam; das prüft, dass xterm.js zwischen Größe und Ausgabe nicht abgibt.
//   ZEIGEN=1  Zeitpunkt jedes Zwischenbilds ausgeben und alle Bilder in bilder-umbruch/ ablegen.
import { mkdirSync, writeFileSync } from "node:fs";
import { verbinden } from "./cdp.mjs";

const runden = Number(process.argv[2] ?? 3);
const kredr = await verbinden();
const { auswerten, warten } = kredr;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const agenten = `document.querySelector(".actbar > button:nth-child(1)")`;
const agentTab = `[...document.querySelectorAll("[role=tab]")]
  .find((t) => t.querySelector(".tab-name")?.textContent.includes("Agent"))`;

// Vorbedingung: der Tab eines Agenten vorn, Claude Code zeigt seine erste Rückfrage.
await auswerten(`${agenten}.classList.contains("on") || ${agenten}.click()`);
await warte(300);
if (!(await auswerten(`!!${agentTab}`))) {
  await auswerten(`document.querySelector(".side-actions .btn:not(.ghost)").click()`); // Neuer Agent
  await warten(`!!${agentTab}`);
  await warte(10000); // bis Claude Code steht
}
await auswerten(`${agentTab}.click()`);
await warte(1500);
if (
  !(await auswerten(
    `document.querySelector("main .xterm-screen")?.getBoundingClientRect().width > 0`,
  ))
) {
  console.log("Vorbedingung fehlt: kein sichtbares Terminal");
  process.exit(2);
}

// Raster unterhalb der Tabs: 8x16-Pixel-Zellen, an bei mehr als 3 hellen Pixeln.
const raster = (jpg) =>
  auswerten(`(async () => {
    const img = new Image();
    img.src = "data:image/jpeg;base64,${jpg}";
    await img.decode();
    const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
    g.drawImage(img, 0, 0);
    const w = img.width, h = 400, d = g.getImageData(0, 40, w, h).data;
    const zeilen = [];
    for (let cy = 0; cy + 16 <= h; cy += 16) {
      let z = "";
      for (let cx = 0; cx + 8 <= w; cx += 8) {
        let n = 0;
        for (let y = cy; y < cy + 16; y++)
          for (let x = cx; x < cx + 8; x++) {
            const i = (y * w + x) * 4;
            if (d[i] + d[i + 1] + d[i + 2] > 400) n++;
          }
        z += n > 3 ? "1" : "0";
      }
      zeilen.push(z);
    }
    return zeilen;
  })()`);

// Unterschiedliche Zellen in den Spalten [von, bis) von a; b ist um `versatz` Spalten verschoben.
const abstand = (a, b, von, bis, versatz = 0) => {
  let n = 0;
  for (let y = 0; y < a.length; y++)
    for (let c = von; c < bis; c++) if (a[y][c] !== (b[y][c - versatz] ?? "0")) n++;
  return n;
};
// Der Hauptbereich beginnt bei offener Seitenleiste in Spalte 41 (328 px), sonst in Spalte 6;
// die Seitenleiste ist 35 Spalten (280 px) breit.
const sauber = (bild, erst, letzt, art) => {
  const [von, bis, versatz] = art === "auf" ? [41, 160, 35] : [6, 125, -35];
  return (
    Math.min(
      abstand(bild, letzt, 41, 160),
      abstand(bild, erst, 41, 160),
      abstand(bild, erst, von, bis, versatz),
    ) <= 8
  );
};

const { senden } = kredr;
let bilder = [];
let zeiten = [];
kredr.beiEreignis("Page.screencastFrame", (p) => {
  bilder.push(p.data);
  zeiten.push(p.metadata.timestamp);
  senden("Page.screencastFrameAck", { sessionId: p.sessionId });
});
await senden("Page.enable");
await senden("Emulation.setCPUThrottlingRate", { rate: Number(process.env.BREMSE ?? 6) });
if (process.env.ZEIGEN) mkdirSync("bilder-umbruch", { recursive: true });
let schlecht = 0;
let klicks = 0;
for (let runde = 0; runde < runden; runde++) {
  for (const art of ["zu", "auf"]) {
    await warte(600);
    bilder = [];
    zeiten = [];
    await senden("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    await warte(300);
    const klick = Date.now() / 1000;
    await auswerten(`${agenten}.click()`);
    await warte(1500);
    await senden("Page.stopScreencast");
    const r = [];
    for (const bild of bilder) r.push(await raster(bild));
    let kaputt = 0;
    for (let j = 1; j < r.length - 1; j++) {
      if (sauber(r[j], r[0], r[r.length - 1], art)) continue;
      kaputt++;
      if (process.env.ZEIGEN)
        console.log(`  Zwischenbild ${j}, +${Math.round((zeiten[j] - klick) * 1000)} ms`);
    }
    if (process.env.ZEIGEN)
      bilder.forEach((b, j) =>
        writeFileSync(
          `bilder-umbruch/${runde}-${art}-${String(j).padStart(3, "0")}.jpg`,
          Buffer.from(b, "base64"),
        ),
      );
    console.log(`Runde ${runde} ${art}: ${bilder.length} Bilder, ${kaputt} Zwischenbilder`);
    klicks++;
    if (kaputt > 0) schlecht++;
  }
}
await senden("Emulation.setCPUThrottlingRate", { rate: 1 });
console.log(`${schlecht} von ${klicks} Klicks mit Zwischenbildern`);
console.log(schlecht ? "ROT: Terminal flackert beim Umbruch" : "GRÜN: keine Zwischenbilder");
process.exit(schlecht ? 1 : 0);
