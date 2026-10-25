$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "install-fork.ps1"
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors.Message -join "`n") }

# Load only function definitions; tests must never execute the installer entry point.
foreach ($definition in $ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst]
}, $false)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}

function Assert-Equal($Actual, $Expected) {
  if ($Actual -ne $Expected) { throw "Expected '$Expected', received '$Actual'." }
}

function Assert-Throws([scriptblock]$Action, [string]$Expected) {
  try { & $Action } catch {
    if ($_.Exception.Message -notlike "*$Expected*") { throw }
    return
  }
  throw "Expected failure containing '$Expected'."
}

& {
  function Test-Path {
    param($LiteralPath)
    return $LiteralPath.StartsWith('HKCU:')
  }
  function Get-ItemProperty {
    param($LiteralPath)
    if (-not $LiteralPath.EndsWith('4a437592-6b9b-53cc-bc69-2310317c1143')) {
      throw 'Read an unrelated application registration.'
    }
    if ($LiteralPath.Contains('Uninstall')) {
      return [pscustomobject]@{ DisplayName = 'T3 Code (Dev) 1.0.0'; DisplayVersion = '1.0.0' }
    }
    return [pscustomobject]@{ InstallLocation = 'D:\\custom\\Dev' }
  }
  $registration = @(Get-StageRegistration Dev)
  Assert-Equal $registration.Count 1
  Assert-Equal $registration[0].Directory 'D:\custom\Dev'
}

& {
  function Get-StageRegistration {
    [pscustomobject]@{ Directory = 'D:\custom\existing Alpha'; DisplayName = 'T3 Code (Alpha) 1.0.0' }
  }
  Assert-Equal (Resolve-InstallDirectory Beta) 'D:\custom\existing Alpha'
}

$betaDirectories = @(
  @{ Before = 'D:\t3code\alpha\T3 Code (Alpha)'; After = 'D:\t3code\beta\T3 Code (Beta)' },
  @{ Before = 'D:\Apps\T3 Code (Alpha)'; After = 'D:\Apps\T3 Code (Beta)' },
  @{ Before = 'D:\Apps\ALPHA\T3 CODE (ALPHA)'; After = 'D:\Apps\beta\T3 Code (Beta)' },
  @{ Before = 'D:\t3code\beta\T3 Code (Beta)'; After = 'D:\t3code\beta\T3 Code (Beta)' },
  @{ Before = 'D:\custom\existing Alpha'; After = 'D:\custom\existing Alpha' },
  @{ Before = 'D:\alpha-projects\T3 Code (Alpha)'; After = 'D:\alpha-projects\T3 Code (Beta)' },
  @{ Before = 'D:\T3 Code (Alpha)'; After = 'D:\T3 Code (Beta)' }
)
foreach ($directory in $betaDirectories) {
  Assert-Equal (Resolve-BetaInstallDirectory $directory.Before) $directory.After
}

$installLoop = $ast.EndBlock.Statements | Where-Object {
  $_ -is [Management.Automation.Language.ForEachStatementAst] -and $_.Variable.VariablePath.UserPath -eq 'plan'
}
$processPaths = @(
  @{ Path = 'D:\sandbox\alpha\T3 Code (Alpha)\T3 Code (Alpha).exe'; Error = 'Close Beta before installing' },
  @{ Path = 'D:\sandbox\beta\T3 Code (Beta)\T3 Code (Beta).exe'; Error = 'Close Beta before installing' },
  @{ Path = 'D:\sandbox\alpha\T3 Code (Alpha) other\unrelated.exe'; Error = 'Installer launch reached' }
)
foreach ($process in $processPaths) {
  & {
    function Get-CimInstance {
      [pscustomobject]@{ ExecutablePath = $process.Path; ProcessId = 123 }
    }
    function Start-Process { throw 'Installer launch reached' }
    $plans = @([pscustomobject]@{
      Stage = 'Beta'; Version = '1.0.0'; Installer = 'unused.exe'
      PreviousDirectory = 'D:\sandbox\alpha\T3 Code (Alpha)'
      Directory = 'D:\sandbox\beta\T3 Code (Beta)'
    })
    Assert-Throws { & ([scriptblock]::Create($installLoop.Extent.Text)) 6>$null } $process.Error
  }
}

& {
  function Get-StageRegistration {
    [pscustomobject]@{ Directory = 'D:\one' }
    [pscustomobject]@{ Directory = 'D:\two' }
  }
  Assert-Throws { Resolve-InstallDirectory Experimental } 'Multiple Experimental installations'
}

& {
  function Get-StageRegistration {
    [pscustomobject]@{ Directory = 'D:\same' }
    [pscustomobject]@{ Directory = 'D:\same' }
  }
  Assert-Equal (Resolve-InstallDirectory Dev) 'D:\same'
}

& {
  $InstallerPath = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.exe')
  Assert-Throws { Resolve-Installer Dev } 'Installer does not exist'
}

# These invalid invocations must fail before registry mutation or process launch.
$pwsh = (Get-Process -Id $PID).Path
$cases = @(
  @{ Args = @('-Stage', 'Dev', '-Force'); Error = '-Force no longer stops applications' },
  @{ Args = @('-Stage', 'All', '-InstallerPath', $pwsh); Error = 'cannot be combined with -Stage All' },
  @{ Args = @('-Stage', 'Dev', '-InstallerPath', $pwsh); Error = 'Installer identity does not match Dev' }
)
foreach ($case in $cases) {
  $arguments = $case.Args
  $output = & $pwsh -NoProfile -File $scriptPath @arguments 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0 -or $output -notlike "*$($case.Error)*") {
    throw "Unexpected preflight result: $output"
  }
}
Write-Output '18 installer helper regression checks passed.'
