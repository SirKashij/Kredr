# Zeigt und bedient die nativen Fenster der Entwicklungsfassung, die über CDP nicht
# erreichbar sind: Rückfragen und Meldungen (Klasse #32770) und die Kredr-Fenster selbst.
# Ohne Schalter: Liste mit Titel, Besitzer und ob das Fenster gesperrt ist.
#   -Antworten "<Titel>" -Mit ok|abbrechen   beantwortet den Dialog mit diesem Titel
#   -Schliessen "<Fenstertitel>"             fordert ein Kredr-Fenster zum Schließen auf
#                                            (WM_CLOSE, wie „Fenster schließen“ in der Taskleiste)
# Gibt es den Titel mehrfach, wählt -Hwnd das Fenster.
param(
  [string]$Antworten,
  [ValidateSet("ok", "abbrechen")][string]$Mit = "ok",
  [string]$Schliessen,
  [long]$Hwnd = 0
)
$ErrorActionPreference = "Stop"
$laufend = Join-Path $env:TEMP "kredr-steuern\laufend.json"
if (-not (Test-Path $laufend)) { throw "Keine Entwicklungsfassung läuft (start.ps1)." }
$kredrPid = (Get-Content $laufend -Raw | ConvertFrom-Json).kredr

if (-not ("KredrFenster" -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KredrFenster {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
}

function Text([IntPtr]$h, [bool]$klasse) {
  $s = New-Object System.Text.StringBuilder 256
  if ($klasse) { [void][KredrFenster]::GetClassName($h, $s, 256) } else { [void][KredrFenster]::GetWindowText($h, $s, 256) }
  $s.ToString()
}

function Fensterliste {
  $roh = New-Object System.Collections.ArrayList
  $besuch = [KredrFenster+EnumProc]{
    param($h, $l)
    $p = 0
    [void][KredrFenster]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $kredrPid -and [KredrFenster]::IsWindowVisible($h)) { [void]$roh.Add($h) }
    return $true
  }
  [void][KredrFenster]::EnumWindows($besuch, [IntPtr]::Zero)
  foreach ($h in $roh) {
    $klasse = Text $h $true
    $art = switch ($klasse) { "#32770" { "Dialog" } "Tauri Window" { "Fenster" } default { $null } }
    if (-not $art) { continue }
    $besitzer = [KredrFenster]::GetWindow($h, 4)
    [pscustomobject]@{
      Hwnd     = [long]$h
      Art      = $art
      Titel    = Text $h $false
      Besitzer = if ($besitzer -eq [IntPtr]::Zero) { "" } else { Text $besitzer $false }
      Gesperrt = -not [KredrFenster]::IsWindowEnabled($h)
    }
  }
}

function Ziel([string]$art, [string]$titel) {
  $treffer = @(Fensterliste | Where-Object { $_.Art -eq $art -and ($Hwnd -eq 0 -or $_.Hwnd -eq $Hwnd) -and $_.Titel -eq $titel })
  if ($treffer.Count -eq 0) { throw "Kein $art mit dem Titel '$titel'." }
  if ($treffer.Count -gt 1) { throw "Mehrere $art mit dem Titel '$titel' ($($treffer.Hwnd -join ', ')); wähle mit -Hwnd." }
  $treffer[0]
}

if ($Antworten) {
  $dialog = Ziel "Dialog" $Antworten
  # IDOK und IDCANCEL; das Dialog-Plugin bildet sie auf die eigenen Beschriftungen ab.
  $knopf = if ($Mit -eq "ok") { 1 } else { 2 }
  [void][KredrFenster]::PostMessage([IntPtr]$dialog.Hwnd, 0x111, [IntPtr]$knopf, [IntPtr]::Zero)
  "Beantwortet: '$Antworten' mit $Mit"
} elseif ($Schliessen) {
  $fenster = Ziel "Fenster" $Schliessen
  [void][KredrFenster]::PostMessage([IntPtr]$fenster.Hwnd, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
  "Schließen angefordert: '$Schliessen'"
} else {
  Fensterliste
}
