# Kredr

Kredr ist eine schlanke Arbeitsfläche für Windows, in der eine Person mehrere Claude-Code-Agenten in Terminals steuert, die Dateien eines Projekts durchsieht und Änderungen über die Versionskontrolle festschreibt.

## Sprache

**Projekt**:
Ein Ordner auf der Festplatte, an dem gearbeitet wird; in der Regel ein Git-Repository.
_Vermeiden_: Arbeitsbereich, Repo, Ordner (für das Projekt als Ganzes)

**Workspace**:
Eine gespeicherte Zusammenstellung mehrerer Projekte, die zusammen in einem Fenster geöffnet werden. Kommt zu einem Fenster ein zweites Projekt hinzu, entsteht ein unbenannter Workspace, den die Person benennen kann.
_Vermeiden_: Arbeitsbereich, Projektgruppe, Sammlung

**Fenster**:
Die Ansicht eines einzelnen Projekts oder eines Workspace. Es lassen sich mehrere Fenster nebeneinander öffnen.
_Vermeiden_: Instanz, Sitzung

**Fensterinhalt**:
Was ein Fenster gerade zeigt: die Startseite, ein einzelnes Projekt oder einen Workspace. Zusammen mit der Aufteilung bestimmt er, was die Person im Fenster sieht. Er wechselt, wenn die Person ein Projekt hinzufügt oder entfernt oder einen Workspace öffnet oder schließt.
_Vermeiden_: Fensterzustand, Fenstermodus

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
Eine Claude-Code-Sitzung, die in einem Terminal läuft, gleich ob Kredr sie gestartet oder die Person `claude` im Terminal aufgerufen hat. Ein Aufruf ohne Sitzung, etwa `claude -p` oder `claude --version`, ist kein Agent. Endet die Sitzung, ist das Terminal wieder ein gewöhnliches Terminal.
_Vermeiden_: Bot, KI, Claude-Terminal, manueller Agent

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
Der Zustand eines Agenten aus Sicht der Person: arbeitet, wartet auf Eingabe, ist im Hintergrund (fertig, aber eine Hintergrundaufgabe läuft noch) oder ist fertig. „Wartet“ heißt immer, dass die Person gefragt ist.
_Vermeiden_: wartet (für einen Agenten, der nur auf eine Hintergrundaufgabe wartet)

**Hintergrundaufgabe**:
Etwas, das ein Agent gestartet hat und das nach seiner Antwort weiterläuft, etwa eine Shell, die einen CI-Lauf beobachtet. Endet sie, macht der Agent von selbst weiter. Subagenten und geplante Aufgaben zählen nicht dazu.
_Vermeiden_: Hintergrundprozess, Job, Task

**Ausgabedatei**:
Die Datei, in die Claude Code die Ausgabe einer Hintergrundaufgabe schreibt. An ihrem Ende erkennt Kredr, dass die Person die Aufgabe abgebrochen hat. Sie liegt im Gesprächsordner, den Claude Code nach dem Gespräch benennt, mit dem der Agent startete.
_Vermeiden_: Logdatei, Output-Datei

**Agenten-Ansicht**:
Die Übersicht aller Agenten und Terminals eines Fensters in der Seitenleiste, jeweils mit Agentenstatus und nach Projekten gruppiert. Ein Terminal gehört zu dem Projekt, in dessen Ordner es gestartet wurde. Liegt der Startordner in keinem Projekt, steht es unter „Außerhalb der Projekte“.
_Vermeiden_: Agentenliste, Agenten-Leiste, Dashboard

**Aufteilung**:
Die Anordnung der Gruppen und Terminals eines Fensters samt Namen, Startordnern und den Gesprächen der Agenten, dazu welche Abschnitte der Agenten-Ansicht und der Versionskontrolle zugeklappt und welche Repositories der Versionskontrolle ausgeblendet sind; sie wird pro Projekt bzw. pro Workspace gespeichert und beim Öffnen wiederhergestellt. Laufende Prozesse gehören nicht dazu: Ein Agent kommt zurück, indem sein Gespräch fortgesetzt wird.
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

**Hinweis**:
Eine kurze Meldung unten rechts im Fenster. Ein gewöhnlicher Hinweis verschwindet nach 8 s oder wenn die Person ihn schließt. Ein stehender Hinweis bleibt, bis eine seiner Aktionen ihn erledigt, etwa das Angebot einer neuen Version. Im Code heißt er `PinnedNotice`.
_Vermeiden_: Toast, Popup, Benachrichtigung (das ist die Meldung von Windows)

**Aktualisierung**:
Der Wechsel der installierten Kredr-Fassung auf eine neue Version. Kredr bietet sie an, die Person löst sie aus, danach startet Kredr neu.
_Vermeiden_: Update, Upgrade, Patch

**Neue Version**:
Ein veröffentlichtes, stabiles Release, das neuer ist als die installierte Fassung. Entwürfe und Vorabversionen zählen nicht.
_Vermeiden_: Update (für die Version selbst), Build

**Neuerungen**:
Die Release-Seite einer neuen Version auf GitHub mit ihrem Release-Text. Kredr öffnet sie im Browser.
_Vermeiden_: Changelog, Release Notes, Patchnotes

**Abgelehnte Version**:
Die neue Version, die die Person mit „Später“ aufgeschoben hat. Kredr merkt sie sich im Benutzerdatenverzeichnis und bietet sie nicht wieder als Hinweis an, auch nach einem Neustart nicht; eine andere neue Version schon. Im Code heißt sie `declined`.
_Vermeiden_: ignorierte Version, übersprungene Version

**Symbol der Aktualisierung**:
Der Pfeil nach oben mit Punkt unmittelbar über dem Zahnrad der Aktivitätsleiste. Er steht nach „Später“ oder einem Fehlschlag, bis aktualisiert ist, und öffnet ein Menü zum Aktualisieren und zu den Neuerungen. Im Code heißt er `AppUpdateButton`.
_Vermeiden_: Badge, Update-Icon

**Anlass**:
Etwas, das beim Beenden eines Fensters verloren ginge oder abbräche: eine ungespeicherte Datei, ein laufender Prozess in einem Terminal, ein arbeitender Agent oder ein Agent im Hintergrund. Vor der Aktualisierung zählt auch ein Fenster, das seine Anlässe nicht nennt. Gibt es Anlässe, fragt Kredr nach. Im Code heißen sie `UpdateReasons`.
_Vermeiden_: Grund, Blocker, Warnung

**Rückfrage vor der Aktualisierung**:
Der eine Dialog, der vor einer Aktualisierung die Anlässe aller Fenster zusammengezählt nennt, mit „Später“ (bricht ab) und „Trotzdem aktualisieren“. Ohne Anlass entfällt er.
_Vermeiden_: Warnung, Popup

**Rundfrage**:
Ein Fenster fragt alle offenen Fenster etwas und sammelt ihre Antworten, etwa die Anlässe oder „Aufteilung gespeichert“. Ein Fenster, das nicht rechtzeitig antwortet, gilt als stumm. Im Code heißt sie `pollWindows`.
_Vermeiden_: Broadcast, Umfrage
