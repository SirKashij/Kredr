# Startet die Entwicklungsfassung von Kredr so, dass ein Skript sie über CDP steuern kann.
# Läuft neben einem installierten Kredr. Ausgabe: PID, Port und Projektordner.
param(
  # Ordner des Projekts, das Kredr öffnet. Ohne Angabe: ein frisches Wegwerf-Repo.
  [string]$Projekt,
  [int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$arbeit = Join-Path $env:TEMP "kredr-steuern"
New-Item -ItemType Directory -Force $arbeit | Out-Null

# Ein Wegwerf-Repo mit einem Commit und einer offenen Änderung: Versionskontrolle,
# Diff und Verlauf haben dann etwas zu zeigen.
if (-not $Projekt) {
  $Projekt = Join-Path $arbeit "projekt-$(Get-Date -Format yyyyMMdd-HHmmss)"
  New-Item -ItemType Directory $Projekt | Out-Null
  Push-Location $Projekt
  git init -q
  Set-Content -Encoding utf8 a.txt "eins"
  git add .
  git -c user.name=kredr-steuern -c user.email=kredr-steuern@example.invalid commit -qm "Erster Commit"
  Add-Content -Encoding utf8 a.txt "zwei"
  Pop-Location
}

# Die Oberfläche kommt vom Vite-Server auf Port 1420 (devUrl in tauri.conf.json).
$vite = $null
if (-not (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue)) {
  $vite = Start-Process npm.cmd -ArgumentList "run", "dev" -WorkingDirectory $repo -WindowStyle Hidden -PassThru
  $bis = (Get-Date).AddSeconds(60)
  while (-not (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -gt $bis) { throw "Vite lauscht nach 60 s nicht auf Port 1420." }
    Start-Sleep -Milliseconds 300
  }
}

# Der Kern muss zum aktuellen Stand passen; ohne Änderungen dauert das unter einer Sekunde.
Push-Location (Join-Path $repo "src-tauri")
cargo build --quiet
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cargo build ist fehlgeschlagen." }
Pop-Location
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo "src-tauri\target" }
$exe = Join-Path $target "debug\kredr.exe"

# Eigenes WebView2-Profil: Teilt sich die Entwicklungsfassung den Browserprozess
# mit dem installierten Kredr, greift der Debug-Port nicht.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $arbeit "webview2"
$kredr = Start-Process $exe -ArgumentList "`"$Projekt`"" -PassThru

$bis = (Get-Date).AddSeconds(60)
while ($true) {
  try {
    $seiten = Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 2
    if ($seiten | Where-Object { $_.type -eq "page" -and $_.url -like "*localhost:1420*" }) { break }
  } catch {}
  if ($kredr.HasExited) { throw "Kredr hat sich beendet (Exit $($kredr.ExitCode))." }
  if ((Get-Date) -gt $bis) { throw "Kein CDP-Ziel auf Port $Port nach 60 s." }
  Start-Sleep -Milliseconds 300
}

@{ kredr = $kredr.Id; vite = $vite.Id; port = $Port; projekt = $Projekt } |
  ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $arbeit "laufend.json")
"Kredr läuft: PID $($kredr.Id), CDP-Port $Port, Projekt $Projekt"
