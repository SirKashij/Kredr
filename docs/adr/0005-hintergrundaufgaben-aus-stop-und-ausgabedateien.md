# Hintergrundaufgaben aus `Stop` und den Ausgabedateien von Claude Code

Ein Agent steht auf „im Hintergrund“, wenn er fertig ist, aber noch eine Hintergrundaufgabe läuft. Welche das sind, übernimmt Kredr aus Claude Code, statt sie selbst mitzuzählen: Jedes `Stop` bringt die vollständige Liste `background_tasks` mit (alle Typen außer `subagent`), und `PostToolUse` mit `backgroundTaskId` nimmt eine Aufgabe schon beim Start auf, falls die Person die Antwort danach abbricht. Bricht die Person eine Aufgabe über `/tasks` ab, meldet Claude Code (2.1.330) nichts. Deshalb beobachtet Kredr zu jeder laufenden Aufgabe deren Ausgabedatei unter `%TEMP%\claude\…\<session_id>\tasks\<id>.output`. Endet sie auf `[killed]` oder verschwindet sie, ist die Aufgabe vorbei. Der Gesprächsordner trägt die Kennung des Gesprächs, mit dem Claude Code startete; nach `/clear` passt er nicht mehr zur `session_id`, und Kredr sucht die Datei über ihre Kennung in allen Gesprächsordnern. Findet Kredr die Datei nicht, sucht es alle paar Sekunden erneut.

## Erwogene Alternativen

- **Falsche Anzeige bis zum nächsten `Stop` hinnehmen**: Das ist einfach, aber der Agent stünde nach einem Abbruch über `/tasks` beliebig lange auf „im Hintergrund“. Verworfen, weil die Anzeige stimmen soll.
- **Prozesse des Agenten prüfen**: Welcher Prozess zu welcher Aufgabe gehört, lässt sich nicht verlässlich zuordnen. Verworfen.

## Folgen

- Ausgabedatei und `[killed]` sind kein zugesichertes Verhalten von Claude Code. Ein Test hält das Format fest. Ändert eine neue Version es, fällt Kredr zurück auf das, was das nächste `Stop` meldet.
- Hintergrund-Subagenten erscheinen weiter nur als Subagenten, nicht als Hintergrundaufgabe. Geplante Aufgaben (`session_crons`, ScheduleWakeup) zählen nicht dazu.
