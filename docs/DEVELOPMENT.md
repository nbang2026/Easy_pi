# 开发、构建与验证

[返回首页](../README.md) · [工程架构](ARCHITECTURE.md) · [Windows 运行时](../scripts/WINDOWS-RUNTIME.md)

本文以仓库中的 `package.json`、Tauri 配置和脚本为准。命令存在不代表已经在所有操作系统上执行验证；请在发布记录中区分静态检查、单元测试、真实 Pi 联调和安装包验证。

## 1. 工具链

| 组件 | 要求与用途 |
| --- | --- |
| Node.js | 建议使用 22.x，至少 22.19；测试通过 `--experimental-strip-types` 直接加载 TypeScript |
| pnpm | 9.x；CI 使用 pnpm 9，安装时保留 `pnpm-lock.yaml` |
| Rust / Cargo | stable 工具链；编译 Tauri 后端与运行 Rust 测试 |
| macOS 原生工具 | Xcode Command Line Tools；开发与打包依赖原生 SDK |
| Windows 原生工具 | MSVC x64、Visual Studio C++ Build Tools / Windows SDK，以及 Tauri 所需的 WebView2 环境 |
| Pi CLI | `@earendil-works/pi-coding-agent`；桌面联调需要可发现的 Pi 可执行文件 |
| Git | 克隆源码和工作台 Git 功能；不是 Node/Pi 运行时包的一部分 |

前端使用 TypeScript、Vite 和原生 DOM，而非 React/Vue；后端使用 Tauri v2、Rust 和 `portable-pty`。Windows 固定运行时记录的是 Pi 1.3.0 与 Node 22.22.2，不应误认为任意外部 Pi 版本均已验证兼容。

## 2. 获取源码

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
pnpm install --frozen-lockfile
```

不要手工修改锁文件来掩盖依赖不一致。仓库包含壁纸视频和一个 macOS 发布压缩包，克隆体积不只由源代码决定。

## 3. 本地开发

### 完整桌面应用

```bash
# 先确认 Pi 可执行文件能够运行
pi --version

# 启动 Vite + Tauri + Rust 后端
pnpm tauri dev
```

若桌面环境找不到 Pi，在同一终端设置绝对路径后再启动：

```bash
export PI_EXECUTABLE="$(command -v pi)"
pnpm tauri dev
```

`PI_EXECUTABLE` 不接受相对路径；无效覆盖值会报错，而不是静默回退。应用启动的环境必须实际继承该变量，在另一个终端设置并不会自动影响已经打开的应用。

### 仅前端开发服务器

```bash
pnpm dev
```

Vite 地址为 `http://localhost:1420`。普通浏览器没有 Tauri IPC、PTY 和文件系统命令，因此这不是完整可用的桌面应用，也不等同于远程 Web 服务。

## 4. 命令速查

| 命令 | 实际行为 |
| --- | --- |
| `pnpm dev` | 启动 Vite 开发服务器 |
| `pnpm check` | `tsc --noEmit` 类型检查 |
| `pnpm test` | 收集 `src/`、`scripts/` 顶层 `*.test.mjs`，交给 Node 测试运行器 |
| `pnpm build` | 类型检查并生成前端 `dist/`，不是桌面安装包 |
| `pnpm tauri dev` | 启动完整桌面开发环境 |
| `pnpm tauri build` | 按平台和 Tauri 配置执行原生构建 |
| `pnpm verify` | 依次执行类型检查、前端测试、前端构建及 `cargo test --lib` |
| `pnpm windows-runtime:prepare` | 从指定、哈希匹配的离线包准备 Windows 运行时 |
| `pnpm windows-runtime:check` | 检查已准备的 Windows 运行时目录及哈希 |

`pnpm verify` 默认写入根目录 `verification-report.json`，该文件已被 Git 忽略。也可指定报告路径：

```bash
pnpm verify -- --report=artifacts/verification-report.json
```

报告包含各阶段退出码和耗时；不要把失败报告描述成验证通过。

## 5. 测试分层

### 前端与脚本

```bash
pnpm check
pnpm test
pnpm build
```

测试涉及布局、终端渲染/流控、输入状态、模型列表与批量操作、快捷键、Agent 本地库/市场、工作台、壁纸和音效，以及 Windows 运行时准备逻辑。覆盖某个模块不代表完成真实操作系统和真实模型服务的端到端验证。

### Rust 后端

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

后端测试涉及运行时解析、配置读写、模型管理、桥接帧、工作区路径、文件保存冲突及 Git 参数等。需要本机 Rust 和平台原生依赖。

### 真实 Pi 冒烟测试（显式启用）

```bash
PI_GUI_SMOKE_EXECUTABLE="$(command -v pi)" \
  cargo test --manifest-path src-tauri/Cargo.toml --lib -- --include-ignored
```

真实 Pi 测试默认忽略；启用前先确认可执行路径、Pi 版本以及本机运行环境。验证脚本在设置 `PI_GUI_SMOKE_EXECUTABLE` 时也会加入 `--include-ignored`。Windows 安装包测试另外使用 `PI_GUI_SMOKE_RUNTIME` 指向包含 `runtime/windows-x64/` 的资源根目录，不能拿 macOS 测试代替 Windows 原生结果。

## 6. macOS 构建

```bash
pnpm tauri build
```

默认产物位于 `src-tauri/target/release/bundle/`；具体格式由本机平台和 Tauri 解析结果决定。仓库中的 macOS 发行压缩包标注为 arm64，不能据此承诺 Intel 或 Linux 发行支持。

- 基础配置未声明随 macOS 应用分发 Pi/Node，运行时仍需可发现的 Pi。
- 没有自动更新配置，`createUpdaterArtifacts` 为 `false`。
- 不能从源码配置推断产物已通过 Developer ID 签名或 Apple 公证。
- 签名、公证、最低系统版本与硬件实测应在具体发布记录中单独列明。

## 7. Windows：当前是源码交付路径

当前 `scripts/build-windows.ps1` 是**源码包入口**，不是安装包构建脚本：安装前端依赖 → 准备运行时 → 类型检查 → 前端测试 → 打包源码。Windows Tauri 配置的 `bundle.active` 也是 `false`。

特别注意：`runtime-assets/windows-x64-offline.zip` 被 `.gitignore` 排除，当前 Git 跟踪文件中没有该离线包。仅执行 `git clone` 后，运行时准备、源码打包及对应 CI 步骤会因缺少输入而无法完成。脚本不会自动下载该档案。

详见 [Windows 运行时与交付边界](../scripts/WINDOWS-RUNTIME.md)，其中区分运行时准备、源码包、原生程序和安装包验证。

## 8. CI 现状

`.github/workflows/windows.yml`：

- 仅在 `workflow_dispatch` 手动触发；不是每次 push / PR 的自动验证。
- 使用 Windows runner、Node 22.22.2 和 pnpm 9。
- 设计流程包含运行时准备、类型检查、前端测试和源码 ZIP 上传。
- 不运行 Cargo 测试、不编译 NSIS/MSI，也不执行安装/卸载验证。
- 现有检出步骤没有取得缺失离线包的步骤；补齐可信输入前，不应将该工作流标为开箱即用。

## 9. 提交前检查

1. 修改文案或功能后同步中文首页、英文首页及对应专题。
2. 执行 `git diff --check`，检查 Markdown 本地链接和命令是否指向真实文件。
3. 涉及代码时运行对应测试，并说明未运行的平台或联调阶段。
4. 不提交 API Key、令牌、个人 `~/.pi/` 数据、日志和会话。
5. 不顺手改应用标识符、用户数据目录、锁定运行时版本或接口协议。
6. 发布时列出真实产物、架构、签名状态和验证范围，不添加未经测量的性能数字。
