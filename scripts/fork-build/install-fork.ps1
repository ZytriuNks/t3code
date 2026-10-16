#!/usr/bin/env pwsh
# Quiet, retry-free fork install/upgrade helper.
#
# Builds of this fork ship three productNames — `T3 Code (Alpha)`,
# `T3 Code (Experimental)`, and `T3 Code (Dev)` — that install to
# `D:\t3code\<stage>\T3 Code (<stage>)\` and keep their Chromium
# profiles and T3 homes fully isolated. A vanilla silent install
# (`/S`) against an existing fork install triggers the
# `uninstallOldVersion` UninstallLoop in app-builder-lib's
# `installUtil.nsh`, which retries the previous build's uninstaller
# five times and then surfaces the "appCannotBeClosed" dialog with
# default /SD IDCANCEL — clicking Cancel only partially completes
# the uninstall, so the next run finally lands cleanly.
#
# This helper removes the per-user uninstall registry keys for the
# three fork productNames *before* invoking the installer. With no
# uninstall string to find, `uninstallOldVersion` returns
# immediately, the UninstallLoop never runs, and the installer
# overwrites the existing payload in place. User data in
# `%APPDATA%\<stage>\` and `~\.t3-<stage>\userdata\` is left alone,
# so conversation history, settings, and OAuth secrets survive
# every build.
#
# Usage (from a normal PowerShell, chcp 936 is fine):
#
#   pwsh .\scripts\fork-build\install-fork.ps1 -Stage Alpha
#   pwsh .\scripts\fork-build\install-fork.ps1 -Stage Experimental
#   pwsh .\scripts\fork-build\install-fork.ps1 -Stage Dev
#   pwsh .\scripts\fork-build\install-fork.ps1 -Stage All
#
# By default the script installs whatever installer file the caller
# passes via -InstallerPath (or the freshly-built
# `release\T3-Code-T3Code<Stage>-<version>-x64.exe`). -Force stops
# any running T3 build before installing.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Alpha", "Experimental", "Dev", "All")]
  [string]$Stage,

  [string]$InstallerPath,

  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ProductNames = @{
  Alpha         = "T3 Code (Alpha)"
  Experimental  = "T3 Code (Experimental)"
  Dev           = "T3 Code (Dev)"
}

$DefaultInstallers = @{
  Alpha         = "release\T3-Code-T3CodeAlpha-*x64.exe"
  Experimental  = "release\T3-Code-T3CodeExperimental-*x64.exe"
  Dev           = "release\T3-Code-T3CodeDev-*x64.exe"
}

function Remove-ForkUninstallKey {
  param([string]$DisplayNamePattern)

  $uninstallRoot = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
  if (-not (Test-Path $uninstallRoot)) { return }

  Get-ChildItem -Path $uninstallRoot | ForEach-Object {
    $props = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
    if ($null -ne $props -and $props.DisplayName -like $DisplayNamePattern) {
      Write-Host "  Removing uninstall key: $($props.DisplayName)"
      Remove-Item -Path $_.PSPath -Recurse -Force
    }
  }
}

function Stop-RunningT3 {
  if (-not $Force) { return }
  Get-Process | Where-Object {
    $_.Name -like "T3 Code*" -or $_.Name -like "t3-resource-monitor"
  } | ForEach-Object {
    Write-Host "  Stopping $($_.Name) (PID $($_.Id))"
    Stop-Process -Id $_.Id -Force
  }
  Start-Sleep -Seconds 2
}

function Resolve-Installer {
  param([string]$StageName)

  if ($InstallerPath -and (Test-Path $InstallerPath)) {
    return (Resolve-Path $InstallerPath).Path
  }

  $pattern = $DefaultInstallers[$StageName]
  $candidates = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if (-not $candidates) {
    throw "No installer found matching $pattern. Pass -InstallerPath explicitly."
  }
  return $candidates[0].FullName
}

function Invoke-SilentInstall {
  param(
    [string]$StageName,
    [string]$Installer
  )

  $productName = $ProductNames[$StageName]
  Write-Host ""
  Write-Host "[$StageName] Removing prior uninstall registry entry for $productName"
  Remove-ForkUninstallKey -DisplayNamePattern "$productName*"

  Stop-RunningT3

  Write-Host "[$StageName] Installing $Installer (silent)"
  $proc = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
  Write-Host "[$StageName] Installer exit code: $($proc.ExitCode)"
  if ($proc.ExitCode -ne 0) {
    throw "Installer for $StageName exited with code $($proc.ExitCode)"
  }
}

$stages = if ($Stage -eq "All") {
  "Alpha", "Experimental", "Dev"
} else {
  $Stage
}

foreach ($s in $stages) {
  $installer = Resolve-Installer -StageName $s
  Invoke-SilentInstall -StageName $s -Installer $installer
}

Write-Host ""
Write-Host "All installs complete."
