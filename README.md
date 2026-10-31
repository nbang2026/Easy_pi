<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi 应用图标 / easy_pi app icon" />
  <h1>easy_pi</h1>
  <p><strong>让 Pi 与 Claude 编码智能体拥有一个更直观的桌面工作环境。</strong></p>
  <p><strong>A more intuitive desktop workspace for Pi and Claude coding agents.</strong></p>
  <p>Windows x64 · macOS Apple Silicon · Tauri v2 · Rust · TypeScript · Vite · xterm.js</p>
  <p><strong><a href="https://github.com/nbang2026/Easy_pi/releases">Windows 安装包与 macOS 应用 / Windows installers &amp; macOS apps</a></strong></p>
  <p><a href="README.en.md">纯英文版 / English-only README</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">全部版本 / All releases</a> · <a href="BUILDING.md">开发与构建 / Build guide</a> · <a href="https://github.com/nbang2026/Easy_pi/issues">问题反馈 / Issues</a> · <a href="https://github.com/nbang2026/Easy_pi/blob/main/LICENSE">MIT License</a></p>
</div>

---

## 项目介绍 / Introduction

**easy_pi 是围绕 [Pi Coding Agent](https://pi.dev) 与独立 Claude 引擎构建的桌面图形界面和本地工作台，支持 Windows 与 macOS。**<br>
**easy_pi is a desktop GUI and local workbench built around [Pi Coding Agent](https://pi.dev) and an independent Claude engine, available for Windows and macOS.**

它将模型连接、项目会话、文件与 Git、Agent / Skill、权限审批、任务记录和用量分析集中到原生桌面窗口，让开发任务更容易开展、跟进和检查。<br>
It brings model connections, project sessions, files, Git review, Agent / Skill libraries, permission approvals, task records and usage analysis into a native desktop window.

你可以使用图形对话和工作台，也可以保留简洁终端交互；壁纸、字体和音效用于个性化，不改变引擎与项目的边界。<br>
Use the graphical conversation and workbench or keep a compact terminal workflow. Wallpapers, fonts and sounds personalize the interface without merging engine or project boundaries.

**easy_pi 提供的是桌面 Harness，不提供模型服务或免费额度，也不替代 Pi / Claude 核心。实际任务由选定引擎、你配置的模型和本地工具完成。**<br>
**easy_pi provides a desktop harness, not hosted models or free credits. Tasks are performed by the selected engine, your configured model and local tools.**

### 可以用来做什么？ / What can you do with it?

- **辅助开发：** 结合项目文件理解代码、实现功能、排查错误和补充测试。<br>
  **Development:** Explore code, implement features, investigate issues and add tests with project context.
- **审查与整理项目：** 浏览文件、编辑文本、检查 Git 差异和暂存状态。<br>
  **Review projects:** Browse files, edit text, inspect Git diffs and review staging state.
- **组织智能体工作：** 管理角色与技能，按任务选用，并在允许范围内协调只读子任务。<br>
  **Organize agent work:** Manage roles and skills, select them for tasks and coordinate constrained read-only child tasks.
- **复用上下文：** 保存项目笔记、角色定义和工作约定，为后续任务提供参考。<br>
  **Reuse context:** Keep project notes, role definitions and conventions available for later tasks.
- **控制执行过程：** 查看工具请求、确认权限、配置额度、停止任务和检查结果。<br>
  **Control execution:** Review tool requests, approve permissions, configure budgets, stop tasks and inspect results.
- **查看使用情况：** 通过趋势、明细和日历热力查看模型用量与已知费用。<br>
  **Understand usage:** Review model usage and known costs through trends, records and calendar heatmaps.

### easy_pi 与执行引擎的分工 / What easy_pi and the engines provide

| easy_pi 提供 / easy_pi provides | 引擎与外部环境提供 / Engines and environment provide |
| --- | --- |
| 桌面界面、输入栏、终端显示、工作台和项目入口。<br>Desktop UI, composer, terminal display, workbench and projects. | Pi / Claude 执行、模型请求、上下文处理与工具能力。<br>Pi / Claude execution, model requests, context processing and tools. |
| 模型连接、角色与技能管理、权限审批和任务记录。<br>Connection settings, role/skill management, approvals and task records. | 模型服务、API Key 或相应引擎支持的认证。<br>Model services, API keys or engine-supported authentication. |
| 会话入口、本地记忆、用量展示与运行环境检查。<br>Session access, local memory, usage views and environment checks. | Git、项目依赖、SDK 和平台工具；部分运行资源可随包提供。<br>Git, project dependencies, SDKs and platform tools; some runtimes may be bundled. |

## 下载与安装 / Download and install

> [!IMPORTANT]
> **Windows 与 macOS 双平台 / Windows and macOS**
>
> Windows 版现已有安装包，不再仅限源码。请在 [Releases](https://github.com/nbang2026/Easy_pi/releases) 中选择实际提供的对应平台附件；不同平台可能采用不同版本号。<br>
> Windows installers now exist; Windows is no longer source-only. Select an actual platform-specific asset from [Releases](https://github.com/nbang2026/Easy_pi/releases). Platform versions may differ.
>
> 生成安装包与上传 GitHub 是两件事；发布页未列出的新包不代表已公开下载。GitHub 自动生成的 Source code ZIP 不是应用安装器，含环境源码包也不是已安装 App。<br>
> Building and uploading are separate steps. A new package absent from Releases is not publicly downloadable there. GitHub-generated source ZIPs and source-with-environment kits are not application installers.

> [!WARNING]
> **2026-10-31 发布检查 / Publication check**：本次收到的 Windows PiRepair3 安装程序与源码 ZIP 均不完整，未上传到本次发布。Windows 附件待取得完整文件并核验后补充；请勿把当前下载入口视为已有有效的 Windows 附件。<br>
> The supplied Windows PiRepair3 installer and source ZIP are truncated and excluded from this release. Windows assets are pending intact files and verification; the download entry does not imply a valid Windows asset is currently available.

### Windows x64

**[查看 Windows 安装附件 / View Windows installation assets](https://github.com/nbang2026/Easy_pi/releases)**

1. 下载对应版本的 `.exe` 安装程序；若该版本提供 `.msi`，也可选择 MSI。<br>
   Download the release's `.exe` installer, or its `.msi` if one is provided.
2. 核对来源与随包 SHA-256，按向导安装并启动 easy_pi。<br>
   Verify provenance and the accompanying SHA-256, then install and launch easy_pi.
3. 在设置中检查运行环境，配置模型连接，选择项目并开始任务。<br>
   Check the runtime in Settings, configure a model connection and select a project.

完整 Windows 构建配置包含目标平台的 Node / Pi、Claude / DSH 运行资源，并配置随安装器携带 WebView2 离线安装资源。具体附件的内置内容和签名状态以该版本说明为准，不能仅根据文件名或大小判断。<br>
The full Windows build configuration includes target-specific Node / Pi and Claude / DSH resources and carries WebView2 offline installation resources. Check each package's notes for its actual contents and signing state; filenames or size alone are not evidence.

Git / Git Bash、项目自身的 SDK、账号与模型额度仍需自行准备。<br>
Git / Git Bash, project-specific SDKs, accounts and model credits remain your responsibility.

### macOS Apple Silicon

**[查看 macOS 应用附件 / View macOS application assets](https://github.com/nbang2026/Easy_pi/releases)**

1. 下载对应 Apple Silicon / arm64 的应用 ZIP，或该版本实际提供的 DMG，核对 SHA-256。<br>
   Download an Apple Silicon / arm64 application ZIP, or a DMG if provided, and verify its SHA-256.
2. 解压 ZIP 或挂载 DMG，将 `easy_pi.app` 放入 Applications。<br>
   Extract the ZIP or mount the DMG and move `easy_pi.app` into Applications.
3. 检查本地运行环境与引擎连接，配置模型并选择项目。<br>
   Check the local runtime and engine connection, configure a model and select a project.

现有 Mac App 的 Pi 模式需要外部 **Node.js 22.19+** 与可用的 Pi CLI；已配套验证的 Pi 核心为 **1.3.0**。Claude 运行资源按构建准备，认证与网络连接仍需自行配置。<br>
Existing Mac Apps require external **Node.js 22.19+** and a working Pi CLI for Pi mode; the paired tested Pi core is **1.3.0**. Claude resources are prepared per build, while authentication and connectivity require your configuration.

现有 Mac 候选采用 **ad-hoc 临时签名，未 Apple 公证**。请核验来源并遵循系统提示，不要关闭系统安全保护。<br>
Existing Mac candidates are **ad-hoc signed, not Apple notarized**. Verify their source and follow system prompts without disabling security protections.

### 平台与交付范围 / Platforms and distribution status

| 平台 / Platform | 当前内容与边界 / Contents and limitations |
| --- | --- |
| Windows x64 | 应用安装包与源码流程；内置资源、签名和实机验证按附件说明。<br>Application installers and source workflows; consult package notes for runtimes, signing and native validation. |
| macOS Apple Silicon / arm64 | 原生 App；Pi 模式需要外部 Node/Pi，另有独立的含环境源码包。<br>Native App; Pi mode requires external Node/Pi. A separate source-with-environment kit is also available. |
| 其他架构与平台 / Other architectures and platforms | 部分跨平台代码不等于已有发行包或完成实测。<br>Cross-platform code does not establish a release or completed validation. |

升级前先结束活动任务并退出旧版，保留必要备份，再安装或替换应用。Pi 更新提醒不等于应用自动更新。<br>
End active tasks, quit the previous version and keep necessary backups before upgrading. A Pi update notice is not an application auto-updater.

## 主要功能 / Features

### 图形对话、终端与输入 / Conversations, terminal and input

- 图形对话与工作台用于日常任务，简洁终端模式保留原生 Pi 交互。<br>
  Graphical conversation and the workbench support daily tasks, while compact terminal mode retains native Pi interaction.
- Tauri 原生后端管理 Pi 进程、PTY 与本地桥接，xterm.js 负责终端显示。<br>
  The Tauri backend manages Pi processes, PTYs and the local bridge; xterm.js renders the terminal.
- 输入栏支持文件引用、指令提示、快捷键、草稿保护及中文输入法提交保护。<br>
  The composer supports file references, command suggestions, shortcuts, draft protection and IME submission guards.
- Pi 的发送、控制与排队按引擎能力提供，不把某个引擎的操作冒充另一个引擎的功能。<br>
  Pi send, control and queue operations follow engine capabilities rather than being presented as universal commands.

### Pi / Claude / 自动选择 / Pi, Claude and Auto

Pi 与 Claude 保持独立的执行状态与会话边界。自动模式在提交前选择一个执行引擎，不是第三个核心，也不会把两套会话合并。<br>
Pi and Claude keep separate execution states and session boundaries. Auto selects one engine before submission; it is not a third core or a merged conversation.

思考强度与工作角色分别设置；是否支持某一强度或工具，取决于所选模型与引擎。<br>
Thinking level and work role are separate settings. Available levels and tools depend on the selected model and engine.

### 模型管理 / Model management

按服务商集中管理 API 地址、协议、密钥和模型，并支持模型搜索、选择与批量管理。<br>
Manage API endpoints, protocols, keys and models by provider, with search, selection and bulk operations.

已保存密钥不回显，编辑时留空保留旧值；同一服务商的模型可能共享连接设置。模型出现在列表中不代表连接已验证，也不代表已经下载模型权重。<br>
Saved keys are not echoed back; leaving a key field empty preserves its value. Models may share provider settings. A listed model is neither a verified connection nor downloaded model weights.

### Agent 市场 / Agent Market

在线目录、内置精选与已下载条目集中管理，支持搜索、分类、全文预览和本地角色管理。<br>
Browse online catalogs, built-in selections and downloaded entries with search, categories, full-text previews and local role management.

**预览、下载和启用是独立步骤。** 下载不会自动启用，也不应覆盖已有的本地编辑。外部条目的来源、工具要求和许可需自行审查。<br>
**Preview, download and activation are separate decisions.** Downloading does not activate a role or overwrite local edits. Review external entries' provenance, tool requirements and licenses.

角色定义本身不是独立并行进程，也不授予终端或网络权限；单独的插件安装入口可能获取可执行代码，不能与文本市场混为一谈。<br>
A role definition is not an independent process and grants no terminal or network access. A separate plugin-install action may fetch executable code and must not be confused with the text market.

### Skill 商店与本地库 / Skill store and library

可以搜索与预览技能、查看 `SKILL.md` 和配套文件、下载到本地，并管理启用、停用、检查更新和移除。<br>
Search and preview skills, inspect `SKILL.md` and supporting files, download locally, and manage activation, updates and removal.

下载与执行分离；启用后的应用状态仍需核对引擎是否已加载。Skill 不会自动安装系统依赖，也不能赋予引擎原本没有的工具。<br>
Downloading and execution are separate. Activation must still be confirmed by the engine's loaded state. Skills do not install system dependencies or create tools an engine does not have.

### 调度、权限与长任务 / Scheduling, permissions and long tasks

根据任务组织角色与 Skill，支持有依赖关系、并发限制和取消信号的受约束只读子任务协同。普通角色条目与实际子任务执行不是同一概念，具体支持范围取决于运行引擎。<br>
Organize roles and skills for a task and coordinate constrained read-only child tasks with dependencies, concurrency limits and cancellation. Role entries and executing child tasks are distinct, and support depends on the engine.

执行控制可配置应用层权限和任务额度，保存检查点、中断记录与验收状态。停止、重发和异常提示用于帮助处理任务生命周期，不承诺任务永不中断。<br>
Execution controls configure application permissions and task budgets and retain checkpoints, interruption records and acceptance state. Stop, resubmit and error handling assist task lifecycle management; they do not guarantee uninterrupted execution.

“无限制”只取消应用额度，不绕过用户审批、系统限制、模型上下文或供应商配额。模型停止输出不等于用户验收通过。<br>
Unlimited mode removes only the application's budget, not approvals, system limits, context limits or provider quotas. A model ending its output is not user acceptance.

### 本地资料库与记忆 / Local library and memory

保存、搜索、阅读和编辑角色定义、项目笔记与工作约定，供后续任务参考。上下文注入有容量与长度限制，不是无限记忆或全部历史自动召回。<br>
Save, search, read and edit roles, project notes and conventions for later tasks. Context injection is bounded, not unlimited memory or automatic retrieval of all history.

### 工作区、文件与 Git / Workspace, files and Git

- 切换项目、搜索与恢复已保存会话，并分别保护输入草稿。<br>
  Switch projects, search and resume saved sessions, and preserve drafts separately.
- 浏览文件树、按路径搜索并编辑支持的文本文件，保存时检查外部修改。<br>
  Browse the file tree, search paths and edit supported text files with external-change checks on save.
- 拖入或选择文件先添加引用，不立即发送任务。<br>
  Dropping or selecting a file adds a reference without immediately submitting a task.
- 查看暂存、未暂存和分支差异，按文件暂存或取消暂存。<br>
  Review staged, unstaged and branch diffs, and stage or unstage individual files.

Git 功能依赖本机 Git，不替代完整的提交、推送与合并客户端。<br>
Git features require local Git and do not replace a complete commit, push and merge client.

### 用量分析与更新提醒 / Usage analysis and update notices

查看趋势、模型分布、排行、明细、日历热力和导出结果。颜色深浅按用量展示；缺失记录和未知价格不冒充完整账单或零费用。<br>
Review trends, model breakdowns, rankings, records, calendar heatmaps and exports. Color intensity reflects usage; missing records and unknown pricing are not presented as a complete bill or zero cost.

Pi 核心更新提示用于提醒，不会静默升级、重启引擎或打断活动任务。<br>
Pi core update notices inform you without silently upgrading, restarting the engine or interrupting active work.

### 个性化界面 / Appearance and preferences

中英文界面、静态与动态壁纸、透明输入区、夜间 UI、自定义字体颜色与大小、字体导入、点击 / 打字 / 滚动音效、自定义声音包和快捷键设置。<br>
Chinese/English UI, static and animated wallpapers, transparent input, night UI, custom font colors and sizes, font import, click/typing/scroll sounds, custom sound packs and shortcut settings.

## 从源码运行与构建 / Develop and build

需要 Node.js 22.19+、pnpm 9、Bun、Rust/Cargo 与对应平台原生工具链。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC C++ Build Tools 与 Windows SDK。<br>
Use Node.js 22.19+, pnpm 9, Bun, Rust/Cargo and native platform prerequisites: Xcode Command Line Tools on macOS, or MSVC C++ Build Tools and Windows SDK on Windows.

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

若使用带外层目录的交付源码，请进入包含 `package.json` 的 `pi-app` 目录再执行后续命令。<br>
If your source kit has an outer wrapper, enter its `pi-app` directory containing `package.json` before running the project commands.

### macOS

先准备可用的外部 Node/Pi，再准备 Claude 资源并启动原生开发窗口：<br>
Prepare external Node/Pi, stage the Claude resources and start the native development window:

```bash
node scripts/prepare-claude-runtime.mjs --platform darwin --arch arm64
pnpm tauri dev
```

```bash
# 构建 macOS App / Build the macOS App
pnpm tauri build --bundles app
```

默认输出为 `src-tauri/target/release/bundle/macos/easy_pi.app`；此命令不完成开发者签名、公证或自动捆绑外部 Node/Pi。<br>
Default output: `src-tauri/target/release/bundle/macos/easy_pi.app`. This command does not provide Developer ID signing, notarization or automatic external Node/Pi bundling.

### Windows

在 Windows x64 上使用安装器构建入口：<br>
On Windows x64, use the installer build entry point:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-desktop-windows.ps1
```

构建需要与锁定摘要匹配的 `runtime-assets/windows-x64-offline.zip`；新克隆的仓库不一定包含它。请先取得可信的配套归档，不要修改摘要绕过检查。脚本准备 Node/Pi 和 Claude 资源，再构建 NSIS / MSI；WebView2 构建资源可能需要联网获取。<br>
Building requires `runtime-assets/windows-x64-offline.zip` matching the pinned hashes; a fresh clone may not include it. Obtain the trusted matching input rather than weakening validation. The script stages Node/Pi and Claude resources and builds NSIS / MSI; obtaining WebView2 build resources may need network access.

### 验证 / Verification

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm verify
```

前端、Rust、真实引擎联调、安装包与目标系统实测是不同层级，不能相互替代。`pnpm dev` 只启动前端预览，不提供原生后端。详细步骤见 [开发与构建](BUILDING.md)。<br>
Frontend, Rust, real-engine integration, installer checks and target-system testing are distinct layers. `pnpm dev` is frontend-only. See the [build guide](BUILDING.md) for details.

## 技术架构 / Architecture

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

Pi 与 Claude 的运行状态保持独立，自动选择在提交前完成；终端字节流与结构化图形控制使用不同通道。<br>
Pi and Claude keep independent runtime state, with automatic routing before submission. Terminal bytes and structured GUI control use separate channels.

| 工程目录 / Project path | 模块职责 / Responsibility |
| --- | --- |
| `src/main.ts`, `src/bridge.ts` | 前端装配、生命周期与 Tauri IPC。<br>Frontend assembly, lifecycle and Tauri IPC. |
| `src/conversation-view.ts`, `src/claude-view.ts`, `src/workbench.ts` | 对话、Claude 视图和项目工作台。<br>Conversation, Claude views and project workbench. |
| `src/model-*.ts`, `src/agent-market.ts`, `src/skill-library.ts` | 模型、Agent 与 Skill 管理界面。<br>Model, Agent and Skill interfaces. |
| `src-tauri/src/gui_bridge.rs`, `gui-extension.ts` | Pi 的认证通信与会话扩展。<br>Authenticated Pi transport and session extension. |
| `src-tauri/src/claude_runtime.rs`, `agent-runtime/` | 独立 Claude 生命周期与运行资源。<br>Independent Claude lifecycle and runtime resources. |
| `src-tauri/src/task-routing.mjs`, `task-scheduler.mjs` | 任务路由与受约束子任务调度。<br>Task routing and constrained child-task scheduling. |
| `src-tauri/src/gui-library.mjs`, `gui-skills.mjs`, `gui-usage.mjs`, `gui-harness.mjs` | 资料库、技能、用量和执行记录。<br>Library, skills, usage and execution records. |
| `public/`, `scripts/`, `.github/workflows/` | 媒体资源、验证、运行资源准备与构建流程。<br>Media, verification, runtime preparation and build workflows. |

## 数据、隐私与使用边界 / Data, privacy and limitations

Pi 和相关 GUI 数据默认位于 **`~/.pi/agent/`**；`PI_CODING_AGENT_DIR` 可重定向相关数据根目录。Windows 使用对应的用户主目录。Claude 保持独立的引擎会话与认证配置。<br>
Pi and related GUI data default to **`~/.pi/agent/`**; `PI_CODING_AGENT_DIR` redirects the related data root. Windows uses the corresponding user home. Claude maintains separate engine sessions and authentication settings.

| 数据 / Data | 相对于 Pi 数据目录的位置 / Relative location in the Pi data directory |
| --- | --- |
| 自定义模型与服务商，可能含密钥 / Custom models/providers, possibly keys | `models.json` |
| 模型目录与移除状态 / Model catalog and removal state | `models-store.json` / `gui-models.json` |
| Pi 认证与设置 / Pi authentication and settings | `auth.json` / `settings.json` |
| 人设与快捷键 / Persona and shortcuts | `APPEND_SYSTEM.md` / `keybindings.json` |
| Pi 会话、角色和记忆 / Pi sessions, roles and memory | `sessions/` / `gui-library/library.json` |
| Skill、任务与用量记录 / Skills, task records and usage | `gui-skills/` / `gui-harness/` / `gui-usage/` |

外观、草稿和部分工作区状态保存在 WebView 本地存储；自定义壁纸等资源使用 IndexedDB。迁移或卸载前应备份需要保留的数据。<br>
Appearance, drafts and some workspace state use WebView local storage; custom wallpaper resources use IndexedDB. Back up data you need before migration or removal.

本地存储不等于离线推理。发送的代码、文件、角色和记忆可能进入所选模型服务；请勿把密钥、完整会话或敏感日志提交到公开仓库。配置文件不是加密保险库。<br>
Local storage is not offline inference. Submitted code, files, roles and memory may reach your selected provider. Never commit credentials, full sessions or sensitive logs. Configuration files are not an encrypted vault.

应用层权限、路径检查和桥接认证不是操作系统级沙箱。外部 Agent / Skill 文本不能成为系统指令或授权依据，下载不等于执行，启用前应审查。<br>
Application permissions, path checks and bridge authentication are not an OS sandbox. External Agent / Skill text is not a system instruction or authorization; downloading is not execution. Review it before activation.

## 文档与贡献 / Documentation and contribution

- [开发与构建 / Development and build](BUILDING.md)
- [Windows 运行资源 / Windows runtime packaging](scripts/WINDOWS-RUNTIME.md)
- [公开仓库文档 / Repository documentation](https://github.com/nbang2026/Easy_pi/tree/main/docs)
- [参与贡献 / Contributing](https://github.com/nbang2026/Easy_pi/blob/main/CONTRIBUTING.md)
- [安全说明 / Security](https://github.com/nbang2026/Easy_pi/blob/main/SECURITY.md)
- [第三方说明 / Third-party notices](https://github.com/nbang2026/Easy_pi/blob/main/THIRD_PARTY_NOTICES.md)

欢迎通过 [GitHub Issues](https://github.com/nbang2026/Easy_pi/issues) 反馈问题或建议。请附上版本、系统与架构、执行引擎、复现步骤和脱敏诊断；提交改进时说明改动范围和验证方式。<br>
Report issues or propose improvements through [GitHub Issues](https://github.com/nbang2026/Easy_pi/issues), including version, OS/architecture, engine, reproduction steps and redacted diagnostics. Describe scope and verification when contributing changes.

## 许可与致谢 / License and acknowledgments

项目采用 **[MIT License](https://github.com/nbang2026/Easy_pi/blob/main/LICENSE)**。第三方组件、媒体和下载内容遵循各自许可，项目许可不替代这些条款。<br>
The project uses the **[MIT License](https://github.com/nbang2026/Easy_pi/blob/main/LICENSE)**. Third-party components, media and downloaded content retain their own terms.

感谢 [Pi Coding Agent](https://pi.dev)、[Tauri](https://tauri.app)、[xterm.js](https://xtermjs.org) 以及 Rust、TypeScript、Vite 和相关开源项目。<br>
Thanks to [Pi Coding Agent](https://pi.dev), [Tauri](https://tauri.app), [xterm.js](https://xtermjs.org), and the Rust, TypeScript, Vite and related open-source ecosystems.

easy_pi 是独立项目，不代表 Pi、Claude 或相关上游的官方出品或背书。<br>
easy_pi is an independent project, not an official release or endorsement from Pi, Claude or related upstream projects.
