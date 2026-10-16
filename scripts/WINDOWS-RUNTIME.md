# Windows runtime and source delivery

[中文首页](../README.md) · [English overview](../README.en.md) · [开发指南](../docs/DEVELOPMENT.md)

> **Current boundary:** the checked-in Windows workflow produces a source archive, not a Windows application or installer. `build-windows.ps1` does not build NSIS/MSI, and `tauri.windows.conf.json` sets `bundle.active` to `false`. Historical installer verification helpers are not evidence that a release has passed Windows testing.

## 1. Pinned runtime

The runtime preparation code expects:

| Component | Pinned value |
| --- | --- |
| Node | 22.22.2, Windows x64 |
| Pi CLI | `@earendil-works/pi-coding-agent` 1.3.0 |
| Archive default | `runtime-assets/windows-x64-offline.zip` |
| Staging directory | `src-tauri/runtime/windows-x64/` |
| Provenance | `scripts/windows-runtime-pins.json` |
| SHA-256 manifest | `scripts/windows-runtime.lock.json` |

The archive must contain the matching Node/npm tree and Pi production dependency tree. Git/Git Bash and project-specific compilers/SDKs are **not** included. An offline runtime does not make model inference offline: remote model providers and network tools still require network access.

## 2. Required input is not tracked in Git

Both `runtime-assets/` and `src-tauri/runtime/` are gitignored. The current Git tree does **not** include the expected offline archive. A fresh clone therefore cannot prepare the runtime or create the source kit without an additional, verified input. Preparation does not download it automatically.

Obtain the exact trusted archive from the maintainer's distribution process. Do not treat an arbitrary Node/Pi ZIP as compatible, weaken verification, or replace the expected hash just to bypass a failure. A complete runtime regeneration procedure and a downloadable matching archive are not provided by this Git tree.

After installing the frontend dependencies, run from the repository root:

```powershell
# Optional: select an existing archive outside the checkout.
$env:PI_WINDOWS_RUNTIME_ARCHIVE = 'C:\trusted-assets\windows-x64-offline.zip'
node scripts/prepare-windows-runtime.mjs
node scripts/prepare-windows-runtime.mjs --check
```

The override only changes the input path; bytes must still match the pinned archive hash. Preparation validates archive paths and tree hashes, rejects traversal/symlinks, and stages only the intended Node and application dependency trees. Do not edit staged files or rewrite their line endings.

**Important distinction:** `scripts/package-source.mjs` requires the archive at the literal repository path `runtime-assets/windows-x64-offline.zip`. Setting `PI_WINDOWS_RUNTIME_ARCHIVE` for preparation does not satisfy the source-packager input requirement. For source-kit creation, the matching archive must also exist at that default path.

## 3. Source-kit entrypoint

Use Node >=22.19 and pnpm 9 from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Output artifacts/easy_pi-windows-source.zip
```

The actual sequence is:

1. Check that Node and pnpm are present.
2. Install frontend dependencies using the frozen lockfile.
3. Prepare and validate the pinned Windows runtime.
4. Run TypeScript checks and frontend/script tests.
5. Call `scripts/package-source.mjs` to write a source ZIP.

The wrapper accepts `-Output`; it does **not** accept or implement `-VerifyInstallers`. An explicit output path avoids the packager's legacy Desktop-based default. The source packager refuses to overwrite an existing output file; choose a new name or deliberately manage the previous file.

The source archive contains repository files and the matching runtime archive, excludes Git metadata, node_modules, build output and runtime staging, and refuses source symlinks. It is a **source kit containing a binary Node runtime**, not an entirely source-only dependency distribution. It is not an `.exe` or `.msi`.

## 4. Current GitHub Actions workflow

`.github/workflows/windows.yml` is manually triggered with `workflow_dispatch`. It checks out source, uses Node 22.22.2 and pnpm 9, installs dependencies, prepares the runtime, runs frontend checks/tests, and uploads a source archive.

There is currently no workflow step that retrieves the untracked offline archive. Until that trusted input is supplied, a fresh CI checkout cannot complete the runtime-preparation stage. The workflow does not run Cargo tests, build installers, or test installation/uninstallation. Do not present it as a green Windows release pipeline without actual successful run evidence.

## 5. Desktop runtime resolution

The backend resolves Pi in this order:

1. An explicit, valid, absolute `PI_EXECUTABLE`. Invalid overrides fail rather than silently falling back.
2. A complete bundled Windows runtime when present in application resources.
3. External Pi discovery when there is no bundled runtime.

An existing but incomplete bundle reports a repair error rather than hiding the issue with another installation. Bundled Pi is invoked with an absolute `node.exe` and JavaScript entrypoint, preserving paths with spaces/Unicode. Starting the application does not install Node/Pi or download the runtime.

## 6. Native Windows and installer validation

Native development additionally needs Rust MSVC x64, Visual Studio C++ Build Tools, Windows SDK and Tauri/WebView2 prerequisites. For desktop development after preparing dependencies/runtime:

```powershell
pnpm tauri dev --config src-tauri/tauri.windows.conf.json
```

The Windows configuration declares resource mapping and NSIS/MSI targets but disables bundling. Restoring an installer release path requires an explicit configuration/release change and real Windows validation; the source-kit command above does not perform it. WebView2's `offlineInstaller` setting applies when installers are actually built, and its installer is separate from Node/Pi.

`scripts/check-windows-runtime.mjs` contains runtime checks; `scripts/verify-windows-installer.ps1` is a legacy helper for testing actual installers in a **disposable Windows account**. Inspect its parameters before invoking it. It may register shortcuts/uninstall information and perform MSI administrative extraction. It is not called by the current source wrapper or CI.

A proper Windows release should separately record runtime hashes, native module loading, ConPTY/bridge behavior, WebView2, Unicode/space paths, signing, install and uninstall results. macOS unit tests or a macOS Pi smoke test are not substitutes.

## 7. Updating and redistributing the runtime

Update the archive, provenance, Node/Pi versions, dependency tree hashes and backend compatibility expectations together. Keep upstream license/notice files intact. Never bundle provider credentials, a developer's Pi profile, API keys, private sessions or debug logs. Project MIT licensing does not replace the licenses of bundled third-party components.
