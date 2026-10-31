## easy_pi 1.1.0 · macOS & Windows

### 下载 / Downloads

- `easy_pi-1.1.0-macOS-arm64-20261031.dmg`：Apple Silicon / arm64 安装盘，2026-10-31 制盘；应用本体为 2026-10-28 的 1.1.0 构建，本次未重新编译。
- `easy_pi-1.1.0-macOS-Source-Environment-20261028184300.zip`：配套源码与环境，包含 Node/Pi、Claude/DSH、前端依赖、Rust 和离线 Cargo 依赖。
- `easy_pi_1.1.0_PiRepair3_20261029_x64-setup.exe`：维护者提供的 Windows x64 原始安装包，未重新编译或修改；未完成 Windows 实机验收，声明长度检查差异仍需复核。请先阅读下面的验证范围。
- `easy_pi-1.1.0-Windows-Source-20261031.zip`：从当前 1.1.0 工程整理的干净源码与 Windows Pi 运行资源；不是上述 Windows 安装包的逐字节构建快照，也不包含 Windows 编译工具链、WebView2 或全部 Claude 依赖。

附件区只保留安装包和源码。SHA-256 校验值见本文末尾；验证报告归档到仓库 `docs/releases/v1.1.0/`，不再作为独立下载附件。GitHub 自动生成的 Source code ZIP / TAR.GZ 由平台提供。

The DMG repackages the verified October 28 App without recompilation. The source-with-environment kit is a separate developer distribution, not an application installer.

### Windows 验证范围 / Windows verification scope

按维护者要求附加其提供的 Windows 安装包原文件，并单独整理可解压的当前 Windows 源码包。尚未进行 Windows 实机安装或运行验收，不会将 macOS 无法执行 EXE 当成损坏依据。本地 Windows PiRepair3 副本的非执行式检查记录如下：

- 安装程序实际为 243,150,848 字节；按 NSIS firstheader 的长度字段计算，声明的归档结尾为 263,083,822 字节，两者相差 19,932,974 字节。
- Windows 源码 ZIP 为 62,271,488 字节；标准 ZIP 检查未找到中央目录结尾。独立 libarchive 检查能够读出前面的条目，但在内嵌 `runtime-assets/windows-x64-offline.zip` 处失败：该条目声明 65,177,179 字节压缩数据，而本地文件在该数据起点后仅剩 57,294,261 字节。

这些是当前读取到的本地字节与格式检查结果，不是 Windows 实机测试结论，也未确定差异产生的原因。所提供的 EXE 按原始字节发布，不能当作已验证可用的安装包；仍需对照 Windows 端原文件的 SHA-256 和大小，并完成该平台验收。原有 Windows 源码 ZIP 未发布，改为从当前源码另行整理的新 ZIP，不能据此声称与 EXE 完全对应。上述本地原文件未修改或删除。

The Windows installer is attached unchanged at the maintainer's request. Its declared-length discrepancy is unresolved; it is not a verified working installer. No Windows-native installation or execution test is claimed. The new Windows source ZIP contains the current clean project and Pi runtime, not a claimed exact snapshot of the EXE build or a complete Windows toolchain. Original local files remain unchanged.

### 验证与限制 / Verification and limitations

- Mac DMG 完整性、制盘源 App 的版本/架构/临时签名、源码 ZIP CRC/SHA-256 已核验。
- 当前环境无法挂载 DMG，未完成挂载后验证、干净系统安装或完整 GUI 人工验收。
- Mac App 未 Apple 公证；Pi 模式仍需本机 Node 22.19+ 和 Pi CLI。SDK 资源不等于内置 Node/Pi。
- 含环境源码包不自动改变 App 内部环境，编译仍需 Xcode Command Line Tools、macOS SDK 和 Git。
- 本次未调用收费模型或进行长任务压力测试。

The Mac build is ad-hoc signed and not Apple notarized. Verify provenance and checksums, and do not disable OS security protections. Model access and project dependencies remain user-managed.

### 关于源码 / Source correspondence

主分支已同步当前 1.1.0 应用源码，并将双平台下载入口前置到中英文 README。主分支不携带依赖缓存、私有设置或大型安装器；根目录旧版 1.0.3 安装包已移除，历史提交与历史发布保留。同步前对本地源码执行 TypeScript 检查和 706 项 Node 自动测试，全部通过；未据此声称完成 Windows 实机测试。

The main branch now contains the current 1.1.0 application source. TypeScript checks and 706 Node regression tests passed on the local source before synchronization. Dependency caches, private settings and installers are excluded from main; the root-level 1.0.3 installer is removed without rewriting history or deleting older releases. The existing v1.1.0 tag is preserved, so GitHub-generated source archives still follow that earlier tag commit. Use the explicitly named platform source assets for these delivered snapshots; platform source kits have different contents.

### SHA-256

```text
d54f8e68c16a23457d7b1574430ea9ffedebf9b8ab82ecd49509288b66f23b15  easy_pi-1.1.0-macOS-arm64-20261031.dmg
8767478a35a3f7dc0452c4fd09e8144f8403b5772b23e1c268eabc8469e13b5a  easy_pi-1.1.0-macOS-Source-Environment-20261028184300.zip
ce7e2746055f540c1a0417530f2f034443f16b82d140fd3712b46149742d8a45  easy_pi_1.1.0_PiRepair3_20261029_x64-setup.exe
42480cb8147c72c45cc64483e48a8b3e580d478cbe808e3c7f520f2b581cc2e6  easy_pi-1.1.0-Windows-Source-20261031.zip
```

[验证记录 / Verification records](https://github.com/nbang2026/Easy_pi/tree/main/docs/releases/v1.1.0)
