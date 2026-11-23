# Coding Standards

Regeln für das Review. Hier stehen nur Ermessensfragen, die kein Werkzeug prüfen kann. Formatierung, Typen und Lints prüft `npm run check`.

## Eine Aktion entsteht an einem Ort

Menüs, Befehle und Beschriftungen für dasselbe Objekt (Projekt, Datei, Tab, Workspace) kommen aus einer gemeinsamen Funktion. Wo immer sie erscheinen, zeigen sie dieselben Einträge in derselben Reihenfolge.

_Warum:_ In #57 entstand in `Sidebar.tsx` ein zweites Projektmenü neben dem aus `Explorer.tsx`. Beide liefen sofort auseinander, mit anderer Reihenfolge, fehlenden Einträgen und anderen Trennlinien.

## Ein reines Modul hat einen fachlichen Grund

Reine Module wie `workspace.ts`, `filePath.ts` und `arrangement.ts` enthalten Funktionen ohne React und ohne Aufrufe an den Kern. Das gilt auch für alles, was sie importieren. Eine neue Funktion kommt in das Modul, dessen Begriff sie behandelt. Passt keines, bekommt sie ein neues Modul daneben.

_Warum:_ `workspace.ts` sammelte die Suchgruppierung und die Schlüssel für Quick Open, und über einen Import aus `project.ts` hing es in #60 am Kern.

## Pfade laufen über `filePath.ts`

Pfade werden mit den Helfern aus `filePath.ts` normalisiert, verglichen und zerlegt. Ein eigenes `replaceAll("\\", "/")` oder ein Abschneiden von Schrägstrichen im Aufrufer ist ein Befund.

_Warum:_ Doppelte Normalisierungen weichen bei Groß- und Kleinschreibung oder bei verschachtelten Projekten voneinander ab.

## Begriffe kommen aus dem Glossar

Bezeichner, Kommentare und Texte der Oberfläche benutzen die Begriffe aus `GLOSSARY.md`. Begriffe unter „Vermeiden“ tauchen nicht auf. Ein neuer Fachbegriff (etwa „Abschnitt“ in der Agenten-Ansicht) wird im Review als Befund gemeldet, damit er ins Glossar kommt.

## Gespeicherter Zustand passt zu seinem Begriff

Was mit einem Begriff gespeichert wird, passt zu dessen Definition im Glossar. Zur **Aufteilung** gehören zum Beispiel Gruppen, Terminals, Namen, Startordner und Gespräche. Ein reiner Anzeigezustand der Seitenleiste gehört nicht dazu. Er bekommt einen eigenen Speicherort, oder das Glossar wird bewusst erweitert.

## Tests prüfen den echten Code

Ein Test ruft die exportierte Funktion auf, die auch die Oberfläche benutzt. Eine Kopie der Logik im Test, etwa eine eigene Beschriftungsfunktion, lässt die Verdrahtung ungeprüft.

_Warum:_ In #60 prüften die Tests ein testeigenes `labelOfTab` statt `contentTabLabel` und `terminalTabLabel`.
