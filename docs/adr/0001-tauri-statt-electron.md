# Tauri statt Electron als Fundament

Kredr baut auf Tauri auf (Rust-Unterbau, das in Windows eingebaute WebView2 als Oberfläche), nicht auf Electron. Das wichtigste Ziel ist, schneller und schlanker als VS Code zu sein, und Electron bringt mit seinem eigenen Chrome-Browser genau den Ballast mit, den Kredr vermeiden soll. Tauris größte Schwäche, das je nach Betriebssystem unterschiedliche Verhalten der System-Webansicht, greift nicht, solange Kredr nur Windows 11 unterstützt.

## Erwogene Alternativen

- **Electron**: am besten erprobt, Grundlage von VS Code selbst, Monaco und xterm.js sind dort zu Hause. Verworfen wegen Größe, Speicherverbrauch und Startzeit.

## Folgen

- Monaco (Dateiansicht) und xterm.js (Terminal) laufen in WebView2 statt in dem Chrome, für das sie hauptsächlich getestet werden.
- Sollte Kredr später macOS oder Linux unterstützen, muss das Verhalten der dortigen System-Webansichten eigens geprüft werden; diese Entscheidung ist dann neu zu bewerten.
