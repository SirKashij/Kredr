---
name: kredr-steuern
description: Kredr per Skript starten und bedienen (echte App, CDP). Use when ein Fehler in der Oberfläche nachgestellt werden muss, eine Feedback-Schleife gegen die laufende App gebraucht wird, oder für Screenshots und Konsolenfehler.
---

# Kredr steuern

Startet die Entwicklungsfassung mit Remote-Debugging neben einem installierten Kredr und bedient sie aus Node über das Chrome DevTools Protocol. Das ist die Schleife für Fehler, die nur im Zusammenspiel von Oberfläche und Kern auftreten.

## Schritte

1. `& .claude/skills/kredr-steuern/start.ps1` (PowerShell). Ohne `-Projekt` öffnet Kredr ein frisches Wegwerf-Repo mit einem Commit und einer offenen Änderung. Fertig, wenn „Kredr läuft: …“ erscheint.
2. Ein Skript schreiben, das `verbinden()` aus `cdp.mjs` nutzt; `beispiel.mjs` ist die Vorlage. Mit `neuLaden()` beginnen, dann `klicken`, `warten`, `auswerten`; am Ende `steht()` und `fehler` prüfen, bei Bedarf `bildschirmfoto(pfad)`. Fertig, wenn das Skript per Exit-Code grün oder rot meldet.
3. `& .claude/skills/kredr-steuern/stop.ps1`. Fertig, wenn „Beendet.“ erscheint.

## Gotchas

- **Projekt:** Die Entwicklungsfassung teilt sich mit dem installierten Kredr das App-Datenverzeichnis, also Einstellungen und die gespeicherte Aufteilung je Projekt. Öffne deshalb nur Wegwerf-Projekte; mit `-Projekt` auf ein echtes Repo überschreibt sie dessen Aufteilung.
- **Grauer Screen:** Eine ungefangene Ausnahme leert `#root`; `steht()` meldet dann `false`, und `fehler` enthält den Stack.
- **Neu laden:** `neuLaden()` setzt die Oberfläche zurück, Terminals im Kern laufen weiter. Für einen ganz frischen Zustand stop und start.
- **Selektoren:** Symbolleiste `.actbar > button:nth-child(n)` (1 Agenten, 2 Explorer, 3 Suche, 4 Versionskontrolle), Karten der Agenten-Ansicht `.cards .card`, Tabs `[role=tab]`, Änderungen `.change-row`, Commits im Verlauf `.commit-row`.
- **Alten Stand prüfen:** Vite lädt geänderte Dateien sofort nach. Um zu zeigen, dass die Schleife auf einem älteren Stand rot wird, tausche die Datei atomar (`git show <rev>:<pfad> > tmp && mv -f tmp <pfad>`); ein direktes Umleiten in die Datei erwischt Vite halb geschrieben. Danach `neuLaden()`.
- **Vorbedingungen:** Ein Bug zeigt sich oft nur mit dem passenden Zustand, etwa einem angezeigten Diff oder Commit. Stell ihn im Skript her und prüfe mit `warten`, dass er da ist, bevor du den Auslöser klickst.
