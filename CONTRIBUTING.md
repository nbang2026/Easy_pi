# 参与贡献

感谢帮助改进 easy_pi。项目采用 [MIT License](LICENSE)，欢迎提交问题反馈、文档修正、测试和功能改进。提交内容须为你有权贡献的内容；第三方代码、素材和文本需要保留适用的许可与来源。

## 开始前

- 阅读 [项目首页](README.md)、[开发指南](docs/DEVELOPMENT.md) 和 [工程架构](docs/ARCHITECTURE.md)。
- 大型功能或行为变更先在 Issue 中说明使用场景、影响范围和方案；小型修复可以直接提交 PR。
- 安全漏洞、密钥泄漏和私人数据问题请遵循 [SECURITY.md](SECURITY.md)，不要把敏感信息贴到公开 Issue。

## 报告问题

请提供：

1. easy_pi 版本或 commit、操作系统版本及 CPU 架构。
2. Pi 和 Node 版本、是否使用 `PI_EXECUTABLE`、是否为 Windows 固定运行时。
3. 最小复现步骤、预期结果与实际结果。
4. 涉及的界面：图形输入、TUI、模型设置、本地库、市场或工作台。
5. 经过脱敏的报错、截图或诊断信息。

不要上传完整的 `~/.pi/agent/`、`auth.json`、包含密钥的模型配置、完整对话或私有项目文件。

## 开发流程

```bash
git clone https://github.com/nbang2026/Easy_pi.git
cd Easy_pi
git switch -c your-change
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

完整环境与平台要求见 [开发指南](docs/DEVELOPMENT.md)。Windows 离线包并未被 Git 跟踪，请不要通过跳过哈希校验来解决缺失输入。

## 修改约定

- 延续现有 TypeScript 原生 DOM、Rust 和模块化结构，不为单个小功能引入新的 UI 框架。
- 前端桥接保持在既有 Tauri invoke / 事件体系内；不要另起未经认证的网络服务。
- 操作文件先验证路径范围；文件保存和配置修改应保留冲突检测、备份/恢复及错误反馈。
- 模型批量操作不得误删供应商密钥；Agent 导入与启用保持分离。
- 增加 UI 文案时同步考虑中英文；文档中的功能、命令、平台状态要与代码一致。
- 不修改稳定的应用标识符或 Pi 数据目录，除非变更明确包含迁移方案。
- 不提交 `node_modules/`、Rust 编译产物、凭证、用户会话和日志。不要无关地重新生成锁文件。

## Pull Request 检查表

- [ ] 描述改动原因、范围及可见行为。
- [ ] 为修改的逻辑补充或调整测试。
- [ ] 记录实际执行的命令及结果，注明未覆盖的平台与联调。
- [ ] 同步 README 和相应专题文档，不宣称未验证的安装/性能/兼容性。
- [ ] `git diff --check` 通过，没有密钥和个人数据。
- [ ] 第三方内容具备可核实的来源和许可。

文档 PR 不必声称跑过完整桌面测试；如因环境限制无法运行，明确说明即可。项目没有要求贡献者签署额外 CLA；贡献与再分发遵循仓库 MIT 许可及第三方内容原有条款。
