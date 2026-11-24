# Startet die Entwicklungsfassung von Kredr so, dass ein Skript sie über CDP steuern kann.
# Läuft neben einem installierten Kredr. Ausgabe: PID, Port und Projektordner.
param(
  # Ordner des Projekts, das Kredr öffnet. Ohne Angabe: ein frisches Wegwerf-Repo.
  [string]$Projekt,
  # Antworten auf die Ordnerdialoge der Reihe nach; der letzte gilt für jeden weiteren.
  [string[]]$Ordner = @(),
  # Beginnt mit leerem Datenordner: ohne Projektliste, Aufteilungen und Workspaces.
  [switch]$FrischeDaten,
  # Startet ohne Projekt wie aus dem Startmenü: Startseite oder die zuletzt offenen Workspaces.
  [switch]$OhneProjekt,
  # So viele Fenster, jedes mit einem eigenen Wegwerf-Repo (wie nach dem Neustart einer Aktualisierung).
  [int]$Fenster = 1,
  # Version, die der Kern allen Fenstern als neu anbietet, etwa 0.6.0; geladen wird nichts.
  [string]$Aktualisierung = "",
  [int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$arbeit = Join-Path $env:TEMP "kredr-steuern"
New-Item -ItemType Directory -Force $arbeit | Out-Null

# Ein Wegwerf-Repo mit einem Commit und einer offenen Änderung: Versionskontrolle,
# Diff und Verlauf haben dann etwas zu zeigen.
function Neues-Wegwerfrepo([string]$name) {
  $ordner = Join-Path $arbeit $name
  New-Item -ItemType Directory $ordner | Out-Null
  Push-Location $ordner
  git init -q
  Set-Content -Encoding utf8 a.txt "eins"
  git add .
  git -c user.name=kredr-steuern -c user.email=kredr-steuern@example.invalid commit -qm "Erster Commit"
  Add-Content -Encoding utf8 a.txt "zwei"
  Pop-Location
  return $ordner
}
$zeit = Get-Date -Format yyyyMMdd-HHmmss
$projekte = @()
if ($Fenster -gt 1) {
  if ($Projekt -or $OhneProjekt) { throw "-Fenster verträgt sich nicht mit -Projekt oder -OhneProjekt." }
  $projekte = 1..$Fenster | ForEach-Object { Neues-Wegwerfrepo "projekt-$zeit-$_" }
} elseif (-not $Projekt -and -not $OhneProjekt) {
  $Projekt = Neues-Wegwerfrepo "projekt-$zeit"
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
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo "src-tauri\target" }
$exe = Join-Path $target "debug\kredr.exe"
cargo build --quiet
if ($LASTEXITCODE -ne 0) {
  Pop-Location
  # Eine laufende Entwicklungsfassung sperrt die Programmdatei („Zugriff verweigert“).
  $sperrend = Get-Process kredr -ErrorAction SilentlyContinue | Where-Object Path -eq $exe
  if ($sperrend) {
    throw "cargo build ist fehlgeschlagen: $exe läuft noch als PID $($sperrend.Id -join ', '). Beenden mit stop.ps1 -Alle."
  }
  throw "cargo build ist fehlgeschlagen."
}
Pop-Location

# Eigenes WebView2-Profil: Teilt sich die Entwicklungsfassung den Browserprozess
# mit dem installierten Kredr, greift der Debug-Port nicht.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $arbeit "webview2"
# Eigener Datenordner: Testläufe berühren Einstellungen und Aufteilungen des installierten Kredr nicht.
$daten = Join-Path $arbeit "daten"
if ($FrischeDaten) { Remove-Item -Recurse -Force $daten -ErrorAction SilentlyContinue }
$env:KREDR_DATA_DIR = $daten
# Läuft das Skript in einer Claude-Code-Sitzung, erbte Claude Code in Kredrs Terminals
# deren Variablen und hielte sich für eine Kind-Sitzung: ohne gespeichertes Gespräch,
# also auch ohne Fortsetzen.
Get-ChildItem Env: | Where-Object Name -like "CLAUDE_CODE_*" | ForEach-Object { Remove-Item "Env:$($_.Name)" }
Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue
# Ordnerdialoge beantwortet Kredr selbst; ohne Angabe erscheint der Windows-Dialog.
$env:KREDR_SIMULATED_UPDATE = $Aktualisierung
$env:KREDR_TEST_FOLDERS =($Ordner | ForEach-Object { (Resolve-Path $_).Path }) -join ";"
# Mehrere Fenster: Ohne Projekt öffnet Kredr die Fenster aus der Notiz für den
# Neustart nach einer Aktualisierung, sofern sie der laufenden Version gilt.
if ($projekte) {
  $version = (Get-Content (Join-Path $repo "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
  $notiz = @{ version = 1; target = $version; windows = @($projekte | ForEach-Object { @{ path = $_ } }) }
  New-Item -ItemType Directory -Force $daten | Out-Null
  [IO.File]::WriteAllText((Join-Path $daten "restart-windows.json"), ($notiz | ConvertTo-Json -Depth 4))
  $OhneProjekt = $true
  $Projekt = $projekte -join ", "
}
$kredr = if ($OhneProjekt) {
  Start-Process $exe -PassThru
} else {
  Start-Process $exe -ArgumentList "`"$Projekt`"" -PassThru
}

$bis = (Get-Date).AddSeconds(60)
while ($true) {
  try {
    $seiten = Invoke-RestMethod "http://127.0.0.1:$Port/json" -TimeoutSec 2
    $offen = @($seiten | Where-Object { $_.type -eq "page" -and $_.url -like "*localhost:1420*" })
  if ($offen.Count -ge [Math]::Max($projekte.Count, 1)) { break }
  } catch {}
  if ($kredr.HasExited) { throw "Kredr hat sich beendet (Exit $($kredr.ExitCode))." }
  if ((Get-Date) -gt $bis) { throw "Kein CDP-Ziel auf Port $Port nach 60 s." }
  Start-Sleep -Milliseconds 300
}

@{ kredr = $kredr.Id; vite = $vite.Id; port = $Port; projekt = $Projekt } |
  ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $arbeit "laufend.json")
"Kredr läuft: PID $($kredr.Id), CDP-Port $Port, Projekt $Projekt"
