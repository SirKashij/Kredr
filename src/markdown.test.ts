// @vitest-environment jsdom
import { expect, test } from "vitest";
import { codeLanguage, headingSlug, renderMarkdown, resolveImage, resolveLink } from "./markdown";

/** Die gerenderte Vorschau als Dokumentausschnitt, wie sie im Fenster landet. */
function preview(source: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(source);
  return container;
}

test("Überschriften, Hervorhebungen und Listen werden gerendert", () => {
  const dom = preview(
    "# Titel\n\n## Abschnitt\n\nEin *betonter* und **fetter** Text.\n\n- eins\n- zwei\n\n1. erstens\n",
  );

  expect(dom.querySelector("h1")?.textContent).toBe("Titel");
  expect(dom.querySelector("h2")?.textContent).toBe("Abschnitt");
  expect(dom.querySelector("em")?.textContent).toBe("betonter");
  expect(dom.querySelector("strong")?.textContent).toBe("fetter");
  expect([...dom.querySelectorAll("ul > li")].map((item) => item.textContent)).toEqual([
    "eins",
    "zwei",
  ]);
  expect(dom.querySelector("ol > li")?.textContent).toBe("erstens");
});

test("Tabellen werden gerendert und behalten die Ausrichtung ihrer Spalten", () => {
  const dom = preview("| Name | Zahl |\n| :--- | ---: |\n| a | 1 |\n");

  expect([...dom.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Name", "Zahl"]);
  expect([...dom.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["a", "1"]);
  expect(dom.querySelectorAll("td")[1].getAttribute("align")).toBe("right");
});

test("ein Codeblock behält seinen Text wörtlich und nennt seine Sprache", () => {
  const dom = preview('```ts\nconst a = "<b>";\n```\n');

  const block = dom.querySelector("pre")!;
  expect(block.getAttribute("data-lang")).toBe("ts");
  expect(block.querySelector("code")?.textContent).toBe('const a = "<b>";\n');
  expect(block.querySelector("b")).toBeNull();
});

test("Links tragen ihr Ziel, ohne dass das Fenster ihnen von selbst folgen könnte", () => {
  const dom = preview("[Doku](docs/intro.md) und https://example.com/seite");

  const [relative, web] = dom.querySelectorAll("[data-href]");
  expect(relative.textContent).toBe("Doku");
  expect(relative.getAttribute("data-href")).toBe("docs/intro.md");
  expect(web.getAttribute("data-href")).toBe("https://example.com/seite");
  expect(dom.querySelector("[href]")).toBeNull();
});

test("Bilder tragen ihre Quelle, ohne dass das Fenster sie von selbst lädt", () => {
  const dom = preview('![Logo](bilder/logo.png "Titel")');

  const image = dom.querySelector("img")!;
  expect(image.getAttribute("data-src")).toBe("bilder/logo.png");
  expect(image.getAttribute("alt")).toBe("Logo");
  expect(image.hasAttribute("src")).toBe(false);
});

test("Ziel und Quelle lassen sich nicht an der Prüfung vorbei unterschieben", () => {
  const dom = preview(
    '<a href="https://example.com" data-href="javascript:alert(1)">a</a>' +
      '<a data-href="javascript:alert(1)" role="link" tabindex="0">b</a>' +
      '<img src="a.png" data-src="C:/geheim.png"><img data-src="C:/geheim.png">',
  );

  const [checked, smuggled] = dom.querySelectorAll("a");
  expect(checked.getAttribute("data-href")).toBe("https://example.com");
  expect(smuggled.attributes).toHaveLength(0);
  const [image, bare] = dom.querySelectorAll("img");
  expect(image.getAttribute("data-src")).toBe("a.png");
  expect(bare.attributes).toHaveLength(0);
});

test("harmloses HTML in Markdown bleibt erhalten", () => {
  const dom = preview(
    '<details><summary>Mehr</summary>\n\nText<br>\n\n</details>\n\n<p align="center"><img src="a.png" width="80"></p>',
  );

  expect(dom.querySelector("details > summary")?.textContent).toBe("Mehr");
  expect(dom.querySelector("p[align=center] img")?.getAttribute("width")).toBe("80");
});

/** Markdown, das versucht, in Kredr Code auszuführen oder das Fenster zu übernehmen. */
const attacks: Record<string, string> = {
  "Skript-Element": "<script>window.__TAURI_INTERNALS__.invoke('open_url')</script>",
  "Skript mitten im Absatz": "Text <script src=https://evil.example/x.js></script> Text",
  "Ereignis am Bild":
    '<img src="x" onerror="window.__TAURI_INTERNALS__.invoke(\'terminal_write\')">',
  "Ereignis an beliebigem Element": '<div onclick="alert(1)" onmouseover="alert(2)">Klick</div>',
  "Ereignis mit Großschreibung": "<IMG SRC=x OnErRoR=alert(1)>",
  "javascript-Link in HTML": '<a href="javascript:alert(1)">Klick</a>',
  "javascript-Link mit Steuerzeichen": '<a href="java&#9;script:alert(1)">Klick</a>',
  "javascript-Link in Markdown": "[Klick](javascript:alert(1))",
  "javascript-Link als Verweis": "[Klick][a]\n\n[a]: javascript:alert(1)",
  "vbscript-Link": "[Klick](vbscript:msgbox(1))",
  "data-Link mit HTML": "[Klick](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "Bild mit javascript-Quelle": '<img src="javascript:alert(1)">',
  "eingebettetes SVG mit Skript": '<svg onload="alert(1)"><script>alert(2)</script></svg>',
  "SVG mit foreignObject":
    "<svg><foreignObject><iframe srcdoc='<script>alert(1)</script>'></iframe></foreignObject></svg>",
  "MathML-Trick":
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  "eingebettete Seite": '<iframe src="https://evil.example"></iframe>',
  "eingebettete Seite mit srcdoc":
    "<iframe srcdoc=\"<script>parent.__TAURI_INTERNALS__.invoke('x')</script>\"></iframe>",
  "Objekt und Embed": '<object data="x.html"></object><embed src="x.html">',
  Formular: '<form action="https://evil.example"><input name="a"><button>Senden</button></form>',
  "Knopf mit formaction": '<button formaction="javascript:alert(1)">x</button>',
  Weiterleitung: '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  Basisadresse: '<base href="https://evil.example/">',
  Stylesheet: '<link rel="stylesheet" href="https://evil.example/x.css">',
  "Style-Element": "<style>body { display: none } @import 'https://evil.example/x.css';</style>",
  "Style-Attribut":
    '<div style="position:fixed;inset:0;background:url(https://evil.example/x)">x</div>',
  "Klassen der Oberfläche": '<div class="settings workbench">überdeckt alles</div>',
  "Kennung und Name": '<img name="getElementById" id="root"><a id="invoke" name="body">x</a>',
  "Ziel in neuem Fenster": '<a href="https://evil.example" target="_blank">x</a>',
  "Audio und Video":
    '<video src="x" onloadstart="alert(1)"></video><audio src="x" autoplay></audio>',
  "Vorlage und Schattenbaum":
    '<template shadowrootmode="open"><script>alert(1)</script></template>',
  "kaputte Verschachtelung": '<p><a href="x"><script>alert(1)//</a></p>',
  "Skript im Codeblock-Infotext": '```"><script>alert(1)</script>\ncode\n```',
  "Skript im Bildtitel": '![x](a.png "\\"><script>alert(1)</script>")',
  "Skript im Link-Text": "[<script>alert(1)</script>](https://example.com)",
  "noscript-Trick": '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
};

const executable =
  "script, iframe, frame, object, embed, form, input, button, textarea, select, style, link, meta, base, svg, math, template, video, audio, noscript, applet";

for (const [name, source] of Object.entries(attacks)) {
  test(`eingebetteter Code bleibt wirkungslos: ${name}`, () => {
    const dom = preview(source);

    expect(dom.querySelector(executable)).toBeNull();
    for (const element of dom.querySelectorAll("*")) {
      for (const { name: attribute, value } of element.attributes) {
        // Kein Ereignis, nichts, dem das Fenster von selbst folgt, kein fremdes Aussehen.
        expect(attribute).not.toMatch(/^on/i);
        expect(["href", "src", "srcset", "style", "class", "id", "name", "target"]).not.toContain(
          attribute,
        );
        expect(value.replace(/\s/g, "")).not.toMatch(/^(javascript|vbscript|data:text)/i);
      }
    }
  });
}

test("ein Link ins Internet öffnet sich im Browser", () => {
  expect(resolveLink("docs/a.md", "https://example.com/x?y=1#z")).toEqual({
    kind: "web",
    url: "https://example.com/x?y=1#z",
  });
  expect(resolveLink("docs/a.md", "HTTP://example.com")).toEqual({
    kind: "web",
    url: "HTTP://example.com",
  });
});

test("die Sprache eines Codeblocks findet sich über Kennung, Namen oder Dateiendung", () => {
  const languages = [
    { id: "typescript", aliases: ["TypeScript", "ts"], extensions: [".ts", ".tsx"] },
    { id: "shell", aliases: ["Shell", "sh"], extensions: [".sh", ".bash"] },
    { id: "powershell", extensions: [".ps1"] },
  ];

  expect(codeLanguage(languages, "typescript")).toBe("typescript");
  expect(codeLanguage(languages, "TS")).toBe("typescript");
  expect(codeLanguage(languages, "tsx")).toBe("typescript");
  expect(codeLanguage(languages, "bash")).toBe("shell");
  expect(codeLanguage(languages, "ps1")).toBe("powershell");
  expect(codeLanguage(languages, "PowerShell")).toBe("powershell");
  expect(codeLanguage(languages, "klingonisch")).toBeNull();
});

test("ein relativer Link meint eine Datei neben der Markdown-Datei", () => {
  expect(resolveLink("docs/guide/a.md", "b.md")).toEqual({ kind: "file", path: "docs/guide/b.md" });
  expect(resolveLink("docs/guide/a.md", "./bilder/../b.md#abschnitt")).toEqual({
    kind: "file",
    path: "docs/guide/b.md",
  });
  expect(resolveLink("docs/guide/a.md", "../../src/App.tsx")).toEqual({
    kind: "file",
    path: "src/App.tsx",
  });
  expect(resolveLink("README.md", "docs/mit%20leerzeichen.md?roh=1")).toEqual({
    kind: "file",
    path: "docs/mit leerzeichen.md",
  });
});

test("ein Link mit führendem Schrägstrich gilt ab dem Projektordner", () => {
  expect(resolveLink("docs/guide/a.md", "/src/App.tsx")).toEqual({
    kind: "file",
    path: "src/App.tsx",
  });
});

test("ein relativer Link aus einer Datei außerhalb des Projekts bleibt ein voller Pfad", () => {
  expect(resolveLink("C:/Notizen/a.md", "bilder/b.png")).toEqual({
    kind: "file",
    path: "C:/Notizen/bilder/b.png",
  });
  expect(resolveLink("C:/Notizen/a.md", "../../../b.md")).toEqual({
    kind: "file",
    path: "C:/b.md",
  });
});

test("ein Link auf eine Überschrift springt innerhalb der Vorschau", () => {
  expect(resolveLink("README.md", "#erste-schritte")).toEqual({
    kind: "heading",
    slug: "erste-schritte",
  });
  expect(resolveLink("README.md", "#%C3%BCbersicht")).toEqual({
    kind: "heading",
    slug: "übersicht",
  });
});

test("Links mit ausführbarem oder unbekanntem Ziel tun nichts", () => {
  for (const href of [
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "vbscript:x",
    "mailto:a@example.com",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/System32/calc.exe",
    "ms-msdt:/id",
    "search-ms:query=x",
    "blob:https://tauri.localhost/abc",
    "ipc://localhost/terminal_write",
    "//evil.example/x",
    "\\\\server\\freigabe\\x.exe",
    "",
  ]) {
    expect(resolveLink("README.md", href), href).toEqual({ kind: "none" });
  }
});

test("die Sprungmarke einer Überschrift entsteht wie bei GitHub", () => {
  expect(headingSlug("Erste Schritte")).toBe("erste-schritte");
  expect(headingSlug("  Was ist `Kredr`? (kurz) ")).toBe("was-ist-kredr-kurz");
  expect(headingSlug("Übersicht & Ziele")).toBe("übersicht--ziele");
});

test("ein Bild mit relativem Pfad liegt neben der Markdown-Datei", () => {
  expect(resolveImage("docs/a.md", "bilder/logo.png")).toEqual({
    kind: "local",
    path: "docs/bilder/logo.png",
  });
  expect(resolveImage("docs/a.md", "../assets/Mein%20Bild.SVG")).toEqual({
    kind: "local",
    path: "assets/Mein Bild.SVG",
  });
  expect(resolveImage("docs/a.md", "/logo.webp")).toEqual({ kind: "local", path: "logo.webp" });
});

test("ein Bild aus dem Internet wird nicht geladen, nur benannt", () => {
  expect(resolveImage("README.md", "https://example.com/badge.svg")).toEqual({
    kind: "remote",
    url: "https://example.com/badge.svg",
  });
});

test("ein eingebettetes Bild gilt nur mit einem Bild-Medientyp", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  expect(resolveImage("README.md", png)).toEqual({ kind: "inline", url: png });
  expect(resolveImage("README.md", "data:text/html,<script>alert(1)</script>")).toEqual({
    kind: "none",
  });
});

test("als Bild lädt die Vorschau nur Bilddateien", () => {
  for (const src of [
    "geheim.txt",
    "../.env",
    "seite.html",
    "javascript:alert(1)",
    "file:///C:/a.png",
    "//evil.example/a.png",
    "",
  ]) {
    expect(resolveImage("README.md", src), src).toEqual({ kind: "none" });
  }
});
