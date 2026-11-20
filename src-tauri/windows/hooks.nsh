; Ergänzungen des Installers: der Rechtsklick-Eintrag „Mit Kredr öffnen“ für
; Ordner im Windows-Explorer und der Befehl `kredr` im Terminal.
;
; Kredr wird pro Benutzer installiert, deshalb stehen alle Einträge unter
; HKEY_CURRENT_USER. Umlaute stehen als ${U+...}, damit die Kodierung dieser
; Datei keine Rolle spielt.

!include LogicLib.nsh
!include WinMessages.nsh

!define KREDR_MENU_FOLDER "Software\Classes\Directory\shell\Kredr"
!define KREDR_MENU_BACKGROUND "Software\Classes\Directory\Background\shell\Kredr"

; Nimmt den Ordner aus KREDR_BIN aus dem Pfad des Benutzers und hängt ihn bei
; KREDR_PATH=add wieder an. PowerShell statt NSIS, weil NSIS Zeichenketten
; über 1024 Zeichen abschneidet und ein langer Pfad dabei verloren ginge.
; Platzhalter wie %USERPROFILE% im Pfad bleiben unverändert erhalten.
!define KREDR_PATH_SCRIPT `$$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$$true); $$old=[string]$$k.GetValue('Path','','DoNotExpandEnvironmentNames'); $$p=@($$old -split ';' | Where-Object { $$_ -and $$_ -ne $$env:KREDR_BIN }); if($$env:KREDR_PATH -eq 'add'){ $$p+=$$env:KREDR_BIN }; $$new=$$p -join ';'; if($$new -cne $$old){ $$k.SetValue('Path',$$new,'ExpandString') }`

; Aufruf: !insertmacro KREDR_UPDATE_PATH "add" oder "remove"
!macro KREDR_UPDATE_PATH ACTION
  System::Call 'kernel32::SetEnvironmentVariable(t "KREDR_BIN", t "$INSTDIR\bin")'
  System::Call 'kernel32::SetEnvironmentVariable(t "KREDR_PATH", t "${ACTION}")'
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${KREDR_PATH_SCRIPT}"`
  Pop $0
  ; Bereits laufende Programme (Explorer, Terminals) erfahren vom neuen Pfad.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro KREDR_WRITE_MENU KEY ARGUMENT
  WriteRegStr HKCU "${KEY}" "" "$1"
  WriteRegStr HKCU "${KEY}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "${KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "${ARGUMENT}"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1

  ; Rechtsklick auf einen Ordner und auf die freie Fläche in einem Ordner.
  ${If} $LANGUAGE == 1031
    StrCpy $1 "Mit Kredr ${U+00F6}ffnen"
  ${Else}
    StrCpy $1 "Open with Kredr"
  ${EndIf}
  !insertmacro KREDR_WRITE_MENU "${KREDR_MENU_FOLDER}" "%1"
  !insertmacro KREDR_WRITE_MENU "${KREDR_MENU_BACKGROUND}" "%V"

  ; Der Befehl `kredr`: ein eigener Ordner im Pfad, damit dort nur dieser
  ; Befehl liegt. Die .cmd-Datei gilt für PowerShell und die Eingabeaufforderung,
  ; die Datei ohne Endung für Git Bash. Beide kehren sofort zurück.
  CreateDirectory "$INSTDIR\bin"
  FileOpen $0 "$INSTDIR\bin\kredr.cmd" w
  FileWrite $0 '@start "" "%~dp0..\${MAINBINARYNAME}.exe" %*$\r$\n'
  FileClose $0
  FileOpen $0 "$INSTDIR\bin\kredr" w
  FileWrite $0 '#!/bin/sh$\n"$$(dirname "$$0")/../${MAINBINARYNAME}.exe" "$$@" >/dev/null 2>&1 &$\n'
  FileClose $0
  !insertmacro KREDR_UPDATE_PATH "add"

  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Bei einer Aktualisierung bleibt alles stehen; die neue Fassung schreibt es neu.
  ${If} $UpdateMode <> 1
    Push $0
    DeleteRegKey HKCU "${KREDR_MENU_FOLDER}"
    DeleteRegKey HKCU "${KREDR_MENU_BACKGROUND}"
    !insertmacro KREDR_UPDATE_PATH "remove"
    Delete "$INSTDIR\bin\kredr.cmd"
    Delete "$INSTDIR\bin\kredr"
    RMDir "$INSTDIR\bin"
    Pop $0
  ${EndIf}
!macroend
