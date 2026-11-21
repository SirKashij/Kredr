# Kredr

Kredr ist eine schlanke Arbeitsfläche für Windows, in der eine Person mehrere Claude-Code-Agenten in Terminals steuert, die Dateien eines Projekts durchsieht und Änderungen über die Versionskontrolle festschreibt.

## Sprache

**Projekt**:
Ein Ordner auf der Festplatte, an dem gearbeitet wird; in der Regel ein Git-Repository.
_Vermeiden_: Workspace, Arbeitsbereich, Repo

**Fenster**:
Die Ansicht genau eines Projekts. Mehrere Projekte bedeuten mehrere Fenster.
_Vermeiden_: Instanz, Sitzung

**Hauptbereich**:
Die zentrale Fläche eines Fensters, in der Terminals und Dateien als Tabs liegen und die sich frei teilen lässt. Ein separates unteres Panel gibt es nicht.
_Vermeiden_: Editorbereich, Panel

**Gruppe**:
Ein Teilstück des geteilten Hauptbereichs mit eigener Tab-Leiste.
_Vermeiden_: Pane, Split, Spalte

**Terminal**:
Ein Tab im Hauptbereich, in dem eine Shell läuft (standardmäßig PowerShell).
_Vermeiden_: Konsole, Shell-Fenster

**Agent**:
Eine Claude-Code-Sitzung, die in einem Terminal läuft.
_Vermeiden_: Bot, KI, Claude-Terminal

**Subagent**:
Ein Helfer, den ein Agent für eine Teilaufgabe startet. Er läuft im Terminal seines Agenten, hat kein eigenes Gespräch und endet mit seiner Teilaufgabe.
_Vermeiden_: Unteragent, Kind-Agent, Task, Hauptagent (für den Agenten darüber)

**Gespräch**:
Der Verlauf eines Agenten mit der Person. Es überdauert das Ende seines Prozesses und lässt sich fortsetzen; leert die Person es, beginnt ein neues.
_Vermeiden_: Sitzung, Session, Chat

**Auftrag**:
Der erste Prompt, den ein Agent seit seinem Start oder dem letzten Leeren des Gesprächs bekommen hat. Er steht am Tab und in der Agenten-Ansicht, solange die Person dem Terminal keinen eigenen Namen gegeben hat; ein eigener Name geht immer vor.
_Vermeiden_: Titel, Sitzungsname, erster Prompt

**Agentenstatus**:
Der Zustand eines Agenten aus Sicht der Person: arbeitet, ist fertig oder wartet auf Eingabe.

**Agenten-Ansicht**:
Die Übersicht aller Agenten und Terminals eines Fensters in der Seitenleiste, jeweils mit Agentenstatus.
_Vermeiden_: Agentenliste, Agenten-Leiste, Dashboard

**Aufteilung**:
Die Anordnung der Gruppen und Terminals eines Fensters samt Namen, Startordnern und den Gesprächen der Agenten; sie wird pro Projekt gespeichert und beim Öffnen wiederhergestellt. Laufende Prozesse gehören nicht dazu: Ein Agent kommt zurück, indem sein Gespräch fortgesetzt wird.
_Vermeiden_: Layout, Sitzungszustand

**Dateiansicht**:
Ein Tab im Hauptbereich, der eine Datei mit Syntaxfarben zeigt und einfache Korrekturen erlaubt.
_Vermeiden_: Editor

**Vorschau-Tab**:
Ein Tab, der eine Datei nur zum Durchsehen zeigt und von der nächsten so geöffneten Datei ersetzt wird. Ein Doppelklick oder eine Bearbeitung macht ihn dauerhaft.
_Vermeiden_: temporärer Tab, Preview

**Markdown-Vorschau**:
Ein Tab im Hauptbereich, der eine Markdown-Datei gerendert zeigt statt als Quelltext. Nicht zu verwechseln mit dem Vorschau-Tab.
_Vermeiden_: Preview, gerenderte Ansicht

**Versionskontrolle**:
Die Ansicht, in der Änderungen eines Projekts geprüft, festgeschrieben und mit GitHub abgeglichen werden.
_Vermeiden_: Source Control, Git-Panel

**Änderung**:
Eine geänderte, neue, gelöschte oder umbenannte Datei des Projekts gegenüber dem letzten Commit. Eine Änderung ist ausgewählt, wenn sie in den nächsten Commit kommt. Im Code und in der englischen Oberfläche heißt „ausgewählt“ wie in Git „staged“, „auswählen“ „stage“.
_Vermeiden_: gestagt, Stage, Index
