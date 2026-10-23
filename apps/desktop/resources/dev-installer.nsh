!macro customInit
  !if "${PRODUCT_NAME}" == "T3 Code (Dev)"
    Push $0
    Push $1
    ; Legacy registrations contain doubled separators. NSIS rejects that
    ; InstallLocation before the old uninstaller reaches its uninstall section.
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
          MessageBox MB_OK|MB_ICONSTOP "Could not normalize the existing Dev installation path." /SD IDOK
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  !endif
!macroend

!macro customInstall
  !if "${PRODUCT_NAME}" == "T3 Code (Dev)"
    ; Remove the temporary executable names shipped in 0.1.0-fork-1/2.
    ; The current Dev executable and uninstaller keep their legacy names.
    Delete "$INSTDIR\t3code.exe"
    Delete "$INSTDIR\Uninstall t3code.exe"
  !endif
!macroend
