# Prüfung zu #102: Ein nativer Dialog gehört seinem Fenster und schließt mit ihm.
# Startet die Entwicklungsfassung mit zwei Fenstern neu. Exit 0 = GRÜN.
#  1. Die Rückfrage vor der Aktualisierung gehört dem fragenden Fenster und sperrt es.
#  2. Das andere Fenster bekommt zwei Schließen-Rückfragen; die eine bestätigt, schließt
#     es, die andere (nun verwaist) verschwindet, die Rückfrage des ersten bleibt.
$ErrorActionPreference = "Stop"
$hier = $PSScriptRoot
& "$hier\stop.ps1" | Out-Null
& "$hier\start.ps1" -Fenster 2 -Aktualisierung 0.6.0
$rot = @()
function Liste { @(& "$hier\dialoge.ps1") }
function Warte { Start-Sleep -Milliseconds 2500 }

# main fragt, window-1 hat einen laufenden Prozess (Anlass für seine Schließen-Rückfrage).
node "$hier\rueckfrage.mjs" window-1
Warte
$frage = @(Liste | Where-Object { $_.Titel -eq "Kredr aktualisieren?" })
if ($frage) { & "$hier\dialoge.ps1" -Antworten "Kredr aktualisieren?" -Mit abbrechen | Out-Null; Warte }
node "$hier\rueckfrage.mjs" main
Warte

$fenster = Liste | Where-Object Art -eq "Fenster"
$fragend = (Liste | Where-Object { $_.Titel -eq "Kredr aktualisieren?" }).Besitzer
$anderes = ($fenster | Where-Object Titel -ne $fragend).Titel
"Rückfrage gehört: $fragend; anderes Fenster: $anderes"
if (-not $fragend) { $rot += "Rückfrage ohne Besitzer" }
if (-not ($fenster | Where-Object { $_.Titel -eq $fragend -and $_.Gesperrt })) { $rot += "fragendes Fenster nicht gesperrt" }

& "$hier\dialoge.ps1" -Schliessen $anderes | Out-Null; Warte
& "$hier\dialoge.ps1" -Schliessen $anderes | Out-Null; Warte
$schliessen = @(Liste | Where-Object { $_.Titel -eq "Fenster schließen?" })
if ($schliessen.Count -ne 2) { $rot += "erwartet zwei Schließen-Rückfragen, gefunden $($schliessen.Count)" }
elseif ($schliessen | Where-Object Besitzer -ne $anderes) { $rot += "Schließen-Rückfrage gehört nicht ihrem Fenster" }
else {
  & "$hier\dialoge.ps1" -Antworten "Fenster schließen?" -Hwnd $schliessen[0].Hwnd -Mit ok | Out-Null
  Warte
}

$danach = Liste
$danach | Format-Table -AutoSize | Out-String -Width 200
if ($danach | Where-Object Titel -eq $anderes) { $rot += "$anderes hat sich nicht geschlossen" }
if ($danach | Where-Object Titel -eq "Fenster schließen?") { $rot += "verwaiste Schließen-Rückfrage steht noch" }
if (-not ($danach | Where-Object { $_.Titel -eq "Kredr aktualisieren?" -and $_.Besitzer -eq $fragend })) {
  $rot += "Rückfrage des lebenden Fensters fehlt"
}
& "$hier\dialoge.ps1" -Antworten "Kredr aktualisieren?" -Mit abbrechen *> $null

if ($rot) { $rot | ForEach-Object { "ROT: $_" }; exit 1 }
"GRÜN: Dialoge gehören ihrem Fenster und schließen mit ihm"
exit 0
