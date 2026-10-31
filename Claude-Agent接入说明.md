# 历史说明：easy_pi 1.0.5–1.0.7 Claude Agent 接入

**1.0.8 起第二核心已改为跨模型的 DeepSeek Harness Agent，默认菜单项为 Pi。以下为旧版本说明，不适用于新核心的连接协议与凭据。当前用法见 [双核心与深度思考](双核心与深度思考.md)。**

## 使用方式

1.0.6 起入口统一到输入栏的“默认角色”菜单，不再重复显示引擎选择器。

- 选择“编程 Agent / Coding Agent”：继续使用原模型按钮中选择的模型，经 Pi 现有工具运行，按检查、规划、修改、验证的循环工作。支持哪些模型取决于 Pi 与服务接口的工具调用能力，不会把模型名称改成 Claude，也不声称复制了 Claude SDK。
- 选择“默认角色”或本地角色：使用 Pi 执行流程并保持原有模型配置。
- 选择“Claude Agent · 独立连接”：才切到已有的专用 SDK 后端，需要独立连接。它与跨模型编程角色在同一个菜单中，没有第二个引擎菜单。

选择 Claude Agent 后，使用“Claude 连接”设置独立的 API 密钥、模型与可选的 Base URL。默认模型为 `claude-opus-5-5`；能否调用取决于用户服务账户的实际权限。密钥只保留在应用进程及其子进程内存中，不写入普通偏好存储，不复制 Pi 或 Cherry Studio 的凭据。退出应用后需重新提供连接信息；也可通过启动环境显式提供 `ANTHROPIC_API_KEY`。

连接设置保存仅完成本地配置，不代表模型请求已成功。应用不会为了检查连接自动发起付费请求。

Claude 模式使用结构化对话视图，显示模型实际返回的正文、思考内容、工具调用、结果和审批请求。思考区域可折叠；接口未返回思考内容时不会生成替代文本。角色不是另一个后台智能体，也不会更改 Claude 工具权限。

运行中或有待批准请求时，请先停止或处理请求，再切换执行引擎。草稿和会话按引擎区分；重试不会自动重新发送上一条任务。Pi 的模型配置、终端指令、队列和扩展操作不直接适用于 Claude。

## 工具授权

Claude Agent 采用官方 SDK 的正常权限流程。对于 SDK 请求用户决定的工具调用，界面显示实际工具名和参数，用户可以单次批准或拒绝；模型提出的选择题通过专门问题界面回答。默认不会启用全局跳过权限检查。关闭或停止运行时会取消未解决的请求。

批准某次工具不等于批准未来所有工具。本应用不是操作系统安全沙箱；用户仍应核对工作区和工具请求。

## 运行资源

Claude 执行器独立于 Pi PTY，使用官方 `@anthropic-ai/claude-agent-sdk` 和其平台原生 CLI。项目依赖固定在 `agent-runtime/package.json` 与 `agent-runtime/bun.lock`，不要求全局安装 `claude`。

准备当前平台资源：

```bash
bun install --cwd agent-runtime --frozen-lockfile --ignore-scripts
node scripts/prepare-claude-runtime.mjs
node scripts/prepare-claude-runtime.mjs --check
```

阶段目录为 `src-tauri/claude-runtime/`。构建把侧车脚本、SDK 生产依赖、原生 CLI 和许可证放入 Tauri 资源目录。Mac 仍需已有 Node 环境；可以通过 `CLAUDE_NODE_EXECUTABLE` 指定有效的 Node 绝对路径。不要使用开发机绝对路径替换分发资源。

Windows 仍只交付源码。源码包包含侧车源码与锁文件，不将 Mac 原生 CLI 当作 Windows 资源。应在 Windows 安装目标依赖后运行准备脚本；固定 Node/Pi 离线归档与 Claude SDK 资源分别校验，不自动宣称整套依赖离线可安装。

## 数据与验证

Pi 会话和 Claude 会话分别管理。Claude 本地会话元数据及 SDK 数据位于应用自己的 `claude-agent` 数据目录，不导入或覆盖 Pi JSONL。共享 Agent/记忆库保持现有格式；Claude 活动角色独立保存，不改 Pi 的活动角色。

会话内容可能保存到本机，提交的正文、文件参考、Agent 与笔记也可能发送给用户选择的模型服务。不要将凭据放入角色、笔记或项目文件。

自动化验证使用临时工作区、合成 SDK 事件及假侧车，检查流式去重、权限往返、停止、进程退出和会话隔离。资源检查可以验证 SDK 装载及原生 CLI 本地启动，但不等同于付费模型调用成功。具体执行结果以该版本验证报告为准。

## 来源与许可

架构参考 Cherry Studio 的引擎与会话分层思想，实现采用 easy_pi 自有接口独立编写，没有复制 Cherry Studio 的 AGPL 实现。Claude SDK、平台 CLI 及依赖遵循其自身许可证和使用条款，随分发保留相关文件；easy_pi 的许可证不重新授予第三方组件权利。
