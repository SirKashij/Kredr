// Steuert die laufende Entwicklungsfassung von Kredr über das Chrome DevTools Protocol.
// Verbindet sich mit dem Port aus start.ps1 und sammelt dabei Ausnahmen und console.error.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Der Port, den start.ps1 zuletzt vergeben hat. */
function laufenderPort() {
  try {
    const datei = join(tmpdir(), "kredr-steuern", "laufend.json");
    return JSON.parse(readFileSync(datei, "utf8").replace(/^﻿/, "")).port;
  } catch {
    return 9333;
  }
}

/** Die Oberfläche ist verschwunden: Eine ungefangene Ausnahme hat `#root` geleert. */
export class GrauerScreen extends Error {
  constructor(fehler) {
    super("Grauer Screen: " + (fehler[0]?.split("\n")[0] ?? "ohne Fehlermeldung"));
    this.fehler = [...fehler];
  }
}

export async function verbinden({ port = laufenderPort() } = {}) {
  const ziele = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const seite = ziele.find((z) => z.type === "page" && z.url.includes("localhost:1420"));
  if (!seite) throw new Error("Keine Kredr-Seite auf Port " + port);

  const ws = new WebSocket(seite.webSocketDebuggerUrl);
  await new Promise((fertig, fehler) => {
    ws.addEventListener("open", fertig);
    ws.addEventListener("error", fehler);
  });

  let naechste = 1;
  const offen = new Map();
  /** Ausnahmen und console.error seit dem Verbinden oder dem letzten Neuladen. */
  const fehler = [];
  ws.addEventListener("message", (ereignis) => {
    const m = JSON.parse(ereignis.data);
    if (m.id && offen.has(m.id)) {
      offen.get(m.id)(m);
      offen.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      fehler.push(d.exception?.description ?? d.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      fehler.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });

  const senden = (method, params = {}) =>
    new Promise((fertig, scheitern) => {
      const id = naechste++;
      offen.set(id, (m) => (m.error ? scheitern(new Error(m.error.message)) : fertig(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await senden("Runtime.enable");
  await senden("Page.enable");

  /** Wertet JavaScript in der Seite aus und gibt den Wert zurück (Promises werden abgewartet). */
  async function auswerten(ausdruck) {
    const r = await senden("Runtime.evaluate", {
      expression: ausdruck,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /**
   * Wartet, bis `bedingung` (JavaScript in der Seite) wahr ist. Verschwindet dabei die
   * Oberfläche, wirft es sofort einen `GrauerScreen` mit den gesammelten Fehlern.
   */
  async function warten(bedingung, { zeit = 10000 } = {}) {
    const bis = Date.now() + zeit;
    while (Date.now() < bis) {
      const [erfuellt, steht] = await auswerten(
        `[!!(${bedingung}), !!document.querySelector("#root .workbench")]`,
      );
      if (erfuellt) return;
      if (!steht && fehler.length > 0) throw new GrauerScreen(fehler);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Zeitüberschreitung beim Warten auf: ${bedingung}`);
  }

  /** Wartet auf das erste Element zum CSS-Selektor und klickt es. */
  async function klicken(selektor) {
    const s = JSON.stringify(selektor);
    await warten(`document.querySelector(${s})`);
    await auswerten(`document.querySelector(${s}).click()`);
  }

  return {
    auswerten,
    warten,
    klicken,
    fehler,
    /** Lädt die Oberfläche neu; laufende Terminals im Kern bleiben bestehen. */
    async neuLaden() {
      fehler.length = 0;
      await senden("Page.reload", { ignoreCache: true });
      await warten(`document.querySelector("#root .workbench")`, { zeit: 20000 });
    },
    /** Ob die Oberfläche noch steht; nach einer ungefangenen Ausnahme ist #root leer (grauer Screen). */
    steht: () => auswerten(`!!document.querySelector("#root .workbench")`),
    async bildschirmfoto(pfad) {
      const { data } = await senden("Page.captureScreenshot", { format: "png" });
      writeFileSync(pfad, Buffer.from(data, "base64"));
    },
    schliessen: () => ws.close(),
  };
}
