!macro customInit
  !if "${PRODUCT_NAME}" == "T3 Code (Dev)"
    !define T3_NORMALIZE_INSTALL_PATH
  !else if "${PRODUCT_NAME}" == "T3 Code (Experimental)"
    !define T3_NORMALIZE_INSTALL_PATH
  !else if "${PRODUCT_NAME}" == "T3 Code (Beta)"
    !define T3_NORMALIZE_INSTALL_PATH
  !endif
  !ifdef T3_NORMALIZE_INSTALL_PATH
    Push $0
    Push $1
    ; Legacy registrations contain doubled separators. NSIS rejects that
    ; InstallLocation before the old uninstaller reaches its uninstall section.
    ; Keep the registered old directory until its uninstaller has finished.
    GetFullPathName $INSTDIR "$INSTDIR"
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      ClearErrors
      GetFullPathName $1 "$0"
      ${IfNot} ${Errors}
      ${AndIf} $1 != ""
      ${AndIf} $0 != $1
        WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$1"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONSTOP "Could not normalize the existing ${PRODUCT_NAME} installation path." /SD IDOK
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
    ClearErrors
    !undef T3_NORMALIZE_INSTALL_PATH
  !endif
  !if "${PRODUCT_NAME}" == "T3 Code (Beta)"
    Push $0
    Push $1
    Push $2
    ; An explicit /D remains authoritative, including custom installation paths.
    !insertmacro GetDParameter $0
    ${If} $0 == ""
      ${GetFileName} "$INSTDIR" $0
      ${If} $0 == "T3 Code (Alpha)"
        ${GetParent} "$INSTDIR" $1
        ${GetFileName} "$1" $2
        ${If} $2 == "alpha"
          ${GetParent} "$1" $1
          StrCpy $1 "$1\beta"
        ${EndIf}
        StrCpy $INSTDIR "$1\T3 Code (Beta)"
      ${EndIf}
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  !endif
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
  !if "${PRODUCT_NAME}" == "T3 Code (Dev)"
    ; Remove the temporary executable names shipped in 0.1.0-fork-1/2.
    ; The current Dev executable and uninstaller keep their legacy names.
    Delete "$INSTDIR\t3code.exe"
    Delete "$INSTDIR\Uninstall t3code.exe"
  !endif
!macroend
