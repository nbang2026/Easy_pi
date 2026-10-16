# v1.0.3 macOS arm64 安装盘

[项目首页](../../../README.md) · [English](../../../README.en.md) · [校验文件](SHA256SUMS)

本记录说明用户提供的安装盘及 2026-10-16 实际执行的静态检查，不代表所有应用功能、系统版本或模型连接均已验证。是否已上传，请以 GitHub `v1.0.3` Release 的 Assets 列表为准。

## 下载与安装

1. 打开 [v1.0.3 发布页](https://github.com/nbang2026/Easy_pi/releases/tag/v1.0.3)。
2. 在 Assets 中下载 `easy_pi-1.0.3-macOS-arm64.dmg`。若未出现，表示该文件尚未可用，不应把其他压缩包当作同一文件。
3. 核对文件大小与 SHA-256，再双击挂载 DMG。
4. 将 `easy_pi.app` 拖到 `Applications`，退出磁盘镜像后从应用程序目录启动。
5. 准备可用的 Pi CLI 和模型认证，详见 [使用与配置](../../USAGE.md)。

## 文件信息

| 项目 | 实际检查结果 |
| --- | --- |
| 文件名 | `easy_pi-1.0.3-macOS-arm64.dmg` |
| 大小 | 14,729,396 字节，约 14.05 MiB |
| 镜像格式 | UDZO，只读 zlib 压缩 UDIF |
| 应用名 | `easy_pi.app` |
| 应用版本 | `1.0.3`（CFBundleShortVersionString / CFBundleVersion） |
| 可执行文件 | `Contents/MacOS/pi-app`，Mach-O arm64 |
| 包标识符 | `com.pi.desktop.gui-preview` |
| 签名 | ad-hoc，未设置 TeamIdentifier |
| 运行时资源 | 本次检查的 Resources 顶层仅见 `icon.icns`，未见捆绑的 Node/Pi |

**SHA-256**：

```text
e3212357fa24b466cc5784c0c2103a4946f5957941064ea99e1c175b85e9a16e
```

macOS 检查命令：

```bash
shasum -a 256 easy_pi-1.0.3-macOS-arm64.dmg
hdiutil verify easy_pi-1.0.3-macOS-arm64.dmg
```

也可以把本目录的 `SHA256SUMS` 和 DMG 放在同一目录，再运行 `shasum -a 256 -c SHA256SUMS`。哈希只用于确认下载字节匹配，不替代可信来源、签名和恶意软件检查。

## 已完成检查

- `hdiutil verify`：镜像 CRC 校验有效。
- 只读挂载后检查应用 Info.plist 和可执行文件架构，没有启动应用。
- `codesign -dv --verbose=2`：ad-hoc 签名，无 Developer ID TeamIdentifier。
- `codesign --verify --deep --strict --verbose=2`：本地静态签名验证通过。

## 未完成或不能推断的事项

- **没有执行应用功能、真实 Pi、模型连接或完整端到端测试。**
- **没有验证 Apple 公证、Gatekeeper 接受或 Developer ID 签名；ad-hoc 不等于这些认证。**
- Info.plist 的最低系统版本字段不是硬件/操作系统实测保证，不在此据其宣称支持范围。
- 此包标识符为 `com.pi.desktop.gui-preview`，而当前源码基础配置为 `com.pi.desktop`；可能影响 WebView 偏好等应用专属数据。没有验证二者之间的自动迁移。
- 未确认该既有二进制与本次文档提交的源码完全可复现对应；本次没有重新编译或重签名。
- Windows 和 Intel/macOS/Linux 不在这个 arm64 DMG 的验证范围。

只运行可信构建，不建议通过关闭系统安全保护来绕过未验证的发布状态。
