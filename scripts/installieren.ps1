# Baut Kredr aus dem aktuellen Stand und installiert es über die bestehende Installation.
# Aufruf: npm run installieren
# Der Build läuft, während Kredr noch offen ist; erst für die Installation muss es zu sein.
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$installiert = Join-Path $env:LOCALAPPDATA "Kredr\kredr.exe"

Set-Location $repo
Write-Host "Baue Kredr (Release) ..."
npm.cmd run tauri build
if ($LASTEXITCODE -ne 0) { throw "Der Build ist fehlgeschlagen; die Installation bleibt unverändert." }

$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo "src-tauri\target" }
$setup = Get-ChildItem (Join-Path $target "release\bundle\nsis\*-setup.exe") |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw "Kein Installer in $target\release\bundle\nsis gefunden." }

# Nur das installierte Kredr zählt; eine Entwicklungsfassung darf weiterlaufen.
function Get-InstalledKredr {
  Get-Process kredr -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installiert }
}
if (Get-InstalledKredr) {
  Write-Host ""
  Write-Host "Kredr läuft noch. Schließ es, sobald kein Agent mehr arbeitet; die Installation beginnt dann von selbst."
  while (Get-InstalledKredr) { Start-Sleep -Seconds 1 }
}

Write-Host "Installiere $($setup.Name) ..."
$lauf = Start-Process $setup.FullName -ArgumentList "/S" -Wait -PassThru
if ($lauf.ExitCode -ne 0) { throw "Der Installer endete mit Code $($lauf.ExitCode)." }

Write-Host "Fertig. Starte Kredr."
Start-Process $installiert
