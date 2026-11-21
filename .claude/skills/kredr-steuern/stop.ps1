# Beendet, was start.ps1 gestartet hat: die Entwicklungsfassung und, falls von dort gestartet, Vite.
# Ein installiertes Kredr bleibt unberührt, denn es zählt nur die gemerkte PID.
$datei = Join-Path $env:TEMP "kredr-steuern\laufend.json"
if (-not (Test-Path $datei)) { "Nichts zu beenden."; exit 0 }
$laufend = Get-Content $datei -Raw | ConvertFrom-Json
foreach ($id in @($laufend.kredr, $laufend.vite)) {
  if ($id) { taskkill /PID $id /T /F *> $null }
}
Remove-Item $datei
"Beendet."
