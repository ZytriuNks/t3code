#!/usr/bin/env pwsh
# Upgrade the selected fork identity in its existing directory and verify the
# installed executable. The installer normalizes legacy registry paths before
# running the previous uninstaller; do not delete those registrations here.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Beta", "Experimental", "Dev", "All")]
  [string]$Stage,
  [string]$InstallerPath,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if ($Force) {
  throw "-Force no longer stops applications. Close the selected build before installing."
}
if ($Stage -eq "All" -and $InstallerPath) {
  throw "-InstallerPath requires one explicit stage; it cannot be combined with -Stage All."
}

function Get-StageRegistration {
  param([string]$StageName)
  $names = @("T3 Code ($StageName)")
  if ($StageName -eq "Beta") { $names += "T3 Code (Alpha)" }
  # electron-builder UUIDv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3).
  # Product names alone also match unrelated installer test fixtures.
  $registrationId = @{
    Beta = 'e9197887-efb3-55e0-985e-d6d3b5dd594a'
    Experimental = 'bee175e3-62b3-5e46-bb5f-55ee1d5c3777'
    Dev = '4a437592-6b9b-53cc-bc69-2310317c1143'
  }[$StageName]
  foreach ($hive in @("HKCU:", "HKLM:")) {
    $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$registrationId"
    if (Test-Path -LiteralPath $key) {
      $entry = Get-ItemProperty -LiteralPath $key
      $matchesName = @($names | Where-Object {
        $entry.DisplayName -eq $_ -or $entry.DisplayName -like "$_ *"
      }).Count -gt 0
      if (-not $matchesName) { throw "Registered identity does not match $StageName." }
      $installKey = "$hive\SOFTWARE\$registrationId"
      $directory = $null
      if (Test-Path -LiteralPath $installKey) {
        $directory = (Get-ItemProperty -LiteralPath $installKey).InstallLocation
      }
      if (-not $directory -and $entry.UninstallString -match '^"([^\"]+)"') {
        $directory = Split-Path -Parent $Matches[1]
      }
      if (-not $directory) { throw "Cannot resolve the installed directory for $($entry.DisplayName)." }
      [pscustomobject]@{
        Directory = [IO.Path]::GetFullPath($directory).TrimEnd('\')
        DisplayName = $entry.DisplayName
        DisplayVersion = $entry.DisplayVersion
      }
    }
  }
}

function Resolve-InstallDirectory {
  param([string]$StageName)
  $directories = @(Get-StageRegistration $StageName | Select-Object -ExpandProperty Directory -Unique)
  if ($directories.Count -gt 1) {
    throw "Multiple $StageName installations are registered. Resolve the duplicate installation directories first."
  }
  if ($directories.Count -eq 1) { return $directories[0] }

  $legacyStage = if ($StageName -eq "Beta") { "Alpha" } else { $StageName }
  $executableName = "T3 Code ($legacyStage)"
  $candidates = @()
  if ($StageName -eq "Beta" -and $env:T3CODE_ALPHA_INSTALL_DIR) {
    $candidates += $env:T3CODE_ALPHA_INSTALL_DIR
  }
  $candidates += "D:\t3code\$($legacyStage.ToLowerInvariant())\$executableName"
  $candidates += Join-Path $env:LOCALAPPDATA "Programs\$executableName"
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate "$executableName.exe")) {
      return [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    }
  }
  return Join-Path $env:LOCALAPPDATA "Programs\T3 Code ($StageName)"
}

function Resolve-Installer {
  param([string]$StageName)
  if ($InstallerPath) {
    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
      throw "Installer does not exist: $InstallerPath"
    }
    return (Resolve-Path -LiteralPath $InstallerPath).Path
  }
  $pattern = Join-Path $PSScriptRoot "../../release/T3-Code-T3Code$StageName-*x64.exe"
  $candidates = @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if ($candidates.Count -eq 0) { throw "No $StageName installer found. Pass -InstallerPath explicitly." }
  return $candidates[0].FullName
}

$stages = if ($Stage -eq "All") { @("Beta", "Experimental", "Dev") } else { @($Stage) }
# Validate all selected packages before starting the first installation.
$plans = foreach ($name in $stages) {
  $installer = Resolve-Installer $name
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
  if ($version.ProductName -ne "T3 Code ($name)" -or -not $version.FileVersion) {
    throw "Installer identity does not match $name`: $installer"
  }
  [pscustomobject]@{ Stage = $name; Installer = $installer; Version = $version.FileVersion; Directory = Resolve-InstallDirectory $name }
}

foreach ($plan in $plans) {
  $prefix = $plan.Directory.TrimEnd('\') + '\'
  $running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($running.Count -gt 0) {
    throw "Close $($plan.Stage) before installing (process IDs: $($running.ProcessId -join ', '))."
  }
  Write-Host "[$($plan.Stage)] Installing $($plan.Version) to $($plan.Directory)"
  # NSIS requires /D to be the final, unquoted argument, including spaces.
  $proc = Start-Process -FilePath $plan.Installer -ArgumentList @('/S', "/D=$($plan.Directory)") -WindowStyle Hidden -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "Installer for $($plan.Stage) exited with code $($proc.ExitCode)." }

  $executableName = if ($plan.Stage -eq "Beta") { "T3 Code (Alpha)" } else { "T3 Code ($($plan.Stage))" }
  $executable = Join-Path $plan.Directory "$executableName.exe"
  if (-not (Test-Path -LiteralPath $executable)) { throw "Installed executable is missing: $executable" }
  $installed = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
  $registrations = @(Get-StageRegistration $plan.Stage)
  if ($installed.ProductName -ne "T3 Code ($($plan.Stage))" -or $installed.FileVersion -ne $plan.Version -or
      $registrations.Count -ne 1 -or $registrations[0].Directory -ne $plan.Directory -or
      $registrations[0].DisplayName -notlike "T3 Code ($($plan.Stage))*" -or $registrations[0].DisplayVersion -ne $plan.Version) {
    throw "Post-install verification failed for $($plan.Stage): executable, registry version, or destination does not match."
  }
  Write-Host "[$($plan.Stage)] Verified installed version $($plan.Version): $executable"
}
