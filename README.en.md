<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi application icon" />
  <h1>easy_pi</h1>
  <p><strong>A more intuitive desktop workspace for Pi and Claude coding agents.</strong></p>
  <p>Windows x64 · macOS Apple Silicon · Tauri v2 · Rust · TypeScript · Vite · xterm.js</p>
  <p><strong><a href="https://github.com/nbang2026/Easy_pi/releases">Windows installers &amp; macOS apps</a></strong></p>
  <p><a href="README.md">简体中文 / Bilingual README</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">All releases</a> · <a href="BUILDING.md">Build guide (中文)</a> · <a href="https://github.com/nbang2026/Easy_pi/issues">Issues</a> · <a href="https://github.com/nbang2026/Easy_pi/blob/main/LICENSE">MIT License</a></p>
</div>

---

## What is easy_pi?

**easy_pi is a desktop GUI and local workbench built around [Pi Coding Agent](https://pi.dev) and an independent Claude engine, available for Windows and macOS.**

It brings model connections, project sessions, files, Git review, Agent / Skill libraries, permission approvals, task records and usage analysis into a native desktop window. Use the graphical conversation and workbench or keep a compact terminal workflow. Wallpapers, fonts and sounds personalize the interface without merging engine or project boundaries.

**easy_pi provides a desktop harness, not hosted models or free credits.** Tasks are performed by the selected engine, your configured model and local tools.

### What can it do?

- **Development:** Explore code, implement features, debug issues and add tests with project context.
- **Review projects:** Browse files, edit text, inspect Git diffs and review staging state.
- **Organize agent work:** Manage roles and skills and coordinate constrained read-only child tasks where supported.
- **Reuse context:** Save project notes, role definitions and conventions for later tasks.
- **Control execution:** Review tool requests, approve permissions, configure budgets, stop tasks and inspect results.
- **Understand usage:** Review model usage and known costs through trends, records and calendar heatmaps.

### Responsibilities

| easy_pi provides | Engines and environment provide |
| --- | --- |
| Desktop UI, composer, terminal display, workbench and project access | Pi / Claude execution, model requests, context processing and tools |
| Connection settings, role/skill management, approvals and task records | Model services, API keys or engine-supported authentication |
| Session access, local memory, usage views and environment checks | Git, project dependencies, SDKs and platform tools; some runtimes may be bundled |

## Download and install

> [!IMPORTANT]
> **Windows and macOS**
>
> Windows installers now exist; Windows is no longer source-only. Select an actual platform asset from [Releases](https://github.com/nbang2026/Easy_pi/releases). Platform versions may differ.
>
> Building and uploading are separate steps. A new package absent from Releases is not publicly downloadable there. GitHub-generated source ZIPs and source-with-environment kits are not application installers.

> [!WARNING]
> **Publication check, October 31, 2026:** The supplied Windows PiRepair3 installer and source ZIP are truncated and excluded from this release. Windows assets are pending intact files and verification; the download entry does not imply a valid Windows asset is currently available.

### Windows x64

**[View Windows installation assets](https://github.com/nbang2026/Easy_pi/releases)**

1. Download the release's `.exe` installer, or its `.msi` if provided.
2. Verify provenance and the accompanying SHA-256, then install and launch easy_pi.
3. Check the runtime in Settings, configure a model connection and select a project.

The full Windows build configuration includes target-specific Node / Pi and Claude / DSH resources and carries WebView2 offline installation resources. Check the actual package notes for its contents and signing state; filenames or size alone are not evidence. Git / Git Bash, project-specific SDKs, accounts and model credits remain your responsibility.

### macOS Apple Silicon

**[View macOS application assets](https://github.com/nbang2026/Easy_pi/releases)**

1. Download an Apple Silicon / arm64 application ZIP, or a DMG if provided, and verify its SHA-256.
2. Extract the ZIP or mount the DMG and move `easy_pi.app` into Applications.
3. Check the local runtime and engine connection, configure a model and select a project.

Existing Mac Apps require external **Node.js 22.19+** and a working Pi CLI for Pi mode; the paired tested Pi core is **1.3.0**. Claude resources are prepared per build, while authentication and connectivity require your configuration.

Existing Mac candidates are **ad-hoc signed, not Apple notarized**. Verify their source and follow system prompts without disabling security protections.

### Platform scope

| Platform | Distribution boundary |
| --- | --- |
| Windows x64 | Application installers and source workflows; consult package notes for runtimes, signing and native validation |
| macOS Apple Silicon / arm64 | Native App; Pi mode requires external Node/Pi; a separate source-with-environment kit is also available |
| Other architectures and platforms | Cross-platform code does not establish a release or completed validation |

End active tasks, quit the previous version and keep necessary backups before upgrading. A Pi update notice is not an application auto-updater.

## Features

### Conversations, terminal and input

- Graphical conversation and workbench views for daily work, with compact terminal mode for native Pi interaction.
- Tauri-managed Pi processes, PTYs and authenticated local bridging, with xterm.js terminal rendering.
- File references, command suggestions, shortcuts, draft protection and IME submission guards.
- Pi send, control and queue operations according to engine capabilities, not presented as universal actions across engines.

### Pi, Claude and Auto

Pi and Claude keep separate execution states and session boundaries. Auto selects one engine before submission; it is neither a third core nor a merged conversation. Thinking level and work role are separate settings. Available levels and tools depend on your selected model and engine.

### Model management

Manage API endpoints, protocols, keys and models by provider, with search, selection and bulk operations. Saved keys are not echoed back, and leaving a key field empty preserves its value. Models may share provider settings. A listed model is not a verified connection or downloaded model weights.

### Agent Market

Browse online catalogs, built-in selections and downloaded entries with search, categories, full-text previews and local role management.

**Preview, download and activation are separate decisions.** Downloading does not activate a role or overwrite local edits. Review external entries' provenance, tool requirements and licenses.

A role definition is not an independent process and grants no terminal or network access. A separate plugin-install action may fetch executable code and must not be confused with the text market.

### Skill store and library

Search and preview skills, inspect `SKILL.md` and supporting files, download locally, and manage activation, updates and removal. Downloading and execution are separate. Activation must still be confirmed by the engine's loaded state. Skills do not install system dependencies or create tools an engine does not have.

### Scheduling, permissions and long tasks

Organize roles and skills for a task and coordinate constrained read-only child tasks with dependencies, concurrency limits and cancellation. Role entries and executing child tasks are distinct; support depends on the engine.

Execution controls configure application permissions and task budgets and retain checkpoints, interruption records and acceptance state. Stop, resubmit and error handling assist task lifecycle management, not a guarantee of uninterrupted execution.

Unlimited mode removes only the application's budget, not approvals, system limits, context limits or provider quotas. A model ending its output is not user acceptance.

### Local library and memory

Save, search, read and edit roles, project notes and conventions for subsequent tasks. Context injection is bounded, not unlimited memory or automatic retrieval of all history.

### Workspace files, Git and sessions

- Switch projects, search and resume saved sessions, and preserve drafts separately.
- Browse file trees, search paths and edit supported text files with external-change checks on save.
- Add references by selecting or dropping files without immediately submitting a task.
- Review staged, unstaged and branch diffs and stage or unstage individual files.

Git features require local Git and do not replace a complete commit, push and merge client.

### Usage analysis and update notices

Review trends, model breakdowns, rankings, records, calendar heatmaps and exports. Color intensity reflects usage. Missing records and unknown pricing are not presented as a complete bill or zero cost.

Pi core update notices inform you without silently upgrading, restarting the engine or interrupting active work.

### Appearance and preferences

Chinese/English UI, static and animated wallpapers, transparent input, night UI, custom font colors and sizes, font import, click/typing/scroll sounds, custom sound packs and shortcut settings.

## Develop and build

Use Node.js 22.19+, pnpm 9, Bun, Rust/Cargo and platform-native prerequisites: Xcode Command Line Tools on macOS, or MSVC C++ Build Tools and Windows SDK on Windows.

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile
cd agent-runtime
bun install --frozen-lockfile
cd ..
pnpm check
pnpm test
```

If your source kit has an outer wrapper, enter its `pi-app` directory containing `package.json` before running project commands.

### macOS

Prepare external Node/Pi, stage the Claude resources and start the native development window:

```bash
node scripts/prepare-claude-runtime.mjs --platform darwin --arch arm64
pnpm tauri dev
```

Build the macOS App:

```bash
pnpm tauri build --bundles app
```

Default output: `src-tauri/target/release/bundle/macos/easy_pi.app`. This does not provide Developer ID signing, notarization or automatic external Node/Pi bundling.

### Windows

On Windows x64, use the installer build entry point:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-desktop-windows.ps1
```

Building requires `runtime-assets/windows-x64-offline.zip` matching pinned hashes; a fresh clone may not include it. Obtain the trusted matching input rather than weakening validation. The script stages Node/Pi and Claude resources and builds NSIS / MSI; obtaining WebView2 build resources may require network access.

This is different from the `scripts/build-windows.ps1` source-export wrapper. See [Windows runtime packaging](scripts/WINDOWS-RUNTIME.md) and the [build guide](BUILDING.md) for details. The optional `-VerifyInstallers` step actually installs the candidate and should run only in a disposable Windows test account.

### Verification

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm verify
```

Frontend, Rust, real-engine integration, installer checks and target-system tests are distinct layers. `pnpm dev` is frontend-only, not a native Pi backend. Building locally does not publish a GitHub release or establish clean-machine and overnight model-task reliability.

## Architecture and project organization

```text
TypeScript UI / conversation / workbench / xterm.js
                         |
                     Tauri IPC
                         |
                Rust desktop backend
                |-- Pi process / PTY / authenticated bridge
                |      `-- Pi CLI + session GUI extension
                |-- Independent Claude runtime / sidecar
                `-- Files / Git / models / runtime checks

Task routing / bounded child tasks / Agent & Skill libraries
Permissions / checkpoints / local memory / usage records
```

Pi and Claude keep independent runtime state, with automatic routing before submission. Terminal bytes and structured GUI control use separate channels.

| Location | Responsibility |
| --- | --- |
| `src/main.ts`, `src/bridge.ts` | Frontend assembly, lifecycle and native IPC |
| `src/conversation-view.ts`, `src/claude-view.ts`, `src/workbench.ts` | Conversation, Claude views and project workbench |
| `src/model-*.ts`, `src/agent-market.ts`, `src/skill-library.ts` | Model, Agent and Skill interfaces |
| `src-tauri/src/gui_bridge.rs`, `gui-extension.ts` | Authenticated Pi transport and session extension |
| `src-tauri/src/claude_runtime.rs`, `agent-runtime/` | Independent Claude lifecycle and runtime resources |
| `src-tauri/src/task-routing.mjs`, `task-scheduler.mjs` | Task routing and constrained child-task scheduling |
| `src-tauri/src/gui-library.mjs`, `gui-skills.mjs`, `gui-usage.mjs`, `gui-harness.mjs` | Library, skills, usage and execution records |
| `public/`, `scripts/`, `.github/workflows/` | Media, verification, runtime preparation and build workflows |

## Data and privacy

Pi and related GUI data default to **`~/.pi/agent/`**. `PI_CODING_AGENT_DIR` redirects the related data root, and Windows uses the corresponding user home. Claude maintains separate engine sessions and authentication settings.

| Data | Location relative to the Pi data directory |
| --- | --- |
| Custom models/providers, possibly keys | `models.json` |
| Model catalog and removal state | `models-store.json` / `gui-models.json` |
| Pi authentication and settings | `auth.json` / `settings.json` |
| Persona and shortcuts | `APPEND_SYSTEM.md` / `keybindings.json` |
| Pi sessions, roles and memory | `sessions/` / `gui-library/library.json` |
| Skills, task records and usage | `gui-skills/` / `gui-harness/` / `gui-usage/` |

Appearance, drafts and some workspace state use WebView local storage; custom wallpaper resources use IndexedDB. Back up needed data before migration or removal.

Local storage is not offline inference. Submitted code, files, roles and memory may reach the selected provider. Never commit credentials, full sessions or sensitive logs. Configuration files are not an encrypted vault.

Application permissions, path checks and bridge authentication are not an OS sandbox. External Agent / Skill text is not a system instruction or authorization. Downloading is not execution; review content before activation.

## Documentation and contribution

- [Development and build (中文)](BUILDING.md)
- [Windows runtime packaging](scripts/WINDOWS-RUNTIME.md)
- [Repository documentation](https://github.com/nbang2026/Easy_pi/tree/main/docs)
- [Contributing](https://github.com/nbang2026/Easy_pi/blob/main/CONTRIBUTING.md)
- [Security](https://github.com/nbang2026/Easy_pi/blob/main/SECURITY.md)
- [Third-party notices](https://github.com/nbang2026/Easy_pi/blob/main/THIRD_PARTY_NOTICES.md)

Open an [Issue](https://github.com/nbang2026/Easy_pi/issues) with the version, OS/architecture, engine, reproduction steps and redacted diagnostics. Documentation, tests and focused improvements are welcome; describe the scope and verification of each change.

## License and acknowledgments

The project uses the **[MIT License](https://github.com/nbang2026/Easy_pi/blob/main/LICENSE)**. Third-party components, media and downloaded content retain their own terms.

Thanks to [Pi Coding Agent](https://pi.dev), [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org) and the Rust, TypeScript, Vite and related open-source ecosystems.

easy_pi is an independent project, not an official release or endorsement from Pi, Claude or related upstream projects.
