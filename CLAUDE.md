# Kredr

## Agent skills

### Issue tracker

Aufgaben und Spezifikationen liegen als GitHub Issues in diesem Repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Die fünf Standard-Labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: ein `GLOSSARY.md` und `docs/adr/` im Hauptverzeichnis. See `docs/agents/domain.md`.

## Befehle

- Entwicklung starten: `npm run tauri dev`
- Typprüfung der Oberfläche: `npm run typecheck`
- Formatierung der Oberfläche: `npm run format` (prüfen: `npm run format:check`)
- Tests der Oberfläche: `npm test`
- Tests des Kerns (starten echte PowerShell): `cargo test` in `src-tauri/`
- Installer bauen: `npm run tauri build` (Ergebnis in `src-tauri/target/release/bundle/nsis/`)
