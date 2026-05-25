param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Get-Process -Name Livescriber -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*Programs\Livescriber\resources\backend*" -or $_.CommandLine -like "*Programs\Livescriber\resources\.venv*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700

$OldBundledVenv = Join-Path $env:LOCALAPPDATA "Programs\Livescriber\resources\.venv"
if (Test-Path $OldBundledVenv) {
  try {
    Remove-Item -LiteralPath $OldBundledVenv -Recurse -Force
  } catch {
    Write-Warning "Could not remove old bundled backend: $($_.Exception.Message)"
  }
}

$ReleaseDir = Join-Path $Root "release"
if (Test-Path $ReleaseDir) {
  Get-ChildItem -LiteralPath $ReleaseDir -File |
    Where-Object { $_.Name -match '^Livescriber.*\.(exe|blockmap)$|^latest\.yml$|^builder-debug\.yml$' } |
    Remove-Item -Force
}

$Version = node scripts\bump-version.cjs
Write-Host "Building Livescriber $Version"

npm install
npm run dist

$AppPath = Join-Path $ReleaseDir "win-unpacked\Livescriber.exe"
$Installer = Get-ChildItem -Path $ReleaseDir -Filter "*.exe" -File |
  Where-Object { $_.Name -match "Setup|Installer" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Start-Process explorer.exe $ReleaseDir

if (-not $SkipInstall) {
  if (-not $Installer) {
    throw "Installer not found in $ReleaseDir"
  }

  Write-Host "Installing $($Installer.Name)"
  Start-Process -FilePath $Installer.FullName -ArgumentList "/S" -Wait
}

$Candidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Livescriber\Livescriber.exe"),
  (Join-Path $env:LOCALAPPDATA "Livescriber\Livescriber.exe"),
  (Join-Path $env:ProgramFiles "Livescriber\Livescriber.exe"),
  $AppPath
)

$LaunchPath = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $LaunchPath) {
  throw "Built app was not found."
}

Write-Host "Launching $LaunchPath"
Start-Process -FilePath $LaunchPath
