# Windows runtime packaging

The Windows installer carries two target-specific runtime trees: Node 22.22.2 (Windows x64), npm, and Pi CLI 1.3.0 with its production dependencies; plus the Claude Agent SDK/DSH runtime, including the native `claude.exe` and all production dependencies. They are not installed globally. Claude uses the bundled Node runtime on Windows, so users do not need a separate Node installation.

## Preparation
`runtime-assets/windows-x64-offline.zip` is included in this source kit. On a Windows x64 build host, install the frontend dependencies and Bun, then stage both runtime trees:

```powershell
node scripts/prepare-windows-runtime.mjs
node scripts/prepare-windows-runtime.mjs --check
Push-Location agent-runtime
bun install --frozen-lockfile
Pop-Location
node scripts/prepare-claude-runtime.mjs --platform win32 --arch x64
node scripts/prepare-claude-runtime.mjs --platform win32 --arch x64 --check
```

The Pi archive checksum and full dependency/Node tree SHA-256 hashes are pinned in `scripts/windows-runtime.lock.json`; provenance is in `windows-runtime-pins.json`. Preparation rejects path traversal, expands only `.local/node` and `.local/app/node_modules`, and excludes the old launcher and personal configuration. The stage is `src-tauri/runtime/windows-x64/` (gitignored). The Claude stage is `src-tauri/claude-runtime/`; it is generated from the exact locked production dependency closure and its target-specific manifest and file hashes are verified before bundling. Do not edit either stage manually. `PI_WINDOWS_RUNTIME_ARCHIVE` can override the Pi archive location, but its bytes must match the pinned checksum. No network download or package install occurs at application startup.

Both the local Windows build and CI stage and validate these resources before packaging. The Tauri Windows configuration maps them to `$RESOURCE/runtime/windows-x64/` and `$RESOURCE/claude-runtime/`; the build hook refuses a missing, damaged, or wrong-platform stage. A valid explicit PI_EXECUTABLE overrides bundled Pi; otherwise the bundle is preferred over external installations. A present but incomplete bundle produces a repair error rather than silently using another Pi. Rust invokes bundled `node.exe` with an absolute JS entrypoint, not a batch shell. Claude also prefers this bundled Node unless the user explicitly configures a Node executable.

## Build and verification
On Windows x64, use Node >=22.19, pnpm 9, Bun, Rust MSVC x64 and Visual Studio C++ Build Tools/Windows SDK. From `pi-app`, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-desktop-windows.ps1
```

The script stops on native command failures, preserves old bundle directories under unique backup names, runs frontend/Rust tests and native Windows runtime smoke checks, then builds NSIS/MSI. WebView2 uses `offlineInstaller`: building requires downloading its official installer; the finished installer is configured to carry it. This is separate from Node/Pi/Claude. Git/Git Bash and project-specific SDKs are not included.

`-VerifyInstallers` also performs a temporary NSIS installation and administrative MSI extraction. Use it only in a disposable Windows account: NSIS registers shortcuts/uninstall information. It checks Pi payload hashes and native-module loading without external Node/Pi in PATH, validates the installed Claude manifest and every file hash, then runs offline Pi PTY/bridge and Claude sidecar status tests against the installed payload in a space/Unicode path. These tests make no model requests. CI performs these checks before uploading.

## Platform boundary
The 72 MB `Windows-Source.zip` is a source kit that contains a compressed 66 MB Pi runtime archive; it is not the installed application and does not represent installer size. A Windows installer is only complete after the native Windows build expands and bundles both runtime trees. Mac unit tests and Mac smoke tests are not Windows execution evidence. Windows native build, installation/uninstallation, ConPTY and WebView2 tests must pass on Windows before calling the installer verified.

## Runtime updates
Versions intentionally match the supplied Pi environment. Update the official runtime archive, provenance and all tree hashes together after review; changing only a checksum to mask corruption is not supported. Preserve all package license/notice files. No API keys, user profiles, credentials or sessions are bundled.
