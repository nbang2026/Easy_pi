# Compatibility entrypoint: source-only delivery. Does not compile or install an app.
param([string]$Output)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
function Invoke-Native([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
foreach ($name in @("node", "pnpm")) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $name" }
}
$version = & node -p "process.versions.node"
if ($LASTEXITCODE -ne 0 -or [Version]$version -lt [Version]'22.19.0') { throw "Node >=22.19.0 is required" }
Invoke-Native "pnpm" @("install", "--frozen-lockfile")
Invoke-Native "node" @("scripts/prepare-windows-runtime.mjs")
Invoke-Native "pnpm" @("check")
Invoke-Native "pnpm" @("test")
if ($Output) { Invoke-Native "node" @("scripts/package-source.mjs", ("--output=" + $Output)) }
else { Invoke-Native "node" @("scripts/package-source.mjs") }
Write-Host "Windows source-only delivery completed. No application executable was built."
