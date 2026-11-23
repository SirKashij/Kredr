# Agenten aus dem Terminal über eine Shell-Funktion `claude`

Ruft die Person in einem gewöhnlichen Terminal `claude` auf, wird das Terminal zum Agenten, gleichwertig mit einem, den Kredr startet. Dafür legt Kredr beim Start jedes Terminals, in PowerShell wie in Git Bash, eine Shell-Funktion `claude` an. Sie ruft das installierte Programm `claude` mit der Konfigurationsdatei des Terminals (`--settings`) auf. Diese Datei legt Kredr für jedes Terminal vorab an. Zur Datei gehört ein Befehls-Hook für `SessionStart`, damit das Terminal schon beim Start zum Agenten wird und nicht erst beim ersten Prompt. Per HTTP meldet Claude Code `SessionStart` nicht. Aufrufe ohne Sitzung (`-p`, `--version`, Unterbefehle) machen das Terminal nicht zum Agenten. Endet die Sitzung, ist der Tab wieder ein gewöhnliches Terminal. Das gilt für alle Agenten.

## Erwogene Alternativen

- **Hooks global in `~/.claude/settings.json` eintragen**: Das würde jeden Aufruf erfassen, auch `claude.exe`, volle Pfade und verschachtelte Shells. Verworfen, weil Kredr die Einstellungen von Claude Code bisher weder liest noch schreibt und die Hooks dann auch außerhalb von Kredr liefen.
- **Nur den Prozess `claude` im Terminal erkennen**: Ohne Hooks gibt es weder Agentenstatus noch Gespräch, also auch kein Fortsetzen. Verworfen, weil der Agent voll gleichwertig sein soll.

## Folgen

- Kredrs Funktion verdeckt einen Alias oder eine Funktion `claude` aus dem Profil der Person. Sie ruft immer das installierte Programm auf.
- Ein Aufruf über `claude.exe`, einen vollen Pfad oder eine im Terminal gestartete weitere Shell (`cmd`, `pwsh`) bleibt ein gewöhnliches Terminal.
- Endet Claude Code ohne `SessionEnd`, etwa durch einen Absturz oder ein hartes Beenden, merkt Kredr das, weil in der Shell kein Kindprozess mehr läuft. Geprüft wird alle paar Sekunden, mit einem Prozess-Schnappschuss für alle Agenten zusammen. Eine Meldung der Shell-Funktion nach der Rückkehr von `claude` wäre ohne Zeitgeber ausgekommen. Wir haben uns trotzdem für die Prüfung entschieden.
- Beim nächsten Öffnen setzt Kredr das Gespräch mit dem Startbefehl aus den Einstellungen fort. Selbst getippte Argumente merkt es sich nicht.
