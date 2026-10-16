<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi 应用图标" />
  <h1>easy_pi</h1>
  <p><strong>让 Pi 编码智能体拥有一个更直观的桌面工作环境。</strong></p>
  <p>A desktop workspace for the Pi coding agent.</p>
  <p><strong>Version 1.0.3 · Tauri v2 · Rust · TypeScript · Vite · xterm.js</strong></p>
  <p><strong><a href="https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg">⬇ 点击直接下载 · macOS Apple Silicon（DMG）</a></strong></p>
  <p><a href="#项目介绍">中文介绍</a> · <a href="README.en.md">English</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">全部版本</a> · <a href="docs/USAGE.md">使用指南</a> · <a href="docs/ARCHITECTURE.md">工程架构</a> · <a href="LICENSE">MIT License</a></p>
</div>

---

## 项目介绍

**easy_pi 是为 [Pi Coding Agent](https://pi.dev) 开发的开源桌面图形界面与本地工作台。**

Pi 是运行在终端中的 AI 编码智能体，可以结合模型和本地工具协助阅读代码、修改项目、排查问题和执行开发任务。easy_pi 将真实的 Pi CLI 放进原生桌面窗口，并围绕它提供模型管理、文件与 Git 工作区、会话入口、Agent 市场、本地记忆资料库和外观设置，让日常操作更直观。

你仍然可以使用 Pi 原有的终端交互和指令，也可以通过图形界面配置模型、添加文件引用和切换任务角色。**easy_pi 不提供模型服务，也不替代 Pi 核心：实际任务由 Pi、用户配置的模型和本地工具共同完成。**

适合希望保留 Pi TUI、同时获得桌面操作入口的用户，也适合研究 **Tauri + PTY + Agent 扩展桥接** 的开发者。

### 可以用来做什么？

- **辅助开发**：结合项目文件，让 Pi 协助理解代码、实现功能、排查错误和补充测试。
- **审查与整理项目**：选择代码审查、架构梳理或发布验收等角色，以相应工作流程处理任务。
- **文档与分析**：使用技术文档、数据分析和任务规划角色，处理代码之外的工作。
- **管理模型连接**：通过界面维护供应商、模型与连接配置，减少手工编辑 JSON。
- **复用项目上下文**：保存角色定义、项目笔记和约定，供后续任务参考。
- **查看本地变更**：在同一工作台中浏览文件、编辑文本、检查 Git 差异和暂存状态。

### easy_pi 与 Pi 的分工

| easy_pi 提供 | Pi / 外部环境提供 |
| --- | --- |
| 桌面窗口、图形输入、终端显示和工作台 | 模型请求、上下文处理、编码 Agent 与工具执行 |
| 模型配置、本地角色库和文本 Agent 预览 | 模型供应商、API Key 或 Pi 支持的认证方式 |
| Pi 进程启动、运行时查找和本地桥接 | Node/Pi 运行时、Git、目标项目依赖与开发工具 |

## 下载与安装

### macOS Apple Silicon

**[⬇ 点击直接下载 easy_pi-1.0.3-macOS-arm64.dmg](https://github.com/nbang2026/Easy_pi/releases/download/v1.0.3/easy_pi-1.0.3-macOS-arm64.dmg)**

适用于 M 系列芯片 Mac，无需先进入发布页查找附件。[全部版本](https://github.com/nbang2026/Easy_pi/releases) · [SHA-256 校验](docs/releases/v1.0.3/SHA256SUMS) · [安装盘检查记录](docs/releases/v1.0.3/README.md)。

> 直链需要 Release 中存在同名 DMG 才能下载；若返回 404，请确认附件是否已经发布。仓库根目录的应用 ZIP 是另一个分发文件，不是该 DMG。

**使用前先准备外部 Node 和 Pi CLI，以及可用的模型连接。** 本仓库固定 Windows 运行时使用 Pi **1.3.0**；当前开发/测试工具链建议 Node **22.x、至少 22.19**。不要据此推断任意外部 Pi 版本都已验证兼容。Pi 安装与认证参见 [官方说明](https://pi.dev)。

```bash
# 检查本地运行环境
node --version
pi --version

# 尚未安装 Pi 时，在兼容的 Node/npm 环境中安装
npm install -g @earendil-works/pi-coding-agent
```

1. 下载 DMG 并核对 SHA-256。
2. 双击挂载，将 **`easy_pi.app`** 拖入 **Applications**；使用 ZIP 时，解压后移动其中的同名应用。
3. 从应用程序目录启动，确认本地 Pi 与图形桥接连接成功。
4. 配置模型，选择工作区并开始任务。

本次检查的 DMG 包含 arm64、版本 1.0.3 的应用；镜像完整性与本地静态签名校验通过，应用采用 **ad-hoc 签名**。这不是 Developer ID 签名或 Apple 公证证明，本次也没有运行应用做功能验证。Mac 包未见捆绑 Node/Pi。请核实构建来源，不建议关闭系统安全保护来绕过提示。

### 平台与交付范围

| 平台 | 当前内容与边界 |
| --- | --- |
| macOS Apple Silicon / arm64 | DMG 分发文件及仓库应用 ZIP；需要外部 Node/Pi，具体资产以发布页为准 |
| Windows x64 | 源码包与固定运行时准备逻辑；当前交付脚本不生成 easy_pi exe/MSI，所需离线档案未被 Git 跟踪 |
| macOS Intel / Linux / 移动端 | 不因存在跨平台代码、图标或 Schema 就承诺发行支持；需要另行构建和实测 |

**本地运行不等于离线推理。** 固定运行时只解决部分本机依赖，模型请求、GitHub 预览和联网工具仍可能访问外部服务。

## 1.0.3 主要功能

### 桌面终端与图形输入

- 基于 Tauri v2 的原生桌面窗口，通过 PTY 启动真实 Pi CLI。
- 使用 xterm.js 显示终端输出，支持输入、滚动、尺寸调整和可选 WebGL 渲染。
- 提供独立图形输入栏、常用指令和会话历史入口，同时保留原生 TUI。
- 图形输入通过结构化桥接与 Pi 编辑器/上下文接口交互，不是另起一套模型会话。
- 常规布局和壁纸布局共用同一个终端与 Pi 进程；部分选择器仍需在终端完成。

### 模型管理

入口：**设置 → 模型与连接**。

可以新增和编辑自定义模型，调整名称、模型 ID、API 协议、服务地址及密钥，同时支持：

- 编辑、删除旧模型目录记录和自定义模型。
- 逐行复选、全选当前搜索结果、删除选中和清空列表。
- 恢复已移除的模型，删除前在应用内确认。
- 不回显已保存的 API Key；编辑时密钥留空表示保留原值。

移除模型条目不会顺带清空供应商密钥或地址。Key 可能由同供应商的多个模型共享，更换时需要注意影响范围。配置修改后，按提示执行 `/reload` 或重启 Pi。

这里是**连接与配置管理**，不是模型权重下载器或本地推理服务；模型出现在列表中，也不表示已经完成在线连通性验证。

### Agent 市场

入口：**设置 → Agent 市场**。内置 **8 个文本角色模板**：

| Agent | 用途 |
| --- | --- |
| 代码审查 | 检查真实变更，定位可复现的问题 |
| 故障排查 | 复现问题、分析根因并验证修复 |
| 测试工程师 | 设计边界、异常和回归测试 |
| 技术文档 | 根据代码编写说明、教程和使用文档 |
| 架构梳理 | 整理模块职责、依赖和数据流 |
| 发布验收 | 检查版本、依赖、产物和验证范围 |
| 数据分析 | 校验数据并进行可复查的分析 |
| 任务规划 | 将目标拆解为可交付、可验证的步骤 |

支持搜索、分类、已导入筛选、全文预览，以及公开 GitHub `.md` / `.txt` 定义的预览导入。

**预览 → 确认导入 → 设为当前 Agent** 是独立步骤。导入不会自动启用，重复导入不会覆盖已有本地编辑，也可以恢复默认 Pi。这里的 Agent 是角色与工作流程文本，不代表启动多个独立智能体；同一时刻只激活一个全局角色。

GitHub 预览有来源、大小、超时和文本校验限制。市场不安装 DSH 插件、主题、MCP 服务或可执行代码；应用另外的插件导入入口会执行 `pi install <source>`，需要单独审查来源。详见 [市场来源与兼容范围](市场来源与兼容范围.md)。

### 本地资料库与记忆

- 保存、搜索、阅读和编辑角色定义及项目笔记。
- 记录项目约定和需要反复参考的信息。
- 在后续任务开始时，将当前角色与有限数量的近期笔记加入 Pi 上下文。
- 用户可以控制记忆和模型自主下载 Agent 的授权；当前两项默认开启。

资料库与上下文注入设有容量和长度限制，**不是无限记忆或全部历史自动召回**。模型侧库工具不能激活角色或修改授权；这些限制不等于禁用了 Pi 的其他文件/命令工具。

### 工作区、文件与 Git

- 选择本地项目，浏览文件树并按路径名称搜索文件。
- 打开和编辑现存 UTF-8 文本文件；保存时检查外部修改，避免覆盖过期版本。
- 拖入或选择文件，把本地 `@路径` 引用加入任务草稿；不会立即发送任务。
- 查看 Git 未暂存/已暂存差异、分支比较，以及逐文件暂存/取消暂存。
- 读取和恢复 Pi 会话，支持搜索与本地置顶/归档展示状态。

文件编辑当前限制为不超过 512 KiB 的 UTF-8 文本；搜索是路径匹配，不是全文索引。Git 功能需要外部 Git，不是完整的 commit/push/merge 客户端。Windows 部分附件/路径 UI 仍有 POSIX 路径假设，兼容性需要补齐。

### 个性化界面

支持中英文界面、静态壁纸、视频背景、透明效果、字体、声音和快捷键设置。两种布局沿用同一 Pi 工作流，不会因切换外观创建新会话。自定义壁纸和部分偏好保存在本机 WebView 数据中。

## 从源码运行与构建

在包含 `package.json` 的仓库根目录操作。建议 Node 22.x（至少 22.19）、pnpm 9、Rust/Cargo stable；macOS 原生构建还需要 Xcode Command Line Tools，完整桌面联调需要可用的 Pi。

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile

pnpm check
pnpm test
pnpm tauri dev
```

`pnpm dev` 只启动 `http://localhost:1420` 的浏览器前端预览，没有完整 Tauri/Pi 后端；桌面开发使用 `pnpm tauri dev`。

### 构建 macOS 应用

```bash
pnpm tauri build --bundles app
```

默认应用产物：`src-tauri/target/release/bundle/macos/easy_pi.app`。该命令不会自动捆绑外部 Node/Pi，也不等同于生成已公证 DMG。完整平台构建可使用 `pnpm tauri build`，产物格式取决于配置与本机平台。

### 验证命令

```bash
# 仅前端类型检查、测试与构建
pnpm check
pnpm test
pnpm build

# Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml --lib

# 分阶段验证并输出报告
pnpm verify
```

`pnpm build` 不生成桌面安装程序。真实 Pi 冒烟测试需显式启用；前端、Rust、真实 Pi 联调和原生安装包检查是不同的验证层级，不应互相替代。完整要求见 [开发与验证指南](docs/DEVELOPMENT.md)。

### Windows 源码与固定运行时

源码打包流程预期携带 Node 22.22.2、npm、Pi 1.3.0 及生产依赖归档，不包含 Git、项目 SDK 或用户配置。

**从 Git 克隆不会取得 `runtime-assets/windows-x64-offline.zip`。** 该目录被忽略，现有 CI 也没有下载这个输入的步骤。先取得与校验清单匹配的可信档案，放到该路径，再执行：

```bash
pnpm install --frozen-lockfile
node scripts/prepare-windows-runtime.mjs
node scripts/prepare-windows-runtime.mjs --check
pnpm check
pnpm test
node scripts/package-source.mjs --output=artifacts/easy_pi-Windows-Source.zip
```

也可使用 PowerShell 入口：

```powershell
powershell -File scripts/build-windows.ps1 -Output .\artifacts\easy_pi-Windows-Source.zip
```

这些命令生成源码 ZIP，**不编译 easy_pi exe/MSI**。Windows 原生构建、ConPTY、WebView2 和安装/卸载需要在 Windows 另行验证。不要修改预期哈希以绕过失败。详见 [Windows 运行时与交付说明](scripts/WINDOWS-RUNTIME.md)。

## 技术架构与工程目录

```text
TypeScript 界面 / xterm.js
           │ Tauri IPC
           ▼
      Rust 桌面后端
      ├── PTY ───────────────────────→ 真实 Pi CLI
      ├── 工作区 / Git / 模型配置             │
      └── 本地认证桥接 ←────────────→ 会话级 Pi GUI 扩展
                                        ├── 图形输入 / 状态
                                        ├── Agent 资料库
                                        └── 本地记忆
```

终端字节流与 GUI 控制通道独立：前者保留 Pi 原生交互，后者同步状态并承接界面和资料库操作。**Pi 仍是执行核心，桌面层不是替代模型服务。**

```text
Easy_pi/
├── README.md / README.en.md     # 中文首页与英文完整介绍
├── docs/                       # 使用、架构、开发与安装盘记录
├── index.html                  # 页面与面板结构
├── src/                        # TypeScript 前端及 *.test.mjs 测试
│   ├── main.ts / bridge.ts     # 应用装配、终端生命周期与原生 IPC
│   ├── workbench.ts            # 文件、会话、附件和 Git UI
│   ├── model-*.ts              # 模型列表、编辑与批量操作
│   ├── agent-market.ts         # 文本 Agent 市场 UI
│   └── library-settings.ts     # Agent 与记忆库 UI
├── src-tauri/
│   ├── src/lib.rs              # 原生命令、PTY 与配置读写
│   ├── src/runtime.rs          # 外部 / Windows 内置 Pi 解析
│   ├── src/gui_bridge.rs       # 本地认证桥接与协议
│   ├── src/gui-extension.ts    # 注入 Pi 的会话级扩展
│   ├── src/gui-library.mjs     # 记忆、角色库与文本导入
│   ├── src/gui-market.mjs      # 内置角色目录与来源元数据
│   ├── src/model_management.rs # 模型合并、编辑、删除与恢复
│   ├── src/workbench.rs        # 文件、会话与 Git 原生命令
│   └── tauri*.conf.json        # 桌面与平台配置
├── public/                     # 图标、壁纸和视频资源
├── scripts/                    # 测试、验证、运行时与源码打包
├── .github/workflows/          # Windows 手动源码包工作流
└── LICENSE                     # MIT 许可
```

模块职责、数据流和边界详见 [工程架构](docs/ARCHITECTURE.md)。

## 数据、隐私与使用边界

默认用户目录为 **`~/.pi/agent/`，不是 `~/.config/pi/`**。Windows 在 HOME 缺失时由 USERPROFILE 补齐。

| 内容 | 主要位置 |
| --- | --- |
| 自定义模型/供应商，可能含 API Key | `models.json` |
| 模型目录与移除/恢复状态 | `models-store.json` / `gui-models.json` |
| 认证与 Pi 设置 | `auth.json` / `settings.json` |
| 人设与快捷键 | `APPEND_SYSTEM.md` / `keybindings.json` |
| 会话与本地角色/记忆 | `sessions/` / `gui-library/library.json` |

表中路径均相对于 `~/.pi/agent/`。外观、草稿、工作区及会话展示状态使用 WebView localStorage，自定义壁纸使用 IndexedDB；更多路径见 [使用与配置指南](docs/USAGE.md)。GUI 尚未全面适配 `PI_CODING_AGENT_DIR` 的自定义目录重定向。

- **本地存储不等于本地推理**：加入请求的角色、笔记和项目内容可能发送到所选模型服务。
- 不提交认证文件、API Key、个人配置、完整会话和敏感日志；配置不是加密保险库，日志也没有自动脱敏保证。
- 启用 Agent 不授予额外权限，但角色文本会影响模型行为，启用前应先阅读。
- 工作台路径检查和桥接认证不是 Pi 工具的操作系统沙箱；插件与项目脚本需要单独判断信任。
- 这是本地桌面应用，不是云端服务、多租户权限平台或并行多 Agent 调度器。

安全反馈与处理建议见 [SECURITY.md](SECURITY.md)。

## 文档与贡献

| 文档 | 内容 |
| --- | --- |
| [使用与配置](docs/USAGE.md) | 首次使用、模型、角色与记忆、数据目录和常见问题 |
| [工程架构](docs/ARCHITECTURE.md) | 模块职责、PTY/桥接数据流与安全边界 |
| [开发与验证](docs/DEVELOPMENT.md) | 工具链、测试、构建与 CI 现状 |
| [Windows 运行时](scripts/WINDOWS-RUNTIME.md) | 固定档案、哈希校验与交付范围 |
| [安装盘记录](docs/releases/v1.0.3/README.md) | DMG 大小、SHA-256、签名与验证范围 |
| [市场来源与兼容范围](市场来源与兼容范围.md) | 文本角色、来源与许可边界 |
| [参与贡献](CONTRIBUTING.md) | Issue / PR 信息要求及修改约定 |
| [第三方说明](THIRD_PARTY_NOTICES.md) | 上游依赖、媒体与再分发注意事项 |

欢迎提交文档、测试和代码改进。通过 [Issues](https://github.com/nbang2026/Easy_pi/issues) 反馈时，请提供版本、系统/架构、复现步骤和脱敏诊断，不要上传私人配置目录。

## English overview

**easy_pi 1.0.3** is a native desktop workspace for the real Pi coding agent. It keeps the terminal TUI while adding graphical model controls, workspace files and Git review, an eight-entry text Agent catalog, reusable local notes, session access and appearance settings. Pi and the configured model perform the tasks; easy_pi provides the desktop environment.

The Mac app targets Apple Silicon and uses external Node/Pi. Windows currently follows a source-kit delivery path, not an exe/MSI release pipeline. Agents are role definitions, not parallel processes. See the [full English README](README.en.md) for downloads, setup, architecture and limitations.

## License / 许可

项目采用 **[MIT License](LICENSE)**，允许在遵守条款的前提下使用、修改和再分发。第三方组件、资源和导入 Agent 保留各自的许可；内置文本角色的现有元数据标记为 **CC0-1.0**，不会因项目采用 MIT 而被替换。

## 致谢 / Acknowledgements

感谢 [Pi Coding Agent](https://pi.dev)、[Tauri](https://tauri.app)、[xterm.js](https://xtermjs.org) 以及 Rust、TypeScript、Vite 生态。easy_pi 是基于 Pi 构建的独立项目，不代表上游官方出品或背书。
