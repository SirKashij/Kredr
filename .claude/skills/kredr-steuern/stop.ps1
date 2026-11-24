# Beendet, was start.ps1 gestartet hat: die Entwicklungsfassung und, falls von dort gestartet, Vite.
# Ein installiertes Kredr bleibt unberührt, denn es zählt nur die gemerkte PID.
param(
  # Beendet zusätzlich jede Entwicklungsfassung (`…\debug\kredr.exe`), auch eine, die
  # nicht über start.ps1 lief. Ein installiertes Kredr liegt nie unter `debug`.
  [switch]$Alle
)
$datei = Join-Path $env:TEMP "kredr-steuern\laufend.json"
$beendet = $false
if (Test-Path $datei) {
  $laufend = Get-Content $datei -Raw | ConvertFrom-Json
  foreach ($id in @($laufend.kredr, $laufend.vite)) {
    if ($id) { taskkill /PID $id /T /F *> $null }
  }
  Remove-Item $datei
  $beendet = $true
}
if ($Alle) {
  $fremde = Get-Process kredr -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\debug\kredr.exe" }
  foreach ($prozess in $fremde) {
    "Beende Entwicklungsfassung PID $($prozess.Id) ($($prozess.Path))"
    taskkill /PID $prozess.Id /T /F *> $null
    $beendet = $true
  }
}
if ($beendet) { "Beendet." } else { "Nichts zu beenden." }
