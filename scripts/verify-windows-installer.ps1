# Run only in a disposable Windows account/CI. NSIS writes registry and shortcuts.
# Invoked by build-desktop-windows.ps1 only when -VerifyInstallers is supplied.
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
$oldClaudeSmoke = $env:EASY_PI_CLAUDE_SMOKE_RESOURCES
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
  $claudeRuntime = Join-Path $env:PI_GUI_SMOKE_RUNTIME "claude-runtime"
  & node scripts/prepare-claude-runtime.mjs --platform win32 --arch x64 --check --runtime $claudeRuntime
  if ($LASTEXITCODE -ne 0) { throw "Installed Claude runtime validation failed" }
  $env:EASY_PI_CLAUDE_SMOKE_RESOURCES = $claudeRuntime
  $env:PI_GUI_SMOKE_PATH = (Join-Path $env:SystemRoot "System32") + ";" + $env:SystemRoot
  & cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib real_pi_launch -- --ignored
  if ($LASTEXITCODE -ne 0) { throw "Installed runtime PTY and bridge smoke test failed" }
  $priorTrust = $env:PI_GUI_SMOKE_PROJECT_TRUST
  try {
    foreach ($decision in @("deny", "allow")) {
      $env:PI_GUI_SMOKE_PROJECT_TRUST = $decision
      & cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib gui_bridge::tests::real_pi_launch_uses_the_app_transport -- --ignored --exact
      if ($LASTEXITCODE -ne 0) { throw "Installed Pi project-trust startup failed: $decision" }
    }
  } finally { $env:PI_GUI_SMOKE_PROJECT_TRUST = $priorTrust }
  & cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --lib claude_staged_runtime_smoke -- --ignored
  if ($LASTEXITCODE -ne 0) { throw "Installed Claude runtime smoke test failed" }
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
  Write-Host "PASS: NSIS/MSI payloads and Pi/Claude runtime smoke tests with spaces and Unicode in the path."
} finally {
  $env:PI_GUI_SMOKE_RUNTIME = $oldRuntime
  $env:PI_GUI_SMOKE_PATH = $oldPath
  $env:EASY_PI_CLAUDE_SMOKE_RESOURCES = $oldClaudeSmoke
  $uninstaller = Join-Path $installPath "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller) { Run-Installer $uninstaller ("/S _?=" + $installPath) }
  # Remove only this script's uniquely generated test directory.
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
