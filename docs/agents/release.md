# Release

Releases baut der Workflow [`release.yml`](../../.github/workflows/release.yml) auf GitHub, nicht der eigene Rechner. So stammt jeder veröffentlichte Installer nachvollziehbar aus dem getaggten Stand.

1. Version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` und `src-tauri/tauri.conf.json` erhöhen und über einen PR nach `main` bringen.
2. Auf `main` taggen und pushen: `git tag v0.4.0` und `git push origin v0.4.0`.
3. Der Workflow baut den Installer und legt ein Release als Entwurf an. Er bricht ab, wenn Tag und Version in `package.json` nicht zusammenpassen.
4. Auf GitHub Text prüfen, bei Bedarf „Pre-release“ setzen, veröffentlichen.

Der Installer ist nicht per Authenticode signiert; Windows SmartScreen warnt beim ersten Start. Das ist bewusst so entschieden, eine Signatur kostet Geld oder eine Bewerbung bei der SignPath Foundation.

## Dateien für die Aktualisierung

Installierte Fassungen aktualisieren sich über das Tauri-Updater-Plugin (ADR 0007). Dafür legt der Workflow neben `*-setup.exe` noch zwei Dateien zum Entwurf:

- `*-setup.exe.sig`: die Signatur des Installers.
- `latest.json`: Version, Datum, Signatur und die Download-URL des Installers im Release des Tags.

Signiert wird mit dem minisign-Schlüssel des Updaters, nicht mit Authenticode. Den privaten Schlüssel und sein Passwort hält das Repository als Secrets `TAURI_SIGNING_PRIVATE_KEY` und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Eine Kopie liegt außerhalb von GitHub. Geht der Schlüssel verloren, kann keine installierte Fassung mehr automatisch aktualisieren.

Die Dateien entstehen nur im Workflow, denn nur er baut mit der Überlagerung `src-tauri/tauri.updater.conf.json`, die `createUpdaterArtifacts` einschaltet. Öffentlicher Schlüssel, Adresse der `latest.json` und Installationsmodus stehen unter `plugins.updater` in `tauri.conf.json`, weil das Plugin sie in jedem Build braucht. `npm run check`, `npm run tauri build` und `npm run installieren` brauchen deshalb keinen Schlüssel. Ein manueller Lauf des Workflows (`gh workflow run release.yml --ref <zweig>`) legt kein Release an, sondern lädt die drei Dateien als Artefakt `installer` hoch.

Installierte Fassungen lesen `releases/latest/download/latest.json`. Diese Adresse zeigt nur auf veröffentlichte, stabile Releases. Solange das Release ein Entwurf oder als „Pre-release“ markiert ist, bietet Kredr die Version nicht an. Erst das Veröffentlichen gibt sie frei.

Fassungen bis 0.5.x kennen den Updater nicht. Der Release-Text der ersten Version mit Updater sagt deshalb: Wer 0.5.x oder älter nutzt, installiert diese Version einmal von Hand. Danach aktualisiert sich Kredr selbst.
