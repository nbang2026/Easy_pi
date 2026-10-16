# Windows runtime packaging

The installer resources contain Node 22.22.2 (Windows x64), npm, and Pi CLI 1.3.0 with the complete production dependency tree. They are not installed globally.

## Preparation
`runtime-assets/windows-x64-offline.zip` is included in this source kit. After installing the frontend build dependencies, run:

```sh
node scripts/prepare-windows-runtime.mjs
node scripts/prepare-windows-runtime.mjs --check
```

The archive checksum and full dependency/Node tree SHA-256 hashes are pinned in `scripts/windows-runtime.lock.json`; provenance is in `windows-runtime-pins.json`. Preparation rejects path traversal, expands only `.local/node` and `.local/app/node_modules`, and excludes the old launcher and personal configuration. The stage is `src-tauri/runtime/windows-x64/` (gitignored); do not edit its contents or line endings. `PI_WINDOWS_RUNTIME_ARCHIVE` can override the archive location, but its bytes must match the pinned checksum. No network download or package install occurs at application startup.

Both the local Windows build and CI use the same preparation step. The Tauri Windows configuration maps the entire stage directory, preserving the dependency hierarchy, to `$RESOURCE/runtime/windows-x64/`. The build hook refuses a missing/damaged stage. A valid explicit PI_EXECUTABLE overrides bundled Pi; otherwise the bundle is preferred over external installations. A present but incomplete bundle produces a repair error rather than silently using another Pi. Rust invokes bundled node.exe with an absolute JS entrypoint, not a batch shell.

## Build and verification
On Windows x64, use Node >=22.19, pnpm 9, Rust MSVC x64 and Visual Studio C++ Build Tools/Windows SDK. From `pi-app`, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

The script stops on native command failures, preserves old bundle directories under unique backup names, runs frontend/Rust tests and native Windows runtime smoke checks, then builds NSIS/MSI. WebView2 uses `offlineInstaller`: building requires downloading its official installer; the finished installer is configured to carry it. This is separate from Node/Pi. Git/Git Bash and project-specific SDKs are not included.

`-VerifyInstallers` also performs a temporary NSIS installation and administrative MSI extraction. Use it only in a disposable Windows account: NSIS registers shortcuts/uninstall information. It checks every payload hash, node/Pi/npm/native-module loading without external Node/Pi in PATH, and runs a real offline Pi PTY/bridge test against the installed payload in a space/Unicode path. CI performs these checks before uploading. No CI workflow has been submitted from this Mac.

## Platform boundary
Mac unit tests and a Mac real-Pi smoke test are not Windows execution evidence. This delivery contains a rebuilt ad-hoc-signed Mac preview and a self-contained Windows *source kit*, not a new Windows exe. Windows native build, installation/uninstallation, ConPTY and WebView2 tests remain pending until the script or CI actually runs there.

## Runtime updates
Versions intentionally match the supplied Pi environment. Update the official runtime archive, provenance and all tree hashes together after review; changing only a checksum to mask corruption is not supported. Preserve all package license/notice files. No API keys, user profiles, credentials or sessions are bundled.
