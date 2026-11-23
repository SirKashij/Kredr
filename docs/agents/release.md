# Release

Releases baut der Workflow [`release.yml`](../../.github/workflows/release.yml) auf GitHub, nicht der eigene Rechner. So stammt jeder veröffentlichte Installer nachvollziehbar aus dem getaggten Stand.

1. Version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` und `src-tauri/tauri.conf.json` erhöhen und über einen PR nach `main` bringen.
2. Auf `main` taggen und pushen: `git tag v0.4.0` und `git push origin v0.4.0`.
3. Der Workflow baut den Installer und legt ein Release als Entwurf an. Er bricht ab, wenn Tag und Version in `package.json` nicht zusammenpassen.
4. Auf GitHub Text prüfen, bei Bedarf „Pre-release“ setzen, veröffentlichen.

Der Installer ist nicht signiert; Windows SmartScreen warnt beim ersten Start. Das ist bewusst so entschieden, eine Signatur kostet Geld oder eine Bewerbung bei der SignPath Foundation.
