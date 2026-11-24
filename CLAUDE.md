# Kredr

## Agent skills

### Issue tracker

Aufgaben und Spezifikationen liegen als GitHub Issues in diesem Repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Die fünf Standard-Labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: ein `GLOSSARY.md` und `docs/adr/` im Hauptverzeichnis. See `docs/agents/domain.md`.

### Parallele Worktrees und Integrationszweig

Build-Cache, Prüfen und Warten auf CI nach jedem Merge: `docs/agents/integration.md`.

### Review-Befunde

Jeder Befund aus Standards- und Spec-Review steht im Abschlussbericht: behoben, oder unter „Noch offen“ mit Grund. Eine Abweichung vom Spec entscheidet die Person, nicht der Agent.

## Befehle

- Alles prüfen wie CI (Formatierung, Typen, Tests, Build, Clippy, Kern-Tests): `npm run check`
- Formatieren (Oberfläche und Kern): `npm run format`
- Entwicklung starten: `npm run tauri dev`
- Installer bauen: `npm run tauri build` (Ergebnis in `src-tauri/target/release/bundle/nsis/`)
- Release veröffentlichen: Tag `v<version>` pushen, der Workflow baut den Installer. Siehe `docs/agents/release.md`.
- Bauen und über die eigene Installation installieren: `npm run installieren` (wartet, bis die Person Kredr schließt; nur auf Wunsch starten)
