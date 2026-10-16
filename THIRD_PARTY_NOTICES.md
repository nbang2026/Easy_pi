# 第三方依赖与资源说明

[项目首页](README.md) · [MIT License](LICENSE) · [Agent 市场来源](市场来源与兼容范围.md)

easy_pi 自身采用 MIT 许可。外部软件、库、运行时、导入文本、字体/图标及媒体资源仍可能适用各自的许可、署名和分发要求；本项目 LICENSE 不替代这些条款。

**本文件是工程来源索引，不是完整的第三方许可证文本集合、SBOM、版权权属确认或已经完成的法律合规审计。** 发布者必须根据实际构建和分发内容核实。

## 1. 主要软件组件

| 组件 | 在项目中的角色 | 核实入口 |
| --- | --- | --- |
| Pi / `@earendil-works/pi-coding-agent` | 真实编码 Agent、TUI 与扩展接口 | 所使用的 Pi 包、上游仓库及其 LICENSE/NOTICE |
| Tauri v2 | 桌面运行时、IPC 与打包 | `package.json`、`src-tauri/Cargo.toml` 及相应包/Crate 的许可 |
| xterm.js 与 fit/WebGL addons | 终端显示、尺寸与可选 GPU 渲染 | `package.json`、`pnpm-lock.yaml` 与安装包内的许可 |
| TypeScript / Vite | 类型检查与前端构建 | 前端锁文件与工具包元数据 |
| fflate | ZIP 解包/打包 | 前端锁文件与包许可 |
| lucide | 界面图标依赖 | 包许可与实际使用的图标资源 |
| portable-pty、serde、serde_json、getrandom | PTY、序列化与随机数 | Rust manifest、`Cargo.lock` 和 Crate 许可 |
| happy-dom、fake-indexeddb | 测试环境 | 开发依赖与对应包许可 |

版本和完整传递依赖应从锁文件与实际安装结果取得，而不是仅复制这个摘要表。Windows 固定运行时还包含 Pi 的生产依赖树。

## 2. Windows 运行时

- 固定 Node 22.22.2、npm 和 Pi 1.3.0 的版本/来源见 `scripts/windows-runtime-pins.json`。
- 档案及依赖树校验见 `scripts/windows-runtime.lock.json`。哈希只证明字节匹配，不自动证明分发许可充分。
- 归档源码包中可能携带二进制 Node 与其他原生模块，不应将其描述为全部依赖均为纯源码。
- 保留 Node、npm、Pi 及所有传递依赖的 LICENSE / NOTICE 文件；打包前核对实际随包组件。
- Git/Git Bash、项目 SDK 与 WebView2 安装器的来源/再分发要求需要分别处理；它们不能被混称为同一个 Pi 运行时。

## 3. Agent 文本

内置文本角色的来源/许可元数据定义在 `src-tauri/src/gui-market.mjs`，其中已有 CC0-1.0 声明；不要因为项目改用 MIT 就重写该层元数据。外部 GitHub 文本的许可由其权利人决定，公开访问不等于可任意再发布。详情见 [市场来源与兼容范围](市场来源与兼容范围.md)。

## 4. 图标、图片、视频与音效

仓库包含应用图标、壁纸图片/视频及音效相关资源/生成脚本。源码存在或 MIT 根许可证的存在，不单独证明每个媒体文件的作者、来源和再分发授权。若未找到独立来源记录，发布者应向维护者核实后补充，不能在此虚构“全部原创”或第三方授权。

后续新增资源应同步记录：文件路径、原作者/来源、许可、署名要求以及是否允许修改/商业分发。对于权属无法确认的资源，发布前应替换或排除。

## 5. 发布核对清单

1. 从实际打包文件与锁文件生成依赖清单，而不是只看直接依赖。
2. 保留必须随分发附带的许可、版权、NOTICE 与署名。
3. 对媒体资源、Agent 文本及二进制运行时单独核实来源。
4. 不把第三方名称/商标用于暗示官方关联、认证或背书。
5. 不将开发者私有配置、密钥、会话和日志混入发行物。
