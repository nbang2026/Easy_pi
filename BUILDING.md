# 开发与构建

本文适用于 easy_pi 桌面源码工程。请先进入包含 `package.json`、`src-tauri/` 和 `agent-runtime/` 的目录；如果从上一级仓库目录开始，先执行 `cd pi-app`。

## 开发环境

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.19 或更新，满足当前依赖要求 |
| pnpm | 9，与现有构建流程保持一致 |
| Bun | 用于安装 `agent-runtime/bun.lock` 锁定的依赖 |
| Rust / Cargo | 对应目标平台的原生工具链 |
| macOS | Apple Silicon，Xcode Command Line Tools 与 macOS SDK |
| Windows | x64，MSVC Rust 工具链、Visual Studio C++ Build Tools 与 Windows SDK |

模型认证和 Pi CLI 是运行时需求，不由安装前端依赖完成。项目操作若需要 Git 或其他 SDK，也应在本机准备。

## 安装与检查

以下命令在 macOS 终端和 Windows PowerShell 中均可逐行执行：

```sh
pnpm install --frozen-lockfile
cd agent-runtime
bun install --frozen-lockfile
cd ..
pnpm check
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`pnpm test` 为脚本测试，`cargo test ... --lib` 为 Rust 库测试。需要实际 Pi 或特定运行资源的测试有独立前置条件；命令通过不代表真实模型调用、全部 GUI 交互或干净机器安装已经验收。`pnpm verify` 提供组合验证入口，运行前应检查脚本所需的原生环境。

## macOS

先准备 Node.js 22.19+ 和可用的 Pi CLI；项目已配套验证的 Pi 核心为 1.3.0。以下为 Apple Silicon 目标：

```sh
node scripts/prepare-claude-runtime.mjs --platform darwin --arch arm64
node scripts/prepare-claude-runtime.mjs --platform darwin --arch arm64 --check
pnpm tauri dev
```

构建应用：

```sh
pnpm tauri build --bundles app
```

默认产物为 `src-tauri/target/release/bundle/macos/easy_pi.app`。该命令不代办开发者签名、公证或正式发布，也不会把含环境源码包中的所有工具自动打进 App。

## Windows

在 Windows x64 上原生构建，不要将 Mac 的依赖目录直接复制过来。

Pi 运行资源准备需要与 `scripts/windows-runtime.lock.json` 匹配的离线归档。配套源码包可提供 `runtime-assets/windows-x64-offline.zip`；若公开仓库没有该二进制归档，需要先从对应交付中取得它，也可通过 `PI_WINDOWS_RUNTIME_ARCHIVE` 指向匹配的归档。脚本会核对摘要，缺失时不能跳过或仅修改校验值。

准备和启动：

```powershell
node scripts/prepare-windows-runtime.mjs
node scripts/prepare-windows-runtime.mjs --check
node scripts/prepare-claude-runtime.mjs --platform win32 --arch x64
node scripts/prepare-claude-runtime.mjs --platform win32 --arch x64 --check
pnpm tauri dev
```

安装器构建入口：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-desktop-windows.ps1
```

仅该次命令设置脚本执行策略，不要求永久修改系统策略。脚本准备两套运行资源、运行检查，并使用 `src-tauri/tauri.windows.release.conf.json` 构建 NSIS / MSI。不要把 `scripts/build-windows.ps1` 源码导出入口当作安装器构建入口。

默认输出目录：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/
```

Windows 配置携带 Node / Pi 与 Claude / DSH 资源，并使用 WebView2 离线安装器模式；构建阶段取得官方 WebView2 安装资源仍可能需要联网。Git / Git Bash 和项目自身的开发环境不在内置范围内。

可在专用、可清理的 Windows 测试账号中添加 `-VerifyInstallers` 运行安装后验证。此步骤会实际安装 NSIS、登记快捷方式和卸载信息，并执行 MSI 提取，不应当作无副作用的纯文件检查。更多细节见 [Windows 运行资源说明](scripts/WINDOWS-RUNTIME.md)。

## 含环境源码包

如果使用配套 macOS 含环境源码包，应遵循该包根目录的 README，通过 `Check-Environment.command` 检查，或通过 `Open-Environment.command` 打开已配置的终端。它包含自己的工具与依赖，通常不需要先重新安装依赖。

该环境包只面向指定架构，不代替 macOS SDK、Xcode Command Line Tools 或系统 Git，也不是 App 安装程序。

## 发布前核对

- 以 `package.json`、Tauri 配置和最终二进制确认版本、平台与架构。
- 验证对应平台的资源清单、许可文件、签名与压缩包校验值。
- 在目标系统检查首次启动、Pi / Claude 连接、权限弹窗、任务停止与重发、会话恢复。
- 不将密钥、认证信息、真实会话、个人记忆或开发机绝对路径加入发布。
- 按实际完成的测试记录结果；源码包、含环境源码包和应用安装包应分别标明。
- 公开附件前确认项目许可证与所分发第三方组件的许可要求。

本指南不保证所有构建步骤均可离线完成，也不把本地构建成功等同于 GitHub 发布完成。
