<div align="center">

<img src="src-tauri/icons/icon.png" alt="Kredr-Logo: eine Krähe auf blauem Grund" width="120" height="120">

# Kredr

**Die schlanke Arbeitsfläche für Claude-Code-Agenten unter Windows.**

Mehrere Agenten in Terminals steuern, die Dateien des Projekts durchsehen und Änderungen festschreiben – in einem Fenster, ohne den Ballast eines ausgewachsenen Editors.

[![Prüfen](https://github.com/SirKashij/Kredr/actions/workflows/pruefen.yml/badge.svg)](https://github.com/SirKashij/Kredr/actions/workflows/pruefen.yml)
[![Neueste Fassung](https://img.shields.io/github/v/release/SirKashij/Kredr?include_prereleases&label=Fassung)](https://github.com/SirKashij/Kredr/releases)
![Plattform](https://img.shields.io/badge/Plattform-Windows%2011-0078D4)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)

[Herunterladen](https://github.com/SirKashij/Kredr/releases/latest) · [Funktionen](#funktionen) · [Tastenkürzel](#tastenkürzel) · [Entwickeln](#entwickeln) · [Fehler melden](https://github.com/SirKashij/Kredr/issues)

</div>

<br>

![Kredr mit drei Agenten: einer arbeitet mit zwei Subagenten, einer wartet auf eine Freigabe, einer ist fertig. Daneben eine Datei mit Syntaxfarben.](docs/screenshot.png)

---

## Warum Kredr?

Wer mit mehreren Claude-Code-Agenten gleichzeitig arbeitet, jongliert schnell mit vielen Terminalfenstern und verliert den Überblick, welcher Agent gerade arbeitet, fertig ist oder auf eine Antwort wartet. Kredr bündelt das an einer Stelle:

- **Agenten im Blick.** Die Agenten-Ansicht zeigt für jedes Terminal, ob sein Agent arbeitet, fertig ist oder auf Eingabe wartet – samt seiner Subagenten.
- **Nichts verpassen.** Wartet ein Agent, meldet Kredr das über eine Windows-Benachrichtigung und das Taskleisten-Symbol. Ein Klick führt direkt zum richtigen Tab.
- **Nach der Pause weitermachen.** Schließt du ein Fenster, kommen die Agenten beim nächsten Öffnen am alten Platz mit ihrem Gespräch zurück – auch nach einem Neustart des Rechners.
- **Schnell und schlank.** Kredr baut auf [Tauri](https://tauri.app) und dem in Windows eingebauten WebView2 auf statt auf Electron ([ADR 0001](docs/adr/0001-tauri-statt-electron.md)).

## Funktionen

### Agenten und Terminals

- Neue Agenten per Kürzel (`Strg+Umschalt+A`) oder Terminals mit PowerShell oder Git Bash (`` Strg+Umschalt+` ``)
- Agentenstatus über die Hooks von Claude Code – Kredr liest oder ändert dabei keine Einstellungen von Claude Code
- Subagenten erscheinen unter ihrem Agenten, Rückfragen direkt in ihrer Zeile
- Der Auftrag (der erste Prompt) steht am Tab, solange das Terminal keinen eigenen Namen hat
- Terminal auf Basis von [xterm.js](https://xtermjs.org) mit WebGL-Darstellung

### Hauptbereich

- Frei teilbar in Gruppen mit eigener Tab-Leiste, nach rechts und nach unten
- Die Aufteilung samt Namen, Startordnern und Gesprächen wird pro Projekt gespeichert und beim Öffnen wiederhergestellt
- Ein Fenster je Projekt

### Dateien

- Explorer mit Git-Farben, Schnellöffnen (`Strg+P`) und Suche im ganzen Projekt
- Dateiansicht mit Syntaxfarben und einfachen Korrekturen auf Basis von [Monaco](https://microsoft.github.io/monaco-editor/)
- Markdown-Vorschau und Bildansicht
- Vorschau-Tabs zum schnellen Durchsehen

### Versionskontrolle

- Änderungen prüfen, auswählen und festschreiben
- Diff-Ansicht, Commit-Verlauf und Branches
- Abgleich mit GitHub

### Windows-Integration

- „Mit Kredr öffnen“ im Rechtsklick-Menü des Explorers
- Der Befehl `kredr .` im Terminal öffnet den aktuellen Ordner als Projekt
- Oberfläche auf Deutsch und Englisch

## Installation

1. Den Installer `Kredr_<Version>_x64-setup.exe` von der [Release-Seite](https://github.com/SirKashij/Kredr/releases/latest) herunterladen.
2. Ausführen. Kredr wird für den aktuellen Benutzer installiert, Administratorrechte sind nicht nötig.

> [!NOTE]
> Der Installer ist noch nicht signiert, Windows SmartScreen warnt deshalb beim ersten Start. Über „Weitere Informationen“ → „Trotzdem ausführen“ lässt er sich starten.

### Voraussetzungen

| Was | Wofür |
| --- | --- |
| Windows 11 | Kredr läuft ausschließlich unter Windows 11. |
| [Claude Code](https://docs.claude.com/claude-code) | „Neuer Agent“. Der Startbefehl lässt sich in den Einstellungen ändern. |
| [Git](https://git-scm.com/download/win) | Versionskontrolle und Git Bash. Ohne Git funktioniert der Rest. |

## Tastenkürzel

Die Kürzel folgen den Standardkürzeln von VS Code unter Windows.

| Kürzel | Aktion |
| --- | --- |
| `Strg+Umschalt+A` | Neuer Agent |
| `` Strg+Umschalt+` `` | Neues Terminal |
| `Strg+P` | Datei schnell öffnen |
| `Strg+B` | Seitenleiste ein- und ausblenden |
| `Strg+Umschalt+E` / `F` / `G` | Explorer / Suche / Versionskontrolle |
| `Strg+\` | Nach rechts teilen |
| `Strg+K`, `Strg+\` | Nach unten teilen |
| `Strg+1` … `Strg+8` | Zur Gruppe 1 bis 8 |
| `Strg+K`, `Strg+Pfeiltaste` | Zur Gruppe in dieser Richtung |
| `Strg+Tab` / `Strg+Bild↓` | Nächster Tab |
| `Strg+Umschalt+Tab` / `Strg+Bild↑` | Vorheriger Tab |
| `Strg+W` / `Strg+F4` | Tab schließen |
| `Strg+,` | Einstellungen |

## Entwickeln

### Voraussetzungen

- [Node.js](https://nodejs.org) 24
- [Rust](https://rustup.rs) (stable) mit `rustfmt` und `clippy`
- Die [Voraussetzungen von Tauri für Windows](https://tauri.app/start/prerequisites/) (Microsoft C++ Build Tools, WebView2)

### Befehle

```powershell
git clone https://github.com/SirKashij/Kredr.git
cd Kredr
npm install

npm run tauri dev     # Entwicklung starten
npm run check         # alles prüfen wie die CI: Formatierung, Typen, Tests, Build, Clippy
npm run format        # Oberfläche und Kern formatieren
npm run tauri build   # Installer bauen (src-tauri/target/release/bundle/nsis/)
```

> [!TIP]
> Blockiert die Ausführungsrichtlinie von PowerShell `npm.ps1`, hilft `npm.cmd` statt `npm`.

### Aufbau

| Ordner | Inhalt |
| --- | --- |
| [`src/`](src) | Oberfläche: React 19, TypeScript, Vite, Vitest |
| [`src-tauri/`](src-tauri) | Kern: Rust und Tauri 2 – Terminals, Agentenstatus, Projektdateien, Versionskontrolle |
| [`docs/adr/`](docs/adr) | Architekturentscheidungen |
| [`GLOSSARY.md`](GLOSSARY.md) | Die Begriffe, mit denen Code, Oberfläche und Issues arbeiten |

## Mitmachen

Fehler und Wünsche gehören in die [Issues](https://github.com/SirKashij/Kredr/issues). Für Pull Requests:

1. Kurz in einem Issue abstimmen, worum es geht.
2. Die Begriffe aus dem [Glossar](GLOSSARY.md) verwenden.
3. Vor dem Pull Request `npm run check` laufen lassen – dieselbe Prüfkette läuft in der CI.

## Danksagung

Kredr steht auf den Schultern von [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org), [Monaco](https://microsoft.github.io/monaco-editor/), [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty) und [ripgrep](https://github.com/BurntSushi/ripgrep) (`ignore`, `grep-searcher`).
