param([switch]$VerifyInstallers)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
if (-not $IsWindows -and $env:OS -ne "Windows_NT") { throw "A native Windows host is required." }
foreach ($name in @("node", "pnpm", "bun", "cargo", "rustup")) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $name" }
}
$nodeVersion = & node -p "process.versions.node"
if ($LASTEXITCODE -ne 0 -or [Version]$nodeVersion -lt [Version]"22.19.0") { throw "Node 22.19+ is required." }
Invoke-Checked "pnpm" @("install", "--frozen-lockfile")
Push-Location "agent-runtime"
try {
  Invoke-Checked "bun" @("install", "--frozen-lockfile")
} finally {
  Pop-Location
}
Invoke-Checked "rustup" @("target", "add", "x86_64-pc-windows-msvc")
Invoke-Checked "node" @("scripts/prepare-windows-runtime.mjs")
Invoke-Checked "node" @("scripts/check-windows-runtime.mjs", "--require-windows")
Invoke-Checked "node" @("scripts/prepare-claude-runtime.mjs", "--platform", "win32", "--arch", "x64")
Invoke-Checked "node" @("scripts/prepare-claude-runtime.mjs", "--platform", "win32", "--arch", "x64", "--check")
$priorRuntime = $env:PI_GUI_SMOKE_RUNTIME
$priorNode = $env:PI_GUI_SMOKE_NODE
$priorSmokePath = $env:PI_GUI_SMOKE_PATH
$priorProjectTrust = $env:PI_GUI_SMOKE_PROJECT_TRUST
try {
  $env:PI_GUI_SMOKE_RUNTIME = (Resolve-Path "src-tauri").Path
  $env:PI_GUI_SMOKE_NODE = (Resolve-Path "src-tauri/runtime/windows-x64/node/node.exe").Path
  $env:PI_GUI_SMOKE_PATH = (Join-Path $env:SystemRoot "System32") + ";" + $env:SystemRoot
  Invoke-Checked "pnpm" @("verify")
  foreach ($decision in @("deny", "allow")) {
    $env:PI_GUI_SMOKE_PROJECT_TRUST = $decision
    Invoke-Checked "cargo" @("test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "gui_bridge::tests::real_pi_launch_uses_the_app_transport", "--", "--ignored", "--exact")
  }
  $env:PI_GUI_SMOKE_PROJECT_TRUST = $priorProjectTrust
  # Preserve existing bundles before the bundler creates new files.
  $bundle = "src-tauri/target/x86_64-pc-windows-msvc/release/bundle"
  if (Test-Path -LiteralPath $bundle) {
    Move-Item -LiteralPath $bundle -Destination ($bundle + ".backup-" + [Guid]::NewGuid().ToString("N"))
  }
  Invoke-Checked "pnpm" @("exec", "tauri", "build", "--target", "x86_64-pc-windows-msvc", "--config", "src-tauri/tauri.windows.release.conf.json")
  $installer = Get-ChildItem -Path "$bundle/nsis/*.exe" -File | Select-Object -First 1
  $msi = Get-ChildItem -Path "$bundle/msi/*.msi" -File | Select-Object -First 1
  if (-not $installer -or -not $msi) { throw "Both NSIS and MSI artifacts are required." }
  if ($VerifyInstallers) {
    & (Join-Path $PSScriptRoot "verify-windows-installer.ps1") -Installer $installer.FullName -Msi $msi.FullName
    if (-not $?) { throw "Installer verification failed." }
  }
  Write-Host "Unsigned Windows packages built. Publisher signing and desktop acceptance are still required."
} finally {
  $env:PI_GUI_SMOKE_RUNTIME = $priorRuntime
  $env:PI_GUI_SMOKE_NODE = $priorNode
  $env:PI_GUI_SMOKE_PATH = $priorSmokePath
  $env:PI_GUI_SMOKE_PROJECT_TRUST = $priorProjectTrust
}
