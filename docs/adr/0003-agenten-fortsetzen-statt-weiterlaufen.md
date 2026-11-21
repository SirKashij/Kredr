# Agenten kommen durch Fortsetzen zurück, nicht durch Weiterlaufen

Schließt die Person ein Fenster, enden die Prozesse seiner Terminals wie bisher. Kredr merkt sich zu jedem Agenten sein Gespräch und startet ihn beim nächsten Öffnen des Projekts am alten Platz mit diesem Gespräch neu (`claude --resume`). Einen Hintergrunddienst, der Terminals bei geschlossenem Fenster am Leben hält, gibt es nicht. Vorbild für den Wunsch war Herdr, bei dem nach einer Pause dieselben Agenten wieder da sind.

## Erwogene Alternativen

- **Weiterlaufen im Hintergrund**: Ein eigener Prozess hält die Terminals, das Fenster hängt sich nur ab und wieder an. Agenten arbeiten dann auch bei geschlossenem Fenster weiter, und die bisherige Ausgabe bleibt erhalten. Verworfen, weil es die Terminals aus dem Kredr-Prozess herauslöst (eigener Dienst, eigene Lebensdauer, Aktualisierung bei laufendem Dienst), einen Neustart des Rechners trotzdem nicht übersteht und der eigentliche Wunsch „nach der Pause weitermachen“ auch ohne das erfüllt ist.

## Folgen

- Ein Agent, der beim Schließen arbeitet, wird unterbrochen; der laufende Schritt geht verloren. Deshalb fragt das Fenster in diesem Fall nach und kennzeichnet den Agenten nach dem Öffnen als unterbrochen. Er arbeitet nicht von selbst weiter.
- Das Wiederherstellen übersteht auch Absturz und Neustart des Rechners, weil nichts im Arbeitsspeicher überdauern muss: Das Gespräch wird gespeichert, sobald Kredr es kennt.
- Kredr hängt davon ab, dass der Agent sein Gespräch selbst aufbewahrt und fortsetzen kann. Fehlt es, bleibt das Terminal mit der Fehlermeldung des Agenten stehen.
- Die Ausgabe gewöhnlicher Terminals kommt nicht zurück; dafür wäre der verworfene Weg nötig.
- Wird später gewünscht, dass Agenten bei geschlossenem Fenster weiterarbeiten, ist diese Entscheidung neu zu bewerten.
