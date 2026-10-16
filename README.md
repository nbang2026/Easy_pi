<div align="center">
  <img src="app-icon.png" width="96" alt="easy_pi 应用图标" />
  <h1>easy_pi</h1>
  <p><strong>让 Pi 编码智能体走出终端，成为触手可及的桌面工作台。</strong></p>
  <p>原生桌面窗口 · 图形交互与完整 TUI · 模型管理 · Agent 本地库 · 文件与 Git 工作台</p>
  <p><a href="README.en.md">English</a> · <a href="https://github.com/nbang2026/Easy_pi/releases">下载与发布</a> · <a href="docs/USAGE.md">使用指南</a> · <a href="docs/ARCHITECTURE.md">工程架构</a> · <a href="LICENSE">MIT License</a></p>
</div>

---

## 这是什么项目？

**easy_pi 是面向 [Pi 编码智能体](https://pi.dev) 的开源桌面工作台**，使用 **Tauri v2 + Rust + TypeScript + xterm.js** 构建。它将真实的 Pi CLI 运行在原生窗口内，保留终端 TUI，同时围绕日常编码任务提供图形输入、模型配置、Agent 管理、会话访问、文件编辑与 Git 变更查看等配套能力。

它不是新的大模型，也不是重新实现一套编码 Agent 引擎。**Pi 负责模型调用、推理与工具执行；easy_pi 负责桌面交互、进程/终端承载和本地工作流。** 这样既能沿用 Pi 的终端能力，也能减少在命令行、配置文件和其他窗口之间来回切换。

> **状态说明：** 当前源码版本为 `1.0.3`。仓库包含 macOS arm64 发布压缩包及 Windows 源码/固定运行时相关代码；Windows 当前交付脚本不生成安装程序，所需离线档案也没有被 Git 跟踪。请以实际发布资产和实测记录为准，不把“存在构建脚本”等同于“所有平台已验证可用”。

## 为什么使用 easy_pi？

- **不必放弃 TUI：** 真实 Pi 终端仍然存在，图形操作与终端操作围绕同一个 Pi 进程协作。
- **配置更直观：** 在窗口内管理模型、供应商、快捷键和角色文本，而不是只依赖手改 JSON。
- **项目上下文更集中：** 在工作区里浏览/搜索文件、编辑文本、查看 Git 差异，再把上下文交给 Pi。
- **角色复用更明确：** 本地 Agent 库和纯文本 Agent 市场将“预览、导入、启用”分开，减少误操作。
- **实现可阅读、可自建：** 前端原生 TypeScript 与 Rust 后端分层，文档说明真实依赖与数据位置，便于二次开发。

适合已经在使用 Pi、希望拥有桌面入口的开发者，也适合想研究 **Tauri + PTY + Agent 桥接** 的开发者。它不是无需配置的免费 AI 服务；仍需可用的 Pi、模型服务以及适当的本机开发工具。

## 核心能力

| 模块 | 已有能力 | 需要了解的边界 |
| --- | --- | --- |
| 桌面与终端 | Tauri 原生窗口；xterm.js 终端；终端尺寸适配；WebGL 渲染相关逻辑 | 底层依然是真实 Pi CLI，不能仅靠浏览器页面替代 |
| 图形输入与桥接 | 图形输入通过本地桥接与 Pi 扩展交互；终端输出继续保留 | 图形功能依赖桥接连接及兼容的 Pi 运行时 |
| 模型管理 | 模型列表、自定义模型/供应商、编辑、批量选择/删除及恢复移除记录 | 供应商密钥可能被同供应商多个模型共享；列表变更不等于即时切换运行中的核心 |
| Agent 本地库与记忆 | 本地文本角色、记忆笔记、角色复用与授权设置 | 同时激活一个角色，不是多 Agent 调度器；文本不能授予系统权限 |
| Agent 市场 | 内置文本目录、搜索/分类、全文预览、明确导入和独立启用；可预览公开 GitHub 文本 | 不是任意插件商店，不支持从市场安装 DSH 插件、主题、MCP 服务或可执行代码 |
| 文件与 Git 工作台 | 工作区文件浏览/搜索、文本读取/保存、Git 状态与差异、暂存/取消暂存 | 工作台路径检查不等于为 Pi 工具执行提供操作系统沙箱；Git 功能需要外部 Git |
| 会话与附件 | 读取 Pi 会话、选择附件、拖放路径和图像附件相关处理 | 会话/附件可能包含敏感源码；不要直接公开完整日志或配置目录 |
| 个性化 | 中英文界面文案、快捷键、角色设定、壁纸与界面音效设置 | 部分设置属于本地桌面层；不是完整的 Pi 云端同步机制 |
| 诊断与交付 | 运行时状态、诊断、终端日志导出、前端/后端测试与验证脚本 | 各平台需要分别实测；默认没有自动更新与统一安装验证保证 |

### easy_pi 与 Pi 的职责

| easy_pi 提供 | Pi / 外部环境提供 |
| --- | --- |
| 桌面窗口、图形控制、终端渲染和文件/Git 工作台 | 模型请求、上下文处理、编码 Agent 与工具执行 |
| 配置编辑、本地角色库和文本 Agent 预览 | 可用的模型供应商、API Key 或 Pi 支持的认证方式 |
| 启动 Pi、解析运行时路径、建立本地桥接 | Node/Pi 运行时、Git、目标项目依赖与编译器 |

**本地运行不代表离线推理。** Windows 固定运行时用于减少启动时对系统 Node/Pi 的依赖，不意味着模型请求、联网工具或第三方服务可以脱网工作。

## 平台与交付状态

| 平台 | 仓库中的内容 | 当前应如何理解 |
| --- | --- | --- |
| macOS Apple Silicon | 根目录 `easy_pi-1.0.3-macOS-arm64.zip`，以及 Tauri macOS 构建源码 | 安装资产请优先查看 Releases；基础配置未内置 macOS Pi/Node，仍需运行时准备 |
| Windows x64 | Windows 运行时解析/校验、源码打包脚本、手动 CI 和历史安装验证辅助脚本 | 当前是源码交付路径，不是开箱即用的 NSIS/MSI 发布流程；离线输入档案未被 Git 跟踪 |
| macOS Intel / Linux / 移动端 | 部分跨平台源码及生成图标/Schema | 不据此承诺发行支持或验证完成；仓库没有对应的已验证交付说明 |

不虚构最低系统版本、签名/公证状态、内存占用或安装包大小。请查看具体版本的发布说明与平台实测记录。

## 快速开始

### 1. 获取应用或源码

macOS Apple Silicon 用户请查看 [v1.0.3 发布页](https://github.com/nbang2026/Easy_pi/releases/tag/v1.0.3) 的 Assets，选择 `easy_pi-1.0.3-macOS-arm64.dmg`。只有资产列表中实际出现该文件，才表示安装盘已经上传；若没有，请勿把仓库根目录 ZIP 当作同一个文件。

安装步骤：下载 DMG → 核对 [SHA-256](docs/releases/v1.0.3/SHA256SUMS) → 双击挂载 → 将 `easy_pi.app` 拖到 `Applications` → 从应用程序目录启动。现有 ZIP 也可作为独立分发格式，解压后使用其中的应用。

已检查的 DMG 为 arm64、版本 1.0.3，磁盘镜像完整性校验和本地签名校验通过；应用采用 **ad-hoc 签名**，不是 Developer ID 签名证明，也未在本次工作中验证 Apple 公证或功能运行。详见 [安装盘检查记录](docs/releases/v1.0.3/README.md)。只打开可信来源的构建，遇到系统安全提示时先核实来源，不建议关闭系统安全保护。

需要自行构建的用户直接阅读 [开发指南](docs/DEVELOPMENT.md)。Windows 用户请先读 [Windows 运行时与源码交付说明](scripts/WINDOWS-RUNTIME.md)。

### 2. 准备 Pi

macOS 和未携带完整运行时的开发构建需要外部 Pi：

```bash
# 已具备兼容的 Node/npm 时安装 Pi CLI
npm install -g @earendil-works/pi-coding-agent
pi --version
```

本仓库 Windows 固定运行时对应 Pi **1.3.0**；外部 Pi 版本可能变化，图形扩展兼容性需要实测。若命令行可以找到 Pi 而应用不行，可设置 `PI_EXECUTABLE` 为其可执行文件的**绝对路径**，再从继承该环境的进程启动应用。无效覆盖值会直接报错。

### 3. 配置模型并打开工作区

1. 按 Pi 支持的方式完成认证，或在 easy_pi 模型设置中配置供应商、Base URL、模型 ID、协议与 API Key。
2. 选择模型；编辑配置后按界面提示 `/reload` 或重启 Pi，再确认列表和运行状态。
3. 选择工作区，通过图形输入或 TUI 向 Pi 描述任务；需要时添加文件上下文。
4. 在工作台中查看文件与 Git 差异。执行修改、运行命令和使用不可信 Agent/扩展前，确认项目来源及本机权限。

**常用配置目录是 `~/.pi/agent/`，不是 `~/.config/pi/`。** 模型、角色、快捷键和会话等实际位置详见 [使用与配置指南](docs/USAGE.md)。

## 工程概览

```text
Easy_pi/
├── README.md / README.en.md     # 中文 / 英文入口
├── docs/                       # 使用、架构与开发说明
├── index.html                  # 应用页面与界面骨架
├── src/                        # TypeScript 前端及测试
│   ├── main.ts                 # 应用装配、终端与设置交互
│   ├── bridge.ts               # Tauri IPC 入口
│   ├── workbench.ts            # 文件、会话与 Git 工作台
│   ├── model-*.ts              # 模型对话框、列表和批量操作
│   ├── agent-market.ts         # 文本 Agent 市场 UI
│   └── *.test.mjs              # 前端模块测试
├── src-tauri/
│   ├── src/lib.rs              # 原生命令、PTY 生命周期、配置读写
│   ├── src/runtime.rs          # 外部 / Windows 内置 Pi 解析
│   ├── src/gui_bridge.rs       # 本地 IPC 桥接与协议处理
│   ├── src/gui-extension.ts    # 注入 Pi 的图形交互扩展
│   ├── src/gui-library.mjs     # 本地库处理
│   ├── src/gui-market.mjs      # 文本 Agent 目录
│   ├── src/model_management.rs # 模型合并、修改与恢复
│   ├── src/workbench.rs        # 文件 / 会话 / Git 原生命令
│   └── tauri*.conf.json        # 桌面与平台打包配置
├── public/                     # 图标、壁纸与视频资源
├── scripts/                    # 测试、验证、运行时和源码交付脚本
├── .github/workflows/          # Windows 手动源码包工作流
└── LICENSE                     # MIT 许可证
```

### 开发与验证

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile

# 完整桌面开发（需 Rust / 平台工具链和可用 Pi）
pnpm tauri dev

# 前端检查、测试与构建
pnpm check
pnpm test
pnpm build

# Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`pnpm dev` 只启动前端，不具备完整 Tauri 原生功能；`pnpm build` 只生成前端产物，桌面构建使用 `pnpm tauri build`。`pnpm verify` 汇总类型检查、前端测试/构建和 Rust 测试；真实 Pi 冒烟测试需显式启用。

Windows 当前工作流仅手动触发，且缺少取得未跟踪离线包的步骤。完整依赖、验证层次与已知构建边界见 [开发指南](docs/DEVELOPMENT.md)，不以文档存在代替测试成功记录。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [使用与配置](docs/USAGE.md) | 首次使用、模型、Agent/技能、数据目录、环境变量与常见问题 |
| [工程架构](docs/ARCHITECTURE.md) | 模块边界、PTY/桥接数据流、状态与安全边界 |
| [开发与验证](docs/DEVELOPMENT.md) | 工具链、开发命令、测试、平台构建和 CI 现状 |
| [Windows 运行时](scripts/WINDOWS-RUNTIME.md) | 固定版本、输入档案、哈希校验、源码与安装包的区别 |
| [参与贡献](CONTRIBUTING.md) | Issue / PR 信息要求及修改约定 |
| [安全说明](SECURITY.md) | 不可信项目、凭证、配置权限和漏洞反馈 |
| [第三方说明](THIRD_PARTY_NOTICES.md) | 上游依赖、资源与再分发注意事项 |

## 已知边界

- 这是桌面本地应用，不是 Web 托管平台、云端 Agent 服务或多租户权限系统。
- 应用启动不会自动安装 Pi；外部 Pi、模型认证、Git 和项目依赖须另行准备。
- 市场仅处理纯文本 Agent，不是任意 MCP / npm / 主题 / 二进制插件的一键商店。
- 工作台限制自身的文件访问范围，但 Pi 工具及用户主动安装的扩展可能拥有更广的本机权限。
- 配置和日志可能含敏感信息；没有凭据保险库或全目录加密保证。
- Windows 离线档案、原生安装包、签名与端到端验证仍需真实的发布/验证流程支持。

## 贡献与反馈

欢迎通过 [Issues](https://github.com/nbang2026/Easy_pi/issues) 反馈问题，或提交文档、测试和代码改进。请提供版本、系统/架构、复现步骤和脱敏诊断，详见 [贡献指南](CONTRIBUTING.md)。

## 许可与致谢

项目采用 **[MIT License](LICENSE)**，允许在遵守许可证条件的前提下使用、修改和再分发。第三方依赖、运行时与资源遵循各自的许可；本项目 MIT 声明不覆盖上游原有权利。

感谢 [Pi](https://pi.dev)、[Tauri](https://tauri.app)、[xterm.js](https://xtermjs.org)、Rust 与 TypeScript 生态提供基础能力。easy_pi 是基于 Pi 构建的独立桌面项目，不代表上游官方出品或背书。
