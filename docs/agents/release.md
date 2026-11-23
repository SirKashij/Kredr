# Release und Signierung

Releases baut der Workflow [`release.yml`](../../.github/workflows/release.yml), nicht mehr der eigene Rechner. Die SignPath Foundation signiert nur Installer, die nachweisbar auf GitHub-eigenen Runnern aus diesem Repository gebaut wurden.

## Ein Release machen

1. Version in `package.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` erhöhen und committen.
2. Tag setzen und pushen: `git tag v0.4.0` und `git push origin v0.4.0`.
3. Der Workflow baut den Installer und schickt ihn an SignPath. Dort die Signieranfrage freigeben (Approver). Der Workflow wartet bis zu einer Stunde.
4. Auf GitHub erscheint ein Release als Entwurf mit dem signierten Installer. Text prüfen, bei Bedarf „Pre-release“ setzen, veröffentlichen.

Der Workflow bricht ab, wenn Tag und Version in `package.json` nicht zusammenpassen.

## SignPath einrichten (einmalig)

1. Bewerbung unter <https://signpath.org/apply> mit dem Repository `SirKashij/Kredr`. Voraussetzungen: OSI-Lizenz (GPL-3.0), Code-Signing-Policy im README, mindestens ein bereits veröffentlichtes Release, Zwei-Faktor-Anmeldung bei GitHub und SignPath.
2. Nach der Zusage in SignPath:
   - Trusted Build System „GitHub.com“ hinzufügen und mit dem Projekt verknüpfen.
   - Projekt mit dem Slug `Kredr`, Signing Policy mit dem Slug `release-signing` (manuelle Freigabe).
   - Artifact Configuration als Standard setzen (siehe unten).
   - API-Token eines Benutzers mit Submitter-Rechten erzeugen.
3. Auf GitHub unter Settings → Secrets and variables → Actions:
   - Secret `SIGNPATH_API_TOKEN`: das API-Token.
   - Variable `SIGNPATH_ORGANIZATION_ID`: die Organisations-ID aus SignPath.

Weichen die Slugs ab, in `release.yml` anpassen.

### Artifact Configuration

`actions/upload-artifact` packt den Installer in ein ZIP, deshalb ist `zip-file` die Wurzel. Produktname und -version prüft SignPath gegen die Metadaten der `.exe`, wie es die Bedingungen der Foundation verlangen.

```xml
<?xml version="1.0" encoding="utf-8"?>
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Kredr_*_x64-setup.exe" product-name="Kredr">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

Die genaue Syntax beim Anlegen im SignPath-Editor prüfen; dort lässt sich die Konfiguration gegen ein hochgeladenes Beispiel testen.
