# Run only in a disposable Windows account/CI. NSIS writes registry and shortcuts.
# Local build-windows.ps1 skips this unless -VerifyInstallers is supplied.
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Msi
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$Msi = (Resolve-Path -LiteralPath $Msi).Path
if (-not $Installer.EndsWith('.exe') -or -not $Msi.EndsWith('.msi')) { throw "Expected NSIS exe and MSI installer" }
$label = -join ([char]0x6D4B, [char]0x8BD5)
$testRoot = Join-Path $env:TEMP ("N B PI " + $label + " " + [Guid]::NewGuid().ToString('N'))
$installPath = Join-Path $testRoot "installed"
$adminPath = Join-Path $testRoot "msi payload"
$oldRuntime = $env:PI_GUI_SMOKE_RUNTIME
$oldPath = $env:PI_GUI_SMOKE_PATH
function Run-Installer([string]$Program, [string]$Arguments) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Program
  $info.Arguments = $Arguments
  $info.UseShellExecute = $false
  $process = [System.Diagnostics.Process]::Start($info)
  if (-not $process.WaitForExit(300000)) { $process.Kill(); throw "Installer timeout" }
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw "Installer failed: $($process.ExitCode)" }
}
function Test-Payload([string]$Root) {
  $node = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter node.exe | Where-Object { $_.FullName -like '*runtime\windows-x64\node\node.exe' } | Select-Object -First 1
  if ($null -eq $node) { throw "Installer payload is missing runtime/windows-x64/node/node.exe" }
  $runtimePath = Split-Path (Split-Path $node.FullName -Parent) -Parent
  & node scripts/check-windows-runtime.mjs ("--runtime=" + $runtimePath) --require-windows
  if ($LASTEXITCODE -ne 0) { throw "Installed runtime validation failed" }
  $env:PI_GUI_SMOKE_RUNTIME = Split-Path (Split-Path $runtimePath -Parent) -Parent
  $env:PI_GUI_SMOKE_PATH = (Join-Path $env:SystemRoot "System32") + ";" + $env:SystemRoot
  & cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib real_pi_launch -- --ignored
  if ($LASTEXITCODE -ne 0) { throw "Installed runtime PTY and bridge smoke test failed" }
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  # NSIS requires /D last; the remainder is the unquoted destination path.
  Run-Installer $Installer ("/S /D=" + $installPath)
  Test-Payload $installPath
  # Administrative MSI extraction validates its own payload without registering a second app.
  $arguments = '/a "' + $Msi + '" /qn TARGETDIR="' + $adminPath + '" /norestart /l*v "' + (Join-Path $testRoot 'msi.log') + '"'
  Run-Installer (Join-Path $env:SystemRoot "System32/msiexec.exe") $arguments
  Test-Payload $adminPath
  Write-Host "PASS: NSIS/MSI payloads and real Pi PTY/bridge with spaces and Unicode in the path."
} finally {
  $env:PI_GUI_SMOKE_RUNTIME = $oldRuntime
  $env:PI_GUI_SMOKE_PATH = $oldPath
  $uninstaller = Join-Path $installPath "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller) { Run-Installer $uninstaller ("/S _?=" + $installPath) }
  # Remove only this script's uniquely generated test directory.
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
