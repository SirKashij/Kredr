# Workspaces liegen in Kredr, und ihre Aufteilung wird nicht zusammengeführt

Ein Fenster kann mehrere Projekte als Workspace zeigen. Kredr bewahrt Workspaces selbst auf, genauso wie die Liste der zuletzt geöffneten Projekte und die Aufteilung, und nicht als Datei im Projekt. Kommt zu einem Fenster ein Projekt hinzu, behält der Workspace die laufende Aufteilung. Die gespeicherte Aufteilung des neuen Projekts samt seinen Agenten wird nicht eingemischt. Jedes Projekt und jeder Workspace hat also seine eigene Aufteilung, und ein Projekt ist höchstens in einem Fenster offen. Vorbild ist der Multi-Root-Workspace von VS Code.

## Erwogene Alternativen

- **Workspace als Datei** (wie `.code-workspace`): Man könnte sie einchecken und weitergeben. Verworfen, weil Kredr ein persönliches Werkzeug ist. Eine Datei bringt Pfade, die auf anderen Rechnern nicht stimmen, und die Frage, wohin sie gehört, ohne dass jemand sie braucht. Ein Export lässt sich später ergänzen.
- **Aufteilung beim Hinzufügen zusammenführen**: Die Tabs und Agenten des neuen Projekts erscheinen dann als eigene Gruppe. Verworfen, weil dieselben Gespräche danach zu zwei Aufteilungen gehören würden. Öffnet die Person das Projekt später wieder allein, würden Agenten doppelt fortgesetzt.

## Folgen

- Fügt man ein Projekt hinzu, kommen seine früheren Agenten nicht von selbst zurück. Ihre Gespräche bleiben aber erhalten und lassen sich fortsetzen.
- Entfernt man ein Projekt aus dem Workspace, schließen seine Tabs und Terminals. Laufen dort Agenten, fragt Kredr vorher nach, wie beim Schließen eines Fensters. Die Gespräche seiner Agenten wandern in die eigene Aufteilung des Projekts, jedes nur einmal. Öffnet man das Projekt danach allein, gehen sie dort weiter. Sie gehören dann zu genau einer Aufteilung, und nichts wird doppelt fortgesetzt.
- Workspaces wandern nicht mit dem Repository auf andere Rechner.
