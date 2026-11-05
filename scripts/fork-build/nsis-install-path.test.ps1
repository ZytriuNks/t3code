param(
  [Parameter(Mandatory = $true)][string]$MakeNsisPath,
  [Parameter(Mandatory = $true)][string]$NsisTemplatesPath,
  [Parameter(Mandatory = $true)][string]$StdUtilsPluginPath,
  [Parameter(Mandatory = $true)][string]$ResultsPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('t3-nsis-path-probe-' + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$hook = [IO.File]::ReadAllText((Join-Path $repoRoot 'apps/desktop/resources/installer.nsh'))
$multiUser = [IO.File]::ReadAllText((Join-Path $NsisTemplatesPath 'multiUser.nsh'))
$installer = [IO.File]::ReadAllText((Join-Path $NsisTemplatesPath 'installer.nsi'))
$oneClick = [IO.File]::ReadAllText((Join-Path $NsisTemplatesPath 'oneClick.nsh'))

# Execute the production macros in their real .onInit order, without installer sections.
$sequence = [regex]::Match($installer, '!insertmacro initMultiUser\s+!ifmacrodef customInit\s+!insertmacro customInit\s+!endif').Value
if (-not $sequence) { throw 'Review the changed electron-builder initialization order before running this probe.' }
$installSection = $installer.Substring($installer.IndexOf('Section "install"'))
if ($installSection -notmatch '!ifndef ONE_CLICK[\s\S]*!insertmacro setInstallModePerAllUsers') {
  throw 'Review the changed install-mode ordering before running this probe.'
}
if ($oneClick -match '(?m)^\s*Function\b') { throw 'Review new one-click callbacks before running this probe.' }

# Replace only registry I/O with in-memory fixtures. Keep native mode selection,
# /D parsing, GetFullPathName, and the complete production customInit unchanged.
foreach ($source in @($hook, $multiUser)) {
  if ($source -match '(?m)^\s*(ReadReg\w+|WriteReg\w+|DeleteReg\w+)\b' -and
      $source -match '(?m)^\s*(ReadRegDWORD|WriteRegDWORD|DeleteReg\w+)\b') {
    throw 'Review new registry operations before extending the fixture boundary.'
  }
}
$hook = [regex]::Replace($hook, '(?m)^(\s*)ReadRegStr ', '$1!insertmacro ProbeReadRegStr ')
$hook = [regex]::Replace($hook, '(?m)^(\s*)WriteRegStr ', '$1!insertmacro ProbeWriteRegStr ')
$multiUser = [regex]::Replace($multiUser, '(?m)^(\s*)ReadRegStr ', '$1!insertmacro ProbeReadRegStr ')
# The native known-folder lookup must not create a real Programs directory.
if (-not $multiUser.Contains('!define KF_FLAG_CREATE 0x00008000')) { throw 'Review the known-folder lookup flags.' }
$multiUser = $multiUser.Replace('!define KF_FLAG_CREATE 0x00008000', '!define KF_FLAG_CREATE 0')
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'hook.nsh'), $hook, $utf8)
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'multiUser.nsh'), $multiUser, $utf8)

$products = @(
  @{ Name = 'T3 Code (Alpha)'; Default = 'D:\t3code\alpha\T3 Code (Alpha)'; Normalize = $false },
  @{ Name = 'T3 Code (Experimental)'; Default = 'D:\t3code\experimental\T3 Code (Experimental)'; Normalize = $true },
  @{ Name = 'T3 Code (Dev)'; Default = 'D:\t3code\dev\T3 Code (Dev)'; Normalize = $true },
  @{ Name = 'T3 Code (Beta)'; Default = ''; Normalize = $true },
  @{ Name = 'T3 Code'; Default = ''; Normalize = $false },
  @{ Name = 'Unrecognized Product'; Default = ''; Normalize = $false }
)
$observations = [Collections.Generic.List[object]]::new()
$ownedProcesses = [Collections.Generic.List[object]]::new()
$userPath = Join-Path $fixtureRoot 'custom user/Kept path'
$machinePath = Join-Path $fixtureRoot 'custom machine/Kept path'
$otherPath = Join-Path $fixtureRoot 'other scope/Kept path'
$legacyManaged = Join-Path $fixtureRoot 'alpha/T3 Code (Alpha)'
$legacyCustom = Join-Path $fixtureRoot 'custom root/T3 Code (Alpha)'
$explicitPath = Join-Path $fixtureRoot 'explicit custom root/Exact destination'
$lowercasePath = Join-Path $fixtureRoot 'lowercase custom root/Exact destination'
$missingPath = Join-Path $fixtureRoot 'not yet created/Exact destination'
foreach ($directory in @($userPath, $machinePath, $otherPath, $legacyManaged, $legacyCustom, $explicitPath, $lowercasePath)) {
  [IO.Directory]::CreateDirectory($directory) | Out-Null
}
$preamble = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh
!addincludedir "@TEMPLATES@\include"
!addplugindir /x86-unicode "@PLUGINS@"
!include StdUtils.nsh
!include MUI2.nsh
!define ONE_CLICK
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define APP_FILENAME "t3code"
!define APP_64
!define APP_GUID "t3-private-path-probe"
!define UNINSTALL_APP_KEY "t3-private-path-probe"
!define PRODUCT_NAME "@PRODUCT@"
Name "Private NSIS path calculation probe"
OutFile "@EXE@"
Var ProbeUser
Var ProbeMachine
Var ProbeOutput
!macro ProbeReadRegStr OUTPUT ROOT KEY VALUE
  !if "${KEY}" != "Software\${APP_GUID}"
    !error "Unexpected registry key in path policy"
  !endif
  !if "${VALUE}" != "InstallLocation"
    !error "Unexpected registry value in path policy"
  !endif
  !if "${ROOT}" == "HKCU"
    StrCpy ${OUTPUT} $ProbeUser
  !else if "${ROOT}" == "HKLM"
    StrCpy ${OUTPUT} $ProbeMachine
  !else if "${ROOT}" == "SHELL_CONTEXT"
    ${If} $installMode == "all"
      StrCpy ${OUTPUT} $ProbeMachine
    ${Else}
      StrCpy ${OUTPUT} $ProbeUser
    ${EndIf}
  !else
    !error "Unexpected registry root in path policy"
  !endif
!macroend
!macro ProbeWriteRegStr ROOT KEY VALUE INPUT
  !if "${ROOT}" != "SHELL_CONTEXT"
    !error "Unexpected registry write root in path policy"
  !endif
  !if "${KEY}" != "Software\${APP_GUID}"
    !error "Unexpected registry write key in path policy"
  !endif
  !if "${VALUE}" != "InstallLocation"
    !error "Unexpected registry write value in path policy"
  !endif
  ${If} $installMode == "all"
    StrCpy $ProbeMachine ${INPUT}
  ${Else}
    StrCpy $ProbeUser ${INPUT}
  ${EndIf}
!macroend
!include "@FIXTURE@\multiUser.nsh"
!include "@FIXTURE@\hook.nsh"
!include "@TEMPLATES@\oneClick.nsh"
!insertmacro MUI_LANGUAGE "English"
'@

foreach ($product in $products) {
  foreach ($mode in @('user', 'machine')) {
    $stem = ($product.Name -replace '[^A-Za-z0-9]', '') + '-' + $mode
    $probePath = Join-Path $fixtureRoot ($stem + '.exe')
    $outputPath = Join-Path $fixtureRoot ($stem + '.txt')
    $sourcePath = Join-Path $fixtureRoot ($stem + '.nsi')
    $cases = @(
      @{ Id = 'fresh'; User = ''; Machine = ''; Expected = $product.Default; Suffix = '\t3code' },
      @{ Id = 'custom'; User = $userPath; Machine = $machinePath },
      @{ Id = 'double-separators'; User = $userPath.Replace('\', '\\'); Machine = $machinePath.Replace('\', '\\') },
      @{ Id = 'opposite-scope-only'; User = ''; Machine = ''; Expected = $product.Default; Suffix = '\t3code' }
    )
    if ($mode -eq 'user') { $cases[3].Machine = $otherPath }
    else { $cases[3].User = $otherPath }
    if ($product.Name -eq 'T3 Code (Beta)') {
      $cases += @(
        @{ Id = 'legacy-alpha-managed'; User = $legacyManaged; Machine = $legacyManaged; Expected = (Join-Path $fixtureRoot 'beta/T3 Code (Beta)') },
        @{ Id = 'legacy-alpha-custom'; User = $legacyCustom; Machine = $legacyCustom; Expected = (Join-Path $fixtureRoot 'custom root/T3 Code (Beta)') }
      )
    }
    $body = [Text.StringBuilder]::new()
    [void]$body.AppendLine('Function .onInit')
    [void]$body.AppendLine('!ifndef INSTALL_MODE_PER_ALL_USERS')
    [void]$body.AppendLine('StrCpy $perUserInstallationFolder ""')
    [void]$body.AppendLine('!endif')
    [void]$body.AppendLine('StrCpy $perMachineInstallationFolder ""')
    [void]$body.AppendLine('FileOpen $ProbeOutput "' + $outputPath + '" w')
    foreach ($case in $cases) {
      [void]$body.AppendLine('StrCpy $ProbeUser "' + $case.User + '"')
      [void]$body.AppendLine('StrCpy $ProbeMachine "' + $case.Machine + '"')
      [void]$body.AppendLine($sequence)
      [void]$body.AppendLine('FileWrite $ProbeOutput "' + $case.Id + '|$INSTDIR|$ProbeUser|$ProbeMachine$\r$\n"')
    }
    [void]$body.AppendLine('FileClose $ProbeOutput')
    [void]$body.AppendLine('SetErrorLevel 0')
    [void]$body.AppendLine('Quit')
    [void]$body.AppendLine('FunctionEnd')
    [void]$body.AppendLine('Section')
    [void]$body.AppendLine('SectionEnd')
    $source = $preamble.Replace('@TEMPLATES@', $NsisTemplatesPath).Replace('@PLUGINS@', $StdUtilsPluginPath).Replace('@PRODUCT@', $product.Name).Replace('@EXE@', $probePath).Replace('@FIXTURE@', $fixtureRoot)
    if ($mode -eq 'machine') { $source = '!define INSTALL_MODE_PER_ALL_USERS' + "`n" + $source }
    $source += "`n" + $body.ToString()
    [IO.File]::WriteAllText($sourcePath, $source, $utf8)
    # -PPO cannot load external plugins. The compiler listing observes the actual
    # expanded instructions, including the real StdUtils /D parser.
    $compilerOutput = (& $MakeNsisPath -V4 -WX -INPUTCHARSET UTF8 $sourcePath 2>&1 | Out-String)
    [IO.File]::WriteAllText((Join-Path $fixtureRoot ($stem + '.compile.log')), $compilerOutput, $utf8)
    if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed; see $fixtureRoot/$stem.compile.log" }
    if ($compilerOutput -match '(?im)^\s*(ReadReg\w+|WriteReg\w+|DeleteReg\w+|WriteUninstaller|Exec\w*|Delete|RMDir|SetOutPath):') {
      throw 'Probe safety check failed: compiler listing contains a non-probe side effect.'
    }
    foreach ($override in @('', ('/D=' + $explicitPath), ('/d=' + $lowercasePath), ('/D=' + $missingPath))) {
      $startInfo = [Diagnostics.ProcessStartInfo]::new($probePath)
      $startInfo.UseShellExecute = $false
      $startInfo.CreateNoWindow = $true
      $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
      $startInfo.Arguments = $override
      $startInfo.Environment['TEMP'] = $fixtureRoot
      $startInfo.Environment['TMP'] = $fixtureRoot
      $process = [Diagnostics.Process]::Start($startInfo)
      try {
        $process.WaitForExit()
        $ownedProcesses.Add([pscustomobject]@{ pid = $process.Id; exitCode = $process.ExitCode; exited = $process.HasExited })
        [IO.File]::WriteAllText((Join-Path $fixtureRoot 'owned-processes.json'), ($ownedProcesses | ConvertTo-Json), $utf8)
        if ($process.ExitCode -ne 0) { throw "Private path probe exited $($process.ExitCode)" }
      } finally { $process.Dispose() }
      $lines = [IO.File]::ReadAllLines($outputPath)
      if ($lines.Count -ne $cases.Count) { throw 'Incomplete runtime observations from the path probe.' }
      for ($index = 0; $index -lt $cases.Count; $index++) {
        $case = $cases[$index]
        $actual = $lines[$index].Split('|')
        $expected = $case.Expected
        $registered = if ($mode -eq 'user') { $case.User } else { $case.Machine }
        if (-not $case.ContainsKey('Expected')) {
          $expected = $registered
          if ($case.Id -eq 'double-separators' -and $product.Normalize) {
            $expected = if ($mode -eq 'user') { $userPath } else { $machinePath }
          }
        }
        if ($override) { $expected = $override.Substring(3) }
        $pathMatches = if ($expected) { $actual[1] -ceq $expected } else { $actual[1].EndsWith($case.Suffix) }
        $expectedUser = $case.User
        $expectedMachine = $case.Machine
        if ($case.Id -eq 'double-separators' -and $product.Normalize) {
          if ($mode -eq 'user') { $expectedUser = $userPath }
          else { $expectedMachine = $machinePath }
        }
        $registryMatches = $actual[2] -ceq $expectedUser -and $actual[3] -ceq $expectedMachine
        $observations.Add([pscustomobject]@{ product = $product.Name; mode = $mode; case = $case.Id; override = $override; actual = $actual[1]; expected = $expected; expectedSuffix = $case.Suffix; pathMatches = $pathMatches; registryFixtureMatches = $registryMatches; passed = $pathMatches -and $registryMatches })
      }
    }
  }
}
$failures = @($observations | Where-Object { -not $_.passed })
$result = [ordered]@{ fixtureRoot = $fixtureRoot; sourceCommit = (git -C $repoRoot rev-parse HEAD).Trim(); checks = $observations.Count; passed = $observations.Count - $failures.Count; failed = $failures.Count; observations = $observations; ownedProcesses = $ownedProcesses; allOwnedProcessesExited = @($ownedProcesses | Where-Object { -not $_.exited }).Count -eq 0; registryOperations = 'in-memory fixture only'; knownFolderCreateDisabled = $true; cleanup = 'private probe sources and runtime evidence retained; no recursive deletion attempted' }
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ResultsPath), ($result | ConvertTo-Json -Depth 8), $utf8)
Write-Output ("NSIS path policy: {0} passed, {1} failed; evidence: {2}; fixture: {3}" -f $result.passed, $result.failed, $ResultsPath, $fixtureRoot)
$failures | Select-Object -First 15 product, mode, case, override, actual, expected | Format-Table -AutoSize
if ($failures.Count -gt 0) { throw 'Observed NSIS installation path policy did not match the regression matrix.' }
