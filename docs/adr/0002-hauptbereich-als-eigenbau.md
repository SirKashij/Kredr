# Hauptbereich als Eigenbau statt Docking-Bibliothek

Der teilbare Hauptbereich (Gruppen, Tabs, Trennlinien) ist selbst gebaut: Die Aufteilung ist ein reines Zustandsmodell in `src/arrangement.ts`, die Oberfläche zeichnet es nur. Das Spec für Version 1 bevorzugte eine fertige Docking-Bibliothek, verlangt aber zugleich die Aufteilung als eigenes, serialisierbares und versioniertes Zustandsmodell mit benannten, als reine Zustandsänderung getesteten Operationen. Jede geprüfte Bibliothek hält ihren Zustand selbst; ein eigenes Modell daneben wäre eine zweite Wahrheit, die ständig abgeglichen werden müsste. Diese Entscheidung ersetzt die Vorliebe des Specs.

## Erwogene Alternativen

Geprüft im November 2026, jeweils in der damals aktuellen Version.

- **dockview** (8.9.1): deckt Teilen, Tabs, Trennlinien und Ziehen per Maus ab. Verworfen, weil sein Zustand ein DOM braucht (ohne Fenster nicht erzeugbar) und nur über eine befehlsartige Schnittstelle steuerbar ist; rund 400 KB minifizierter Code.
- **flexlayout-react** (0.11.2): deckt dieselben Funktionen ab und hat ein Modell ohne DOM. Verworfen, weil dieses Modell veränderlich ist, Zufallskennungen vergibt und ein eigenes JSON-Format hat, das unsere Tests und unsere gespeicherte Aufteilung an fremden Code binden würde.
- **rc-dock** (4.1.0): verworfen wegen sechs weiterer Abhängigkeiten bei gleichem Grundproblem.

Beide Bibliotheken, die infrage kamen, ziehen Tabs über HTML5-Drag-and-drop. Das funktioniert in Tauri unter Windows nur, wenn die Datei-Ablage des Fensters abgeschaltet wird.

## Folgen

- Jede Änderung der Aufteilung ist eine reine Funktion in `src/arrangement.ts` mit eigenem Test. Neue Bedienwege (Ziehen per Maus, Wiederherstellen) kommen als weitere Operationen dort hinzu, nicht als Zustand in der Oberfläche.
- Terminals leben unabhängig von ihrer Anzeige (`src/runningTerminals.ts`) und werden beim Umbau der Aufteilung nur umgehängt. Deshalb behalten sie Inhalt und Prozess.
- Das Ziehen von Tabs per Maus ist selbst zu bauen, mit Zeigerereignissen statt HTML5-Drag-and-drop.
- Erweist sich das Ziehen als deutlich aufwendiger als erwartet, ist flexlayout-react die Rückfalloption; das eigene Modell ließe sich auf dessen Format abbilden. Diese Entscheidung ist dann neu zu bewerten.
