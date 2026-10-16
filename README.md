<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi 应用图标 / easy_pi app icon" />
  <h1>easy_pi</h1>
  <p><strong>让 Pi 编码智能体拥有一个更直观的桌面工作环境。</strong></p>
  <p><strong>A more intuitive desktop workspace for the Pi coding agent.</strong></p>
  <p>版本 1.0.3 · Tauri v2 · Rust · TypeScript · Vite · xterm.js</p>
  <p>Version 1.0.3 · Tauri v2 · Rust · TypeScript · Vite · xterm.js</p>
  <p><strong><a href="https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg">⬇ 直接下载 easy_pi 1.0.3 · macOS Apple Silicon（DMG）</a></strong></p>
  <p><strong><a href="https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg">⬇ Direct download · macOS Apple Silicon (DMG)</a></strong></p>
  <p><a href="README.en.md">纯英文版 / English-only README</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">全部版本 / All releases</a> · <a href="docs/USAGE.md">使用指南 / Usage</a> · <a href="docs/ARCHITECTURE.md">工程架构 / Architecture</a> · <a href="LICENSE">MIT License</a></p>
</div>

---

## 项目介绍 / Introduction

**easy_pi 是为 [Pi Coding Agent](https://pi.dev) 开发的开源桌面图形界面与本地工作台。**<br>
**easy_pi is an open-source desktop GUI and local workbench for [Pi Coding Agent](https://pi.dev).**

Pi 是运行在终端中的 AI 编码智能体，可以结合模型和本地工具协助阅读代码、修改项目、排查问题和执行开发任务。<br>
Pi is a terminal-based coding agent that works with models and local tools to explore code, modify projects, investigate issues, and perform development tasks.

easy_pi 将真实的 Pi CLI 放进原生桌面窗口，并围绕它提供模型管理、文件与 Git 工作区、会话入口、Agent 市场、本地记忆资料库和外观设置，让日常操作更直观。<br>
easy_pi runs the real Pi CLI in a native desktop window and adds model management, a file and Git workbench, session access, an Agent Market, local memory, and appearance settings.

你可以继续使用 Pi 原有的终端交互和指令，也可以通过图形界面配置模型、添加文件引用和切换任务角色。<br>
Keep using Pi's original terminal interactions and commands, or use the graphical interface to configure models, add file references, and switch task roles.

**easy_pi 不提供模型服务，也不替代 Pi 核心；实际任务由 Pi、用户配置的模型和本地工具共同完成。**<br>
**easy_pi does not provide a model service or replace Pi; tasks are performed by Pi together with your configured model and local tools.**

本项目适合希望保留 Pi TUI、同时获得桌面操作入口的用户，也适合研究 Tauri、PTY 与 Agent 扩展桥接的开发者。<br>
It is designed for Pi users who want a desktop interface without giving up the TUI, and for developers exploring Tauri, PTYs, and Agent-extension bridges.

### 可以用来做什么？ / What can you do with it?

- **辅助开发：** 结合项目文件，让 Pi 协助理解代码、实现功能、排查错误和补充测试。<br>
  **Development:** Give Pi project context to help explore code, implement features, debug issues, and add tests.
- **审查与整理项目：** 使用代码审查、架构梳理或发布验收角色组织任务流程。<br>
  **Review and organize projects:** Use code-review, architecture, or release-checking roles to structure a workflow.
- **文档与分析：** 复用技术写作、数据分析和任务规划角色，处理代码之外的工作。<br>
  **Documentation and analysis:** Reuse technical-writing, data-analysis, and planning roles for work beyond coding.
- **管理模型连接：** 通过界面维护供应商、模型和连接设置，减少手工编辑配置文件。<br>
  **Manage model connections:** Maintain providers, models, and connection settings in the UI instead of editing configuration files by hand.
- **复用项目上下文：** 保存角色定义、项目笔记和约定，供后续任务参考。<br>
  **Reuse project context:** Save role definitions, project notes, and conventions for later tasks.
- **查看本地变更：** 在同一工作台中浏览文件、编辑文本、检查 Git 差异和暂存状态。<br>
  **Review local changes:** Browse files, edit text, inspect Git diffs, and stage changes in one workbench.

### easy_pi 与 Pi 的分工 / What easy_pi and Pi each provide

| easy_pi 提供 / easy_pi provides | Pi 与外部环境提供 / Pi and the environment provide |
| --- | --- |
| 桌面窗口、图形输入、终端显示和工作台。<br>Desktop window, graphical input, terminal display, and workbench. | 模型请求、上下文处理、编码 Agent 与工具执行。<br>Model requests, context processing, coding-agent behavior, and tool execution. |
| 模型配置、本地角色库和文本 Agent 预览。<br>Model configuration, local role library, and text-Agent previews. | 模型供应商、API Key 或 Pi 支持的认证方式。<br>Model providers, API keys, or an authentication method supported by Pi. |
| Pi 进程启动、运行时查找和本地桥接。<br>Pi process startup, runtime discovery, and the local bridge. | Node/Pi 运行时、Git、项目依赖和开发工具。<br>Node/Pi runtimes, Git, project dependencies, and development tools. |

## 下载与安装 / Download and install

> [!IMPORTANT]
> **Windows 版本开发公告**<br>
> **Windows development notice**
>
> Windows 版本仍在开发中，exe/MSI 安装包尚未发布，当前 Windows 源码与运行时准备流程仅供开发和验证。<br>
> The Windows version is still in development; no exe/MSI installer has been released, and the current Windows source and runtime-preparation workflow is for development and verification only.
>
> Windows 版本发布后会在此处和 [Releases](https://github.com/nbang2026/Easy_pi/releases) 更新，请留意后续公告。<br>
> This section and [Releases](https://github.com/nbang2026/Easy_pi/releases) will be updated when the Windows version is released; stay tuned for announcements.

### macOS Apple Silicon

**[⬇ 点击直接下载 easy_pi-1.0.3-macOS-arm64.dmg](https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg)**<br>
**[⬇ Download easy_pi-1.0.3-macOS-arm64.dmg directly](https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg)**

此安装包适用于 Apple Silicon（M 系列芯片）Mac。<br>
This installer is for Apple Silicon (M-series) Macs.

[全部版本 / All releases](https://github.com/nbang2026/Easy_pi/releases) · [SHA-256 校验 / Checksum](docs/releases/v1.0.3/SHA256SUMS) · [安装盘检查记录 / Installer inspection](docs/releases/v1.0.3/README.md)

若直链返回 404，请检查 `v1.0.3` 发布页中是否仍有同名附件；仓库根目录的应用 ZIP 是独立文件。<br>
If the direct link returns 404, check whether the same-named asset is present in the `v1.0.3` release; the app ZIP in the repository is a separate file.

使用前需要准备外部 Node、Pi CLI 和可用的模型连接。<br>
Before launching the app, prepare Node, the Pi CLI, and a working model connection.

本仓库固定 Windows 运行时使用 Pi **1.3.0**；当前开发和测试工具链建议使用 Node **22.x，至少 22.19**，但这不代表所有外部 Pi 版本都已验证兼容。<br>
The pinned Windows runtime uses Pi **1.3.0**; current development and test tooling recommends Node **22.x, at least 22.19**, but this does not mean every external Pi version has been tested for compatibility.

Pi 的安装和认证方式请参考 [Pi 官方说明](https://pi.dev)。<br>
See the [Pi documentation](https://pi.dev) for installation and authentication.

```bash
node --version
pi --version
npm install -g @earendil-works/pi-coding-agent
```

1. 下载 DMG 并核对 SHA-256。<br>
   Download the DMG and verify its SHA-256 checksum.
2. 双击挂载 DMG，将 `easy_pi.app` 拖入 Applications；若使用 ZIP，请先解压。<br>
   Mount the DMG and drag `easy_pi.app` to Applications, or extract the app from the ZIP.
3. 启动 easy_pi，确认本地 Pi 与图形桥接连接成功。<br>
   Launch easy_pi and confirm that Pi and the GUI bridge are connected.
4. 配置模型、选择工作区并开始任务。<br>
   Configure a model, select a workspace, and start a task.

已检查的 DMG 包含 arm64、版本 1.0.3 的应用，镜像完整性和本地静态签名校验通过。<br>
The inspected DMG contains an arm64 app, version 1.0.3; disk-image integrity and local static signature checks passed.

该应用采用 **ad-hoc 签名**，不代表 Developer ID 签名或 Apple 公证；此次检查也没有运行应用进行功能验证，且未发现捆绑的 Node/Pi。<br>
The app uses an **ad-hoc signature**, not Developer ID signing or Apple notarization; the app was not run for functional testing, and no bundled Node/Pi was found.

请核实下载来源，不要为了绕过系统提示而关闭 macOS 安全保护。<br>
Verify the download source; do not disable macOS security protections to bypass a warning.

### 平台与交付范围 / Platforms and distribution status

| 平台 / Platform | 当前内容与边界 / Current contents and limitations |
| --- | --- |
| macOS Apple Silicon / arm64 | 提供 DMG 和仓库应用 ZIP；需要外部 Node/Pi。<br>DMG and repository app ZIP are available; external Node/Pi is required. |
| Windows x64 | 当前为源码包与固定运行时准备流程，不生成 easy_pi exe/MSI；所需离线档案未被 Git 跟踪。<br>Currently a source-kit and pinned-runtime preparation path, not an easy_pi exe/MSI release; the required offline archive is not tracked in Git. |
| macOS Intel / Linux / 移动平台<br>macOS Intel / Linux / Mobile | 存在部分跨平台代码不等于已有发行包或完成实测。<br>Some cross-platform code does not imply a release build or completed testing. |

本地运行不代表离线推理；模型请求、GitHub 预览和联网工具仍可能访问外部服务。<br>
Local execution does not mean offline inference; model requests, GitHub previews, and network tools may contact external services.

## 1.0.3 主要功能 / Features in 1.0.3

### 桌面终端与图形输入 / Desktop terminal and graphical input

- 基于 Tauri v2 的原生桌面窗口通过 PTY 启动真实 Pi CLI。<br>
  A Tauri v2 desktop window launches the real Pi CLI through a PTY.
- xterm.js 显示终端交互，支持输入、滚动、尺寸调整和可选 WebGL 渲染。<br>
  xterm.js displays terminal interaction with input, scrolling, resizing, and optional WebGL rendering.
- 图形输入栏、常用指令和会话入口与原生 TUI 配合使用。<br>
  A graphical composer, command shortcuts, and session entry points complement the native TUI.
- 图形操作通过结构化桥接调用 Pi 编辑器和上下文接口，不会另起一套模型会话。<br>
  Structured bridge actions call Pi's editor and context APIs instead of creating a separate model session.
- 常规布局和壁纸布局共用一个终端与 Pi 进程；部分选择器仍需在终端中完成。<br>
  Regular and wallpaper layouts share one terminal and Pi process; some selectors still require terminal interaction.

### 模型管理 / Model management

入口：**设置 → 模型与连接**。<br>
Open **Settings → Models & connections**.

可以添加或编辑自定义模型，包括名称、模型 ID、API 协议、服务地址和密钥。<br>
Add or edit custom models, including their name, model ID, API protocol, endpoint, and key.

模型列表支持逐行选择、全选当前搜索结果、批量删除、清空和恢复已移除模型。<br>
The model list supports row selection, selecting current search results, batch deletion, clearing, and restoring removed models.

已保存的 API Key 不会回显；编辑时将密钥留空表示保留原值。<br>
Saved API keys are not echoed back; leave the key field empty when editing to preserve the existing value.

同一供应商下多个模型可能共享一个密钥；删除模型条目不会自动删除供应商密钥或地址。<br>
Multiple models from one provider may share a key; deleting a model entry does not automatically delete the provider key or endpoint.

这是模型连接配置，不是模型权重下载器或本地推理服务；模型出现在列表中也不代表在线连接已验证。<br>
This is model-connection configuration, not a model-weight downloader or local inference service; a model appearing in the list does not verify online connectivity.

保存后按提示执行 `/reload` 或重启 Pi。<br>
After saving, run `/reload` or restart Pi as prompted.

### Agent 市场 / Agent Market

入口：**设置 → Agent 市场**，内置八种文本角色模板。<br>
Open **Settings → Agent Market** to browse eight built-in text roles.

| Agent | 用途 / Purpose |
| --- | --- |
| 代码审查 / Code Reviewer | 检查真实变更并定位可复现问题。<br>Review real changes and identify reproducible issues. |
| 故障排查 / Bug Investigator | 复现问题、分析根因并验证修复。<br>Reproduce issues, investigate causes, and verify fixes. |
| 测试工程师 / Test Engineer | 设计边界、异常和回归测试。<br>Design boundary, error, and regression tests. |
| 技术文档 / Technical Writer | 编写基于代码的说明和教程。<br>Write implementation-grounded documentation and tutorials. |
| 架构梳理 / Architecture Mapper | 整理模块职责、依赖和数据流。<br>Map module responsibilities, dependencies, and data flow. |
| 发布验收 / Release Checker | 检查版本、依赖、产物和验证范围。<br>Check versions, dependencies, artifacts, and verification scope. |
| 数据分析 / Data Analyst | 校验数据并进行可复查分析。<br>Validate data and produce reviewable analysis. |
| 任务规划 / Task Planner | 将目标拆分为可验证的交付步骤。<br>Break goals into verifiable deliverables. |

市场支持搜索、分类、已导入筛选、全文预览，以及公开 GitHub `.md` / `.txt` 的预览导入。<br>
The market supports search, categories, installed-item filtering, full-text previews, and preview/import of public GitHub `.md` / `.txt` files.

**预览、导入和启用是三个独立步骤**；导入不会自动启用，重复导入也不会覆盖已有的本地编辑。<br>
**Preview, import, and activation are separate steps**; importing does not activate a role or overwrite an existing local edit.

Agent 是角色与工作流程定义，不是并行运行的独立智能体；同一时间只激活一个全局角色。<br>
Agents are role and workflow definitions, not independent parallel processes; only one global role is active at a time.

市场不安装 DSH 插件、主题、MCP 服务或可执行代码；单独的 `pi install <source>` 入口可能获取可执行第三方代码，需自行审查来源。<br>
The market does not install DSH plugins, themes, MCP servers, or executable code; the separate `pi install <source>` action may fetch executable third-party code and requires source review.

### 本地资料库与记忆 / Local library and memory

可以保存、搜索、阅读和编辑角色定义、项目笔记与开发约定。<br>
Save, search, read, and edit role definitions, project notes, and development conventions.

任务开始时，当前角色和有限数量的近期笔记可以加入 Pi 上下文。<br>
At task start, the active role and a limited number of recent notes can be added to Pi's context.

记忆和模型自主下载 Agent 的设置默认开启，也可以由用户关闭。<br>
Memory and autonomous Agent-download settings are enabled by default and can be turned off by the user.

资料库容量和上下文注入长度有限，并非无限记忆或完整历史的自动召回。<br>
Library capacity and injected context are bounded; this is not unlimited memory or automatic retrieval of the full history.

模型侧资料库工具不能启用角色或修改授权，但这不等于 Pi 的其他文件和命令工具被禁用。<br>
Model-facing library tools cannot activate roles or change authorization, but this does not disable Pi's other file and command tools.

### 工作区、文件与 Git / Workspace, files, and Git

- 选择本地项目、浏览文件树，并按路径名称搜索。<br>
  Select a local project, browse its file tree, and search by path.
- 打开和编辑现有 UTF-8 文本文件；保存时检查外部修改。<br>
  Open and edit existing UTF-8 text files; saves check for external modifications.
- 拖入或选择文件，将本地 `@path` 引用加入草稿；不会立即发送任务。<br>
  Drop or select files to add local `@path` references to a draft; this does not submit the task.
- 查看 Git 已暂存/未暂存差异和分支比较，并逐文件暂存或取消暂存。<br>
  Review staged/unstaged diffs and branch comparisons, and stage or unstage individual files.
- 搜索和恢复 Pi 会话；置顶与归档只改变本地界面展示状态。<br>
  Search and resume Pi sessions; pinning and archiving only change local UI presentation.

文件编辑限制为不超过 512 KiB 的现有 UTF-8 文本，文件搜索按路径匹配而非全文检索。<br>
Editing is limited to existing UTF-8 text files up to 512 KiB; file search matches paths rather than file contents.

Git 功能依赖外部 Git，不提供完整的 commit、push 或 merge 工作流。<br>
Git features require external Git and do not provide a complete commit, push, or merge workflow.

部分附件路径逻辑仍假设 POSIX 风格路径，Windows 盘符与 UNC 路径兼容性尚需完善。<br>
Some attachment-path logic still assumes POSIX-style paths; Windows drive-letter and UNC path support needs improvement.

### 个性化界面 / Appearance and preferences

可以配置中英文界面、静态和视频壁纸、透明效果、字体、声音及快捷键。<br>
Configure Chinese/English UI strings, static and video wallpapers, transparency, fonts, sounds, and shortcuts.

不同布局共用同一个 Pi 工作流；切换外观不会创建新的 Pi 会话。<br>
Layouts share the same Pi workflow; changing appearance does not create a new Pi session.

## 从源码运行与构建 / Develop and build

建议使用 Node 22.x（至少 22.19）、pnpm 9 和 Rust/Cargo stable。<br>
Node 22.x (at least 22.19), pnpm 9, and stable Rust/Cargo are recommended.

macOS 原生构建需要 Xcode Command Line Tools，完整桌面联调还需要可用的 Pi。<br>
Native macOS builds require Xcode Command Line Tools; full desktop integration also requires a working Pi installation.

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm tauri dev
```

`pnpm dev` 只启动浏览器前端预览，不包含完整 Tauri/Pi 原生后端。<br>
`pnpm dev` starts only the browser-based frontend preview; it does not include the complete native Tauri/Pi backend.

构建 macOS 应用可运行 `pnpm tauri build --bundles app`，默认产物为 `src-tauri/target/release/bundle/macos/easy_pi.app`。<br>
Build the macOS app with `pnpm tauri build --bundles app`; the default output is `src-tauri/target/release/bundle/macos/easy_pi.app`.

该命令不会自动捆绑外部 Node/Pi，也不会生成已公证的 DMG。<br>
This command does not bundle external Node/Pi or produce a notarized DMG.

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm verify
```

前端、Rust、真实 Pi 联调和安装包检查是不同验证层级，不能相互替代。<br>
Frontend, Rust, real-Pi integration, and installer checks are different verification layers and are not interchangeable.

Windows 当前是源码交付路径，固定运行时离线档案未被 Git 跟踪；交付脚本不会生成 easy_pi exe/MSI。<br>
Windows currently follows a source-kit delivery path; its pinned offline runtime archive is not tracked in Git, and the delivery script does not build an easy_pi exe/MSI.

详情见 [开发与验证指南](docs/DEVELOPMENT.md) 和 [Windows 运行时说明](scripts/WINDOWS-RUNTIME.md)。<br>
See the [development and verification guide](docs/DEVELOPMENT.md) and [Windows runtime notes](scripts/WINDOWS-RUNTIME.md).

## 技术架构 / Architecture

```text
TypeScript UI / xterm.js ── Tauri IPC ──> Rust desktop backend ── PTY ──> Pi CLI
          GUI state/actions ── authenticated local bridge ──> session Pi extension
```

终端字节流保留 Pi TUI；独立的本地认证桥接负责图形输入、结构化状态和资料库操作。<br>
The terminal byte stream preserves Pi's TUI; a separate authenticated local bridge handles graphical input, structured state, and library operations.

Pi 仍是实际执行核心，easy_pi 不是独立模型服务，也不是多 Agent 调度器。<br>
Pi remains the execution core; easy_pi is neither a standalone model service nor a multi-agent scheduler.

| 工程目录 / Project path | 模块职责 / Responsibility |
| --- | --- |
| `src/main.ts`, `src/bridge.ts` | 前端装配、终端生命周期与 Tauri IPC。<br>Frontend assembly, terminal lifecycle, and Tauri IPC. |
| `src/workbench.ts`, `src/model-*.ts` | 工作区、会话、Git 与模型界面。<br>Workspace, sessions, Git, and model interfaces. |
| `src/agent-market.ts`, `src/library-settings.ts` | 文本 Agent 市场与本地资料库界面。<br>Text Agent Market and local-library interfaces. |
| `src-tauri/src/lib.rs`, `runtime.rs` | 原生命令、PTY 生命周期、配置和运行时查找。<br>Native commands, PTY lifecycle, configuration, and runtime discovery. |
| `src-tauri/src/gui_bridge.rs`, `gui-extension.ts` | 本地认证通信和 Pi 会话扩展。<br>Authenticated local transport and the Pi session extension. |
| `src-tauri/src/gui-library.mjs`, `gui-market.mjs` | 角色/记忆存储、文本导入和内置目录。<br>Role/memory storage, text import, and built-in catalog. |
| `src-tauri/src/workbench.rs`, `model_management.rs` | 文件/Git 操作与模型配置事务。<br>File/Git operations and model-configuration transactions. |
| `public/`, `scripts/`, `.github/workflows/` | 媒体资源、测试、运行时准备和交付流程。<br>Media, tests, runtime preparation, and delivery workflows. |

详细模块边界、数据流和限制见 [工程架构](docs/ARCHITECTURE.md)。<br>
See [Architecture](docs/ARCHITECTURE.md) for module boundaries, data flow, and limitations.

## 数据、隐私与使用边界 / Data, privacy, and limitations

默认 GUI 配置目录为 **`~/.pi/agent/`**，不是 `~/.config/pi/`。<br>
The default GUI configuration directory is **`~/.pi/agent/`**, not `~/.config/pi/`.

Windows 在 `HOME` 缺失时使用 `USERPROFILE`。<br>
On Windows, `USERPROFILE` is used when `HOME` is missing.

| 数据 / Data | 位置（相对于 `~/.pi/agent/`）/ Location (relative to `~/.pi/agent/`) |
| --- | --- |
| 自定义模型/供应商，可能包含 API Key<br>Custom models/providers, possibly containing API keys | `models.json` |
| 模型目录与移除状态<br>Model catalog and removal state | `models-store.json` / `gui-models.json` |
| 认证信息与 Pi 设置<br>Authentication and Pi settings | `auth.json` / `settings.json` |
| 人设与快捷键<br>Persona and shortcuts | `APPEND_SYSTEM.md` / `keybindings.json` |
| 会话、角色与记忆<br>Sessions, roles, and memory | `sessions/` / `gui-library/library.json` |

外观、草稿、工作区和会话展示状态保存在 WebView localStorage；自定义壁纸保存在 IndexedDB。<br>
Appearance, drafts, workspaces, and session-presentation state use WebView localStorage; custom wallpapers use IndexedDB.

GUI 路径尚未全面适配 `PI_CODING_AGENT_DIR` 自定义数据目录重定向。<br>
GUI paths do not yet fully support custom data-directory redirection through `PI_CODING_AGENT_DIR`.

本地存储不等于本地推理；加入请求的角色、笔记和项目内容可能会发送给所选模型服务。<br>
Local storage does not mean local inference; roles, notes, and project content included in requests may be sent to the selected model provider.

不要提交认证文件、API Key、个人配置、完整会话或敏感日志；本地配置不是加密保险库，日志也不保证自动脱敏。<br>
Do not commit authentication files, API keys, personal configuration, full sessions, or sensitive logs; local configuration is not an encrypted vault, and logs are not guaranteed to be redacted.

启用角色不会授予额外权限，但角色文本会影响模型行为，因此启用前应先阅读。<br>
Activating a role grants no additional permissions, but its text can influence model behavior, so review it before activation.

工作台路径检查和桥接认证不是 Pi 工具的操作系统沙箱；插件和项目脚本仍需单独评估信任。<br>
Workbench path checks and bridge authentication are not an OS sandbox for Pi tools; assess plugins and project scripts separately.

更多设置与数据位置见 [使用指南](docs/USAGE.md)，安全建议见 [安全说明](SECURITY.md)。<br>
See the [usage guide](docs/USAGE.md) for settings and data locations, and [Security](SECURITY.md) for security guidance.

## 文档与贡献 / Documentation and contribution

- [使用与配置 / Usage and configuration](docs/USAGE.md)
- [工程架构 / Architecture](docs/ARCHITECTURE.md)
- [开发与验证 / Development and verification](docs/DEVELOPMENT.md)
- [Windows 运行时与源码交付 / Windows runtime and source delivery](scripts/WINDOWS-RUNTIME.md)
- [安装盘检查记录 / Installer inspection record](docs/releases/v1.0.3/README.md)
- [市场来源与兼容范围 / Market provenance and compatibility](市场来源与兼容范围.md)
- [参与贡献 / Contributing](CONTRIBUTING.md)
- [安全说明 / Security](SECURITY.md)
- [第三方说明 / Third-party notices](THIRD_PARTY_NOTICES.md)

欢迎通过 [GitHub Issues](https://github.com/nbang2026/Easy_pi/issues) 反馈问题或提交改进，并附上版本、操作系统、复现步骤和脱敏诊断。<br>
Report issues or propose improvements through [GitHub Issues](https://github.com/nbang2026/Easy_pi/issues), including the version, operating system, reproduction steps, and redacted diagnostics.

## 许可与致谢 / License and acknowledgments

项目采用 **[MIT License](LICENSE)**，允许在遵守许可条款的前提下使用、修改和再分发。<br>
The project is licensed under the **[MIT License](LICENSE)** and may be used, modified, and redistributed subject to its terms.

第三方组件、资源和导入的 Agent 内容遵循各自许可；内置文本角色现有元数据标记为 **CC0-1.0**。<br>
Third-party components, assets, and imported Agent content retain their respective licenses; existing built-in text-role metadata is marked **CC0-1.0**.

感谢 [Pi Coding Agent](https://pi.dev)、[Tauri](https://tauri.app)、[xterm.js](https://xtermjs.org) 以及 Rust、TypeScript 和 Vite 生态。<br>
Thanks to [Pi Coding Agent](https://pi.dev), [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org), and the Rust, TypeScript, and Vite ecosystems.

easy_pi 是基于 Pi 构建的独立项目，不代表 Pi 上游官方出品或背书。<br>
easy_pi is an independent project built around Pi and is not an official Pi release or endorsement.
