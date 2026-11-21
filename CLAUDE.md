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

## Befehle

- Alles prüfen wie CI (Formatierung, Typen, Tests, Build, Clippy, Kern-Tests): `npm run check`
- Formatieren: `npm run format` bzw. `cargo fmt` in `src-tauri/`
- Entwicklung starten: `npm run tauri dev`
- Installer bauen: `npm run tauri build` (Ergebnis in `src-tauri/target/release/bundle/nsis/`)
