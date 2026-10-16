<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi application icon" />
  <h1>easy_pi</h1>
  <p><strong>A desktop workspace for the Pi coding agent.</strong></p>
  <p>Version 1.0.3 · Tauri v2 · Rust · TypeScript · Vite · xterm.js</p>
  <p><strong><a href="https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg">⬇ Direct download · macOS Apple Silicon (DMG)</a></strong></p>
  <p><a href="README.md">简体中文</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">All releases</a> · <a href="docs/USAGE.md">Usage (中文)</a> · <a href="docs/ARCHITECTURE.md">Architecture (中文)</a> · <a href="LICENSE">MIT License</a></p>
</div>

---

## What is easy_pi?

**easy_pi is an open-source desktop GUI and local workbench for [Pi Coding Agent](https://pi.dev).**

Pi is a terminal coding agent that uses models and local tools to explore code, modify projects, investigate problems and perform development tasks. easy_pi runs the real Pi CLI inside a native desktop window and adds model management, workspace files and Git review, session access, text Agents, local notes and appearance settings.

You can keep using Pi's terminal interaction and commands while managing connections, adding file references and switching task roles through graphical controls. **Pi and the configured model perform the tasks; easy_pi provides the desktop environment rather than a separate hosted model service.**

### What can it do?

- **Development:** work with project files on code exploration, implementation, debugging and tests.
- **Review and project organization:** use code-review, architecture or release-checking roles to structure a task.
- **Documentation and analysis:** reuse writing, data-analysis and planning workflows.
- **Model connections:** maintain providers and model settings without relying only on manual JSON editing.
- **Reusable context:** save role definitions, project notes and conventions for subsequent tasks.
- **Local change review:** browse files, edit text, inspect Git diffs and stage or unstage files in one workspace.

## Download and install

> [!IMPORTANT]
> **Windows development notice**
>
> The Windows version is still in development; no exe/MSI installer has been released, and the current Windows source and runtime-preparation workflow is for development and verification only.
>
> This section and [Releases](https://github.com/nbang2026/Easy_pi/releases) will be updated when the Windows version is released; stay tuned for announcements.

### macOS Apple Silicon

**[⬇ Download easy_pi-1.0.3-macOS-arm64.dmg directly](https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg)**

For M-series Macs. [All releases](https://github.com/nbang2026/Easy_pi/releases) · [SHA-256 checksum](docs/releases/v1.0.3/SHA256SUMS) · [Installer inspection record](docs/releases/v1.0.3/README.md).

> The link requires the same-named DMG to be present in the v1.0.3 release. If it returns 404, check publication status. The application ZIP in the repository is a separate distribution file.

**Prepare external Node/Pi and a working model connection first.** The repository's pinned Windows runtime uses Pi **1.3.0**; Node **22.x, at least 22.19**, is recommended for the current development/test tooling. This is not a claim that every external Pi version has been tested. See [Pi](https://pi.dev) for installation and authentication instructions.

```bash
node --version
pi --version

# If Pi is not installed, use a compatible Node/npm environment:
npm install -g @earendil-works/pi-coding-agent
```

1. Download the DMG and compare its SHA-256.
2. Mount it and drag **`easy_pi.app`** to **Applications**, or extract and move the app from its ZIP.
3. Launch the app and confirm the local Pi and GUI bridge connections.
4. Configure a model, select a workspace and begin a task.

The inspected DMG contains an arm64 application with version 1.0.3. Image integrity and local static signature verification passed; the app uses an **ad-hoc signature**. This does not establish Developer ID signing or Apple notarization, and application functionality was not exercised in this documentation task. No bundled Node/Pi was seen in the inspected Mac app. Verify provenance rather than disabling system protections.

### Platform scope

| Platform | Current distribution boundary |
| --- | --- |
| macOS Apple Silicon / arm64 | DMG distribution file and repository app ZIP; external Node/Pi required; consult actual release assets |
| Windows x64 | Source-kit and pinned-runtime preparation tooling; current wrapper does not create easy_pi exe/MSI installers; required offline input is not tracked in Git |
| Intel macOS / Linux / mobile | Cross-platform code, schemas or icons do not establish verified release support |

**Local execution does not imply offline inference.** Model requests, GitHub previews and network tools may still contact external services.

## Features in 1.0.3

### Desktop terminal and graphical input

- A Tauri v2 native window starts the real Pi CLI through a PTY.
- xterm.js provides terminal input, scrolling, resizing and optional WebGL rendering.
- A graphical composer, command shortcuts and session entry points complement the original TUI.
- Structured GUI actions call Pi's editor/context APIs rather than creating a second model session.
- Regular and wallpaper layouts share the same terminal/process. Some commands still require Pi's terminal selectors.

### Model management

Open **Settings → Models & connections** to add or edit custom models, including names, IDs, API protocols, endpoints and keys.

The interface supports editing/removing catalog and custom entries, row checkboxes, selecting current search results, deleting selected entries, clearing the list and restoring removed models. Destructive list actions require confirmation.

Saved API Keys are not echoed back. Leaving the key field empty during editing preserves the existing key; several models may share one provider key. Removing a model entry does not clear that provider's key or endpoint. Reload or restart Pi when prompted.

This is connection/configuration management, not model-weight downloading, local inference hosting or proof that a provider connection works.

### Agent Market

Open **Settings → Agent Market** to browse eight text-role templates:

| Agent | Purpose |
| --- | --- |
| Code Reviewer | Review real changes and identify reproducible defects |
| Bug Investigator | Reproduce issues, investigate causes and verify fixes |
| Test Engineer | Design boundary, error and regression tests |
| Technical Writer | Write documentation grounded in the implementation |
| Architecture Mapper | Explain modules, dependencies and data flow |
| Release Checker | Check versions, dependencies, artifacts and verification scope |
| Data Analyst | Validate data and produce reviewable analysis |
| Task Planner | Turn goals into deliverable, verifiable steps |

Search, categories, installed filtering, full-text previews and public GitHub `.md`/`.txt` imports are available. **Preview, import and activation are separate decisions.** Import does not activate a role; duplicate imports preserve local edits, and the default Pi role can be restored.

Agents are role/workflow definitions, not parallel processes. Only one role is globally active at a time. GitHub previews have source, size, timeout and text-validation limits. The market does not install MCP servers, themes, DSH plugins or executable code.

The separate plugin-import action invokes `pi install <source>` and can fetch executable third-party code; it does not inherit the text market's safeguards. See [Market provenance and compatibility](市场来源与兼容范围.md).

### Local library and memory

Save, search, read and edit role definitions and project notes. The active role and a limited selection of recent notes can be included when subsequent tasks begin. Context injection has capacity/length limits: it is not unlimited memory or automatic retrieval of all historical content.

Memory and autonomous text-Agent downloads are enabled by default and can be disabled. Model-facing library tools cannot activate roles or change those authorizations. This does not disable Pi's other file/command tools.

### Workspace files, Git and sessions

- Select a local project, browse its tree and search file paths.
- Read/edit existing UTF-8 text files; save operations check external modifications.
- Add local file references to a draft by selection or drag and drop; dropping does not send the task immediately.
- Review unstaged/staged diffs and branch comparisons, and stage/unstage individual files.
- Read/resume Pi sessions, with search and local pin/archive presentation.

The editor currently limits files to 512 KiB. Search matches paths, not full text. Git features require external Git and are not a complete commit/push/merge client. Parts of the current attachment/path UI assume POSIX-style paths, so Windows compatibility still needs work.

### Appearance

Chinese/English strings, static wallpapers, video backgrounds, transparency effects, fonts, sounds and shortcuts are configurable. Layout changes reuse the same Pi workflow. Custom wallpapers and some preferences live in the local WebView data store.

## Develop and build

Recommended baseline: Node 22.x (at least 22.19), pnpm 9, Rust/Cargo stable and platform-native prerequisites. macOS builds require Xcode Command Line Tools; full desktop integration requires working Pi.

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm tauri dev
```

`pnpm dev` only previews the frontend at `http://localhost:1420`; it does not provide the complete native Pi backend.

Build a macOS application:

```bash
pnpm tauri build --bundles app
```

Default output: `src-tauri/target/release/bundle/macos/easy_pi.app`. This does not automatically bundle external Node/Pi or create a notarized DMG. `pnpm tauri build` uses platform/configuration-specific bundle targets.

```bash
# Frontend checks, tests and build
pnpm check
pnpm test
pnpm build

# Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml --lib

# Staged verification and report
pnpm verify
```

`pnpm build` is frontend-only. Real-Pi smoke tests are opt-in; frontend, Rust, integration and installer checks are distinct verification layers. See [Development and verification](docs/DEVELOPMENT.md).

### Windows source kit

The packaging path expects a pinned archive containing Node 22.22.2, npm, Pi 1.3.0 and production dependencies, not Git, project SDKs or personal configuration.

**A fresh Git clone does not include `runtime-assets/windows-x64-offline.zip`.** The directory is gitignored, and the current manual workflow has no step to retrieve this input. Obtain the exact trusted archive and place it at that path before running:

```bash
pnpm install --frozen-lockfile
node scripts/prepare-windows-runtime.mjs
node scripts/prepare-windows-runtime.mjs --check
pnpm check
pnpm test
node scripts/package-source.mjs --output=artifacts/easy_pi-Windows-Source.zip
```

A PowerShell wrapper is also available:

```powershell
powershell -File scripts/build-windows.ps1 -Output .\artifacts\easy_pi-Windows-Source.zip
```

These commands create a source ZIP, **not an easy_pi exe/MSI**. Native Windows, ConPTY, WebView2 and installation/uninstallation require separate verification. Do not weaken archive hashes to bypass errors. See [Windows runtime and source delivery](scripts/WINDOWS-RUNTIME.md).

## Architecture and project organization

```text
TypeScript UI / xterm.js
           │ Tauri IPC
           ▼
      Rust desktop backend
      ├── PTY ─────────────────────→ real Pi CLI
      ├── workspace / Git / models          │
      └── authenticated local bridge ←──→ session Pi GUI extension
                                            ├── input / state
                                            ├── Agent library
                                            └── local memory
```

Terminal bytes and structured GUI control use separate channels. Pi remains the execution core.

| Location | Responsibility |
| --- | --- |
| `src/main.ts`, `bridge.ts` | Application assembly, terminal lifecycle and native IPC |
| `src/workbench.ts`, `model-*.ts` | Workspace/files/sessions/Git and model controls |
| `src/agent-market.ts`, `library-settings.ts` | Text market and role/memory interfaces |
| `src-tauri/src/lib.rs`, `runtime.rs` | Native commands, PTY, configuration and runtime lookup |
| `src-tauri/src/gui_bridge.rs`, `gui-extension.ts` | Authenticated local transport and Pi integration |
| `src-tauri/src/gui-library.mjs`, `gui-market.mjs` | Role/memory persistence, text import and built-in catalog |
| `src-tauri/src/workbench.rs`, `model_management.rs` | File/Git operations and model updates |
| `public/`, `scripts/`, `.github/workflows/` | Media, testing, runtime preparation and source delivery |

See [Architecture](docs/ARCHITECTURE.md) for module boundaries, data flow and current limitations.

## Data and privacy

The default directory used by GUI configuration is **`~/.pi/agent/`, not `~/.config/pi/`**. On Windows, USERPROFILE supplies HOME if it is missing.

| Data | Location relative to `~/.pi/agent/` |
| --- | --- |
| Custom providers/models, possibly API Keys | `models.json` |
| Catalog and removed-model state | `models-store.json` / `gui-models.json` |
| Authentication and Pi settings | `auth.json` / `settings.json` |
| Persona and shortcuts | `APPEND_SYSTEM.md` / `keybindings.json` |
| Sessions and roles/notes | `sessions/` / `gui-library/library.json` |

Appearance, drafts, workspace and session presentation use WebView localStorage; custom wallpapers use IndexedDB. GUI paths are not comprehensively redirected by `PI_CODING_AGENT_DIR`.

Local storage does not mean local-only inference: roles, notes and project content included in requests may be sent to the selected provider. Do not commit credentials, private profiles, full sessions or sensitive logs. Configuration is not an encrypted vault, and logs are not guaranteed to be redacted.

Role activation does not grant extra permissions, but role text influences model behavior. Workspace path checks and bridge authentication are not an OS sandbox for Pi tools. This is a local desktop application, not a hosted multi-tenant platform or parallel-agent scheduler.

## Documentation and contribution

Detailed guides are currently written in Chinese unless noted:

- [Usage and configuration](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development and verification](docs/DEVELOPMENT.md)
- [Windows runtime/source delivery (English)](scripts/WINDOWS-RUNTIME.md)
- [Installer inspection record](docs/releases/v1.0.3/README.md)
- [Market provenance](市场来源与兼容范围.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Documentation, tests and focused code improvements are welcome. Open an [Issue](https://github.com/nbang2026/Easy_pi/issues) with your version, OS/architecture, reproduction steps and redacted diagnostics.

## License and acknowledgments

The application is licensed under the **[MIT License](LICENSE)**. Dependencies, media and imported definitions retain their own terms. Existing built-in text-role metadata is marked **CC0-1.0** and is not replaced by the application license.

Thanks to [Pi Coding Agent](https://pi.dev), [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org) and the Rust/TypeScript/Vite ecosystems. easy_pi is an independent project built around Pi, not a claim of official upstream affiliation or endorsement.
