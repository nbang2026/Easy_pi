# easy_pi

> 让 pi 编码智能体拥有一个干净的桌面窗口 —— 开箱即用，无需折腾终端。
>
> A clean desktop window for the pi coding agent — out of the box, no terminal wrangling required.

---

## 中文介绍

**easy_pi** 是基于 [pi 编码智能体](https://pi.dev)（`@earendil-works/pi-coding-agent`）打造的桌面图形壳，使用 **Tauri v2 + xterm.js** 构建。pi 本身是一个强大的终端 TUI 工具，但需要自己开终端、配环境；easy_pi 把它装进一个原生窗口里，双击即用。

### 特性

- **原生窗口**：Tauri v2 封装，安装包小、内存占用低（macOS arm64）
- **完整终端体验**：xterm.js + WebGL 渲染，256 色 / 真彩色，支持 pi 的全部 TUI 交互
- **拖拽上传**：把文件直接拖进窗口，自动以 `@路径` 填入输入框发给 pi
- **环境自适配**：自动注入 `TERM=xterm-256color`、`COLORTERM=truecolor`、`LANG` 等，避免花屏与乱码
- **Windows 离线运行时**：内置 Windows 打包脚本，可携带便携版 Node/Git 离线运行
- **可自建**：源码完整开放，可自行编译 macOS / Windows 安装包

### 快速开始

1. 从 [Releases](https://github.com/nbang2026/Easy_pi/releases) 下载对应平台的安装包
2. macOS：解压后把 `Pi.app` 拖入「应用程序」即可（首次打开若提示无法验证，右键 → 打开）
3. 启动后即是 pi 的完整交互界面，登录 / 配置与官方 pi 完全一致（`~/.config/pi/`）

### 从源码构建

```bash
pnpm install
pnpm tauri build        # macOS 产物在 src-tauri/target/release/bundle/
```

Windows 构建需要 Rust + MSVC + WiX，详见 `scripts/WINDOWS-RUNTIME.md`。

### 环境要求

- 已安装 pi：`npm install -g @earendil-works/pi-coding-agent`（应用启动时自动调用系统中的 `pi`）
- macOS 11+（Apple Silicon）

---

## English

**easy_pi** is a desktop GUI shell for the [pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`), built with **Tauri v2 + xterm.js**. pi itself is a powerful terminal TUI tool that requires opening a terminal and configuring the environment; easy_pi wraps it in a native window — just double-click and go.

### Features

- **Native window**: Tauri v2 wrapper with a tiny bundle and low memory footprint (macOS arm64)
- **Full terminal experience**: xterm.js with WebGL rendering, 256-color / truecolor, all pi TUI interactions supported
- **Drag & drop upload**: drop files into the window and they are auto-filled as `@path` into the input box for pi
- **Environment auto-tuning**: injects `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG`, etc. to prevent garbled output
- **Windows offline runtime**: bundled Windows packaging scripts to ship a portable Node/Git runtime
- **Build it yourself**: fully open source; compile your own macOS / Windows installers

### Quick Start

1. Download the installer for your platform from [Releases](https://github.com/nbang2026/Easy_pi/releases)
2. macOS: unzip and drag `Pi.app` into Applications (if macOS blocks first launch, right-click → Open)
3. Launch it and you get the full pi interface — auth and config are identical to official pi (`~/.config/pi/`)

### Build from Source

```bash
pnpm install
pnpm tauri build        # macOS artifact at src-tauri/target/release/bundle/
```

Windows builds require Rust + MSVC + WiX; see `scripts/WINDOWS-RUNTIME.md`.

### Requirements

- pi installed: `npm install -g @earendil-works/pi-coding-agent` (the app invokes the system `pi` on launch)
- macOS 11+ (Apple Silicon)

---

## License / 许可
MIT
