<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi application icon" />
  <h1>easy_pi</h1>
  <p><strong>A native desktop workbench for the Pi coding agent.</strong></p>
  <p>Graphical controls · Real terminal TUI · Model management · Text Agent library · Files & Git</p>
  <p><a href="README.md">简体中文</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">Releases</a> · <a href="docs/ARCHITECTURE.md">Architecture (中文)</a> · <a href="LICENSE">MIT License</a></p>
</div>

---

## What is easy_pi?

**easy_pi is an open-source desktop workbench built around the real [Pi coding agent](https://pi.dev)** (`@earendil-works/pi-coding-agent`). It uses **Tauri v2, Rust, TypeScript and xterm.js** to keep Pi's terminal interface available while adding graphical input, configuration panels, reusable text roles, session access, file editing and Git review.

It is not a new model, an independent coding-agent engine, or a hosted AI service. **Pi handles model requests, reasoning and tool execution; easy_pi provides the desktop shell, process/terminal lifecycle and local workflow controls.**

The current source version is `1.0.3`. The repository includes a macOS arm64 distribution archive and Windows runtime/source-kit tooling. Do not interpret the presence of cross-platform code as proof that every platform, installer or external Pi version has been tested.

## Why use it?

- Keep the real Pi TUI instead of replacing it with an unrelated chat engine.
- Configure models, shortcuts and persona text through a desktop interface.
- Browse project files and review Git changes alongside an agent task.
- Preview, import and activate reusable text Agents as separate decisions.
- Study or extend a native TypeScript DOM frontend and Rust/PTY bridge architecture.

The app still needs a compatible Pi runtime, model authentication and the tools required by your project. It does not supply free model credits or automatically install all developer dependencies.

## Features and boundaries

| Area | Implemented capabilities | Important boundary |
| --- | --- | --- |
| Desktop and terminal | Tauri window, xterm.js, terminal fitting, optional WebGL rendering and fallback | A plain browser preview is not a complete desktop client |
| Graphical input | Structured local bridge to Pi's editor/context APIs, alongside the real TUI | Pi selectors and some commands still require terminal interaction |
| Models | List/select, custom providers/models, edit, batch removal and restore | Configuration management, not weight downloads, inference hosting or connectivity testing |
| Local library | Text Agent roles and local memory notes | One active role, not a multi-agent scheduler |
| Agent Market | Eight bundled text templates, categories/search, full preview, explicit import and separate activation | Not a marketplace for executable plugins, MCP servers, themes or DSH extensions |
| Files and Git | Workspace tree/path search, existing UTF-8 text editing, status/diffs, stage/unstage | Not a full IDE or commit/push/merge client; requires system Git |
| Sessions and attachments | Read/resume Pi sessions, local pin/archive presentation, file references and image handling | Sensitive data stays subject to Pi/model/tool behavior; Windows path support has known gaps |
| Preferences | Chinese/English strings, shortcuts, persona, regular/wallpaper layouts, sounds | Local preferences, not a cloud synchronization service |
| Diagnostics | Runtime/bridge status, terminal text export and verification scripts | Logs are not guaranteed to be redacted |

Regular and wallpaper layouts share the same terminal and Pi process. Graphical and TUI input also target that process; changing workspaces is not parallel agent execution.

## Platform and distribution status

| Platform | What is present | Status boundary |
| --- | --- | --- |
| macOS Apple Silicon | `easy_pi-1.0.3-macOS-arm64.zip` in the repository, plus desktop source | Check actual release assets; the base configuration does not bundle Pi/Node for macOS |
| Windows x64 | Runtime preparation/validation, source archive wrapper, manual workflow and legacy installer helpers | Current wrapper does not build installers; the required offline archive is not tracked in Git |
| Intel macOS / Linux / mobile | Some cross-platform source, schemas and icons | No verified distribution support is established by their presence |

Minimum OS versions, memory usage, signing/notarization and installer sizes are not asserted without concrete release/test evidence. An offline Node/Pi runtime does **not** imply offline model inference or offline network tools.

## Getting started

### 1. Obtain a trusted build

For Apple Silicon, check the Assets list on the [v1.0.3 release page](https://github.com/nbang2026/Easy_pi/releases/tag/v1.0.3) for `easy_pi-1.0.3-macOS-arm64.dmg`. It is uploaded only when it actually appears there; the repository ZIP is a separate file.

Download the DMG, compare its [SHA-256](docs/releases/v1.0.3/SHA256SUMS), mount it, and drag `easy_pi.app` to `Applications`. The inspected installer contains an arm64 app with version 1.0.3 and an **ad-hoc signature**. Image integrity and local signature verification passed; this is not Developer ID signing, and Apple notarization or application functionality was not verified in this documentation task. See the [installer inspection record](docs/releases/v1.0.3/README.md). Verify provenance instead of disabling system protections.

For source builds, see [Development](docs/DEVELOPMENT.md). Windows users should read [Windows runtime and source delivery](scripts/WINDOWS-RUNTIME.md) first.

### 2. Prepare Pi and model authentication

For macOS and development builds without a complete bundled runtime, install Pi using a compatible Node/npm environment:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

The repository's pinned Windows runtime uses Pi **1.3.0**. Compatibility with arbitrary external Pi versions is not guaranteed. If the desktop process cannot discover Pi, set `PI_EXECUTABLE` to an existing executable's **absolute path** and launch the app from an environment that inherits it. Invalid overrides fail explicitly.

Authenticate using a method supported by Pi, or configure the provider, model ID, API protocol, Base URL and API Key in model settings. Reload or restart Pi when prompted. Provider keys may be shared across several models; leaving the key field empty when editing preserves the existing key.

### 3. Open a workspace

Confirm the project path, connect Pi, then use graphical input or the TUI. Add local file references when needed and review edits in the file/Git workbench. Some selectors remain in the terminal.

File drops add `@path` references to a draft; they do not immediately upload to an easy_pi cloud service or automatically submit a task. Parts of the current attachment UI assume POSIX-style paths, so Windows drive/UNC paths require further compatibility work.

## Text Agents, memory and packages

- Local Agents are Markdown/text role definitions; only one role is active globally at a time. Reading/importing one does not spawn another process.
- The market ships eight original templates: code review, debugging, testing, documentation, architecture, releases, data analysis and planning.
- Optional public GitHub `.md`/`.txt` previews require HTTPS, an allowed file URL, valid text, a 256 KiB limit and no redirects. Preview, consent, import and activation are distinct steps.
- Local memory and autonomous text downloads are enabled by default and can be disabled in library settings. Model-facing library tools cannot change those authorizations or activate roles. These limits do not sandbox Pi's other tools.
- The separate plugin-import action invokes `pi install <source>` and may fetch executable third-party code. It does not inherit the text market's allowlist or preview safeguards. Only install trusted packages.

See [Market provenance and compatibility](市场来源与兼容范围.md) for scope and licensing distinctions, including existing CC0-1.0 template metadata.

## Configuration and privacy

The primary directory used by GUI configuration is **`~/.pi/agent/`, not `~/.config/pi/`**.

| Data | Location |
| --- | --- |
| Custom providers/models, possibly API Keys | `~/.pi/agent/models.json` |
| Model catalog / removal state | `models-store.json` / `gui-models.json` in the same directory |
| Authentication / Pi settings | `auth.json` / `settings.json` in the same directory |
| Persona / shortcuts | `APPEND_SYSTEM.md` / `keybindings.json` |
| Sessions / role and memory library | `sessions/` / `gui-library/library.json` |
| Appearance, drafts, workspace and session presentation | WebView localStorage |
| Custom wallpapers | WebView IndexedDB |
| Debug log / terminal text exports | `~/.pi_app_debug.log` / `~/Downloads/pi-terminal-*.txt` |

GUI paths are not comprehensively redirected by `PI_CODING_AGENT_DIR`. Local JSON is not an OS Keychain or encrypted vault. Terminal export contains the current buffer, not a complete structured session backup. Review and redact logs before sharing them.

## Engineering overview

```text
TypeScript UI ──Tauri invoke──> Rust desktop backend ──PTY──> Pi CLI
      ▲                             │                        │
      └────terminal output──────────┘                        │
      │                                                      │
      └──GUI state/actions──> authenticated local bridge <──> injected Pi extension
```

| Location | Responsibility |
| --- | --- |
| `src/main.ts`, `bridge.ts` | App assembly, terminal lifecycle and native IPC |
| `src/workbench.ts`, `model-*.ts`, `agent-market.ts` | Workspace, model and market interfaces |
| `src-tauri/src/lib.rs`, `runtime.rs` | Native commands, Pi lookup, process lifecycle and configuration |
| `src-tauri/src/gui_bridge.rs`, `gui-extension.ts` | Authenticated local JSON transport and Pi integration |
| `src-tauri/src/gui-library.mjs`, `gui-market.mjs` | Local roles/memory, text import and bundled catalog |
| `src-tauri/src/workbench.rs`, `model_management.rs` | Scoped file/Git operations and model transactions |
| `scripts/`, `.github/workflows/` | Tests, verification and current source-kit delivery |

The bridge uses a private Unix socket on Unix or loopback TCP on Windows, a per-start token, and bounded JSON frames. These protect the transport; they are **not** an OS sandbox for the coding agent. The base configuration also has `csp: null`, so a hardened CSP must not be assumed.

## Development

Recommended baseline: Node 22.x (at least 22.19), pnpm 9, Rust stable and Tauri's platform-native development prerequisites. Tests rely on Node's TypeScript stripping support.

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile

# Full desktop development; requires Pi and native toolchains
pnpm tauri dev

# Frontend checks, tests and build
pnpm check
pnpm test
pnpm build

# Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

- `pnpm dev`: frontend preview at `http://localhost:1420`; not full native functionality.
- `pnpm build`: frontend output only. Use `pnpm tauri build` for a platform desktop build.
- `pnpm verify`: runs type checks, frontend tests/build and Rust tests, and writes a verification report.
- Real-Pi smoke tests are opt-in; test evidence must distinguish unit tests, integration and native installer checks.

### Windows delivery warning

`scripts/build-windows.ps1` currently creates a **source kit**, not an `.exe`/`.msi`. `tauri.windows.conf.json` disables bundling. The expected `runtime-assets/windows-x64-offline.zip` is gitignored and absent from the tracked Git tree; the current manual workflow has no step to obtain it. A fresh clone cannot complete this path until the exact trusted input is supplied. The archive's hashes must not be weakened to bypass failures.

## Documentation and contribution

Detailed guides are currently written in Chinese unless noted:

- [Usage and configuration](docs/USAGE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development and verification](docs/DEVELOPMENT.md)
- [Windows runtime/source delivery (English)](scripts/WINDOWS-RUNTIME.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Open an [Issue](https://github.com/nbang2026/Easy_pi/issues) with your app/Pi version, OS/architecture, reproduction steps and redacted diagnostics. Documentation corrections and focused, tested contributions are welcome. Do not publish credentials, private sessions or entire Pi profiles.

## License and acknowledgments

The project is licensed under the **[MIT License](LICENSE)**. Third-party libraries, runtime components, assets and imported text keep their own applicable terms; this project's license does not replace them.

Thanks to [Pi](https://pi.dev), [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org) and the Rust/TypeScript ecosystems. easy_pi is an independent desktop project built around Pi, not a claim of official upstream affiliation or endorsement.
