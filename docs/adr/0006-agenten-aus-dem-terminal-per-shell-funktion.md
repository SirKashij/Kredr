# Agenten aus dem Terminal über eine Shell-Funktion `claude`

Ruft die Person in einem gewöhnlichen Terminal `claude` auf, wird das Terminal zum Agenten, gleichwertig mit einem, den Kredr startet. Dafür legt Kredr beim Start jedes Terminals, in PowerShell wie in Git Bash, eine Shell-Funktion `claude` an. Sie ruft das installierte Programm `claude` mit der Konfigurationsdatei des Terminals (`--settings`) auf. Diese Datei legt Kredr für jedes Terminal vorab an. Zur Datei gehört ein Befehls-Hook für `SessionStart`, damit das Terminal schon beim Start zum Agenten wird und nicht erst beim ersten Prompt. Per HTTP meldet Claude Code `SessionStart` nicht. Aufrufe ohne Sitzung (`-p`, `--version`, Unterbefehle) machen das Terminal nicht zum Agenten. Endet die Sitzung, ist der Tab wieder ein gewöhnliches Terminal. Das gilt für alle Agenten.

## Erwogene Alternativen

- **Hooks global in `~/.claude/settings.json` eintragen**: Das würde jeden Aufruf erfassen, auch `claude.exe`, volle Pfade und verschachtelte Shells. Verworfen, weil Kredr die Einstellungen von Claude Code bisher weder liest noch schreibt und die Hooks dann auch außerhalb von Kredr liefen.
- **Nur den Prozess `claude` im Terminal erkennen**: Ohne Hooks gibt es weder Agentenstatus noch Gespräch, also auch kein Fortsetzen. Verworfen, weil der Agent voll gleichwertig sein soll.

## Folgen

- Kredrs Funktion verdeckt einen Alias oder eine Funktion `claude` aus dem Profil der Person. Sie ruft immer das installierte Programm auf.
- Als Unterbefehl gilt ein erstes Argument aus einem einzigen kleingeschriebenen Wort (`mcp`, `update`, `setup-token`). Ein Prompt als erstes Argument (`claude "erkläre das"`) bleibt so ein Agent. Eine feste Liste der Unterbefehle wurde verworfen, weil sie bei jedem neuen Befehl von Claude Code veralten würde. In Kauf genommen: Ein Prompt aus einem einzigen kleingeschriebenen Wort (`claude hallo`) wird kein Agent, ebenso `claude attach <id>`, obwohl es eine Sitzung im Tab öffnet.
- Ein Aufruf über `claude.exe`, einen vollen Pfad oder eine im Terminal gestartete weitere Shell (`cmd`, `pwsh`) bleibt ein gewöhnliches Terminal.
- Endet Claude Code ohne `SessionEnd`, etwa durch einen Absturz oder ein hartes Beenden, meldet die Shell-Funktion nach der Rückkehr von `claude` das Ende selbst, auch bei Strg+C (`finally` in PowerShell, `trap` in Git Bash). Deshalb startet Kredr auch seine eigenen Agenten über diese Funktion. Verworfen wurde, alle paar Sekunden zu prüfen, ob in der Shell noch ein Kindprozess läuft. Die Prüfung meldet verspätet. Startet die Person nach einem Absturz sofort ein anderes Programm, sieht sie das Ende nie. Fremde Kindprozesse, etwa aus dem Profil, verdecken das Ende. Und ein gerade fortgesetzter Agent bräuchte eine Schonfrist. Die Prüfung erfasst auch keine Fälle, die die Funktion verfehlt: Ohne die Funktion gibt es keine Hooks und damit keinen Agenten.
- Beim nächsten Öffnen setzt Kredr das Gespräch mit dem Startbefehl aus den Einstellungen fort. Selbst getippte Argumente merkt es sich nicht.
