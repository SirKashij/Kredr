# Aktualisierung über das Tauri-Updater-Plugin mit eigenem Signaturschlüssel

Kredr aktualisiert sich über `tauri-plugin-updater`. Das Plugin liest die `latest.json` des neuesten stabilen GitHub-Releases (`releases/latest/download/latest.json`), lädt den NSIS-Installer und prüft ihn gegen einen öffentlichen Schlüssel, der fest in `tauri.conf.json` steht. Den privaten Schlüssel samt Passwort hält das Repository als GitHub-Secret. `release.yml` signiert damit und lädt `latest.json` und die `.sig`-Datei zum Release hoch. Sichtbar wird ein Release erst, wenn die Person den Entwurf veröffentlicht. Vorabversionen liefert `releases/latest` nie aus.

Diese Signatur ist unabhängig von der Authenticode-Signatur, auf die Kredr bewusst verzichtet (siehe `docs/agents/release.md`), und kostet nichts.

## Erwogene Alternativen

- **Eigenbau über die GitHub-API**: neuestes Release abfragen, Setup laden und mit `/S` ausführen, ähnlich wie `scripts/installieren.ps1`. Verworfen, weil Herkunftsprüfung, Download und Neustart dann selbst gebaut und gepflegt werden müssten.
- **Ohne Signatur, nur über HTTPS von GitHub laden**: Verworfen, weil das Plugin die Signatur verlangt und ein übernommenes Release sonst ungeprüft auf jedem Rechner landen würde.

## Folgen

- Geht der private Schlüssel verloren, kann keine installierte Fassung mehr automatisch aktualisieren. Wer installiert hat, muss den neuen Installer dann einmal von Hand ausführen. Deshalb liegt der Schlüssel zusätzlich außerhalb von GitHub gesichert.
- Ein Schlüsselwechsel braucht eine Übergangsversion, die noch mit dem alten Schlüssel signiert ist und den neuen öffentlichen Schlüssel mitbringt.
- Fassungen vor Einführung des Updaters (bis 0.5.x) erfahren nichts von neuen Versionen. Sie müssen einmal von Hand aktualisiert werden.
- Das Plugin startet Kredr nach der Installation mit den Argumenten des ersten Starts neu (`current_exe_args` aus `args_os`, an den Installer über `/ARGS`). Nach `kredr <Ordner>` kommt also wieder dieser Ordner an. Deshalb geht die Notiz für den Neustart dem Projektargument vor (`start_windows` in `project_windows.rs`).
- Unter Windows beendet das Plugin Kredr mit `std::process::exit(0)`, ohne dass `on_window_event` noch läuft. Was vor dem Neustart gespeichert sein muss, gehört in `on_before_exit`.
