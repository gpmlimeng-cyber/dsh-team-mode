# DSH-Team Mode

[English](./README.md) | 简体中文

在 DeepSeek Harness 里复刻 AionUi Team Mode：一个 Leader 协调多个独立 Teammate，每个成员拥有自己的模型、权限、Session 和上下文，所有成员共享同一个 Workspace。

![DSH-Team Mode 在原生 DSH 会话中](./docs/assets/dsh-team-mode/native-conversation.png)

## 它是什么

- **不是 CLI 包装**：不依赖 Claude Code / Codex / Gemini CLI / ACP，直接使用 DSH 的 Agent、Session、模型、Agent Preset、Skills/MCP、权限和 Workspace。
- **左侧会话列表里的“团队”分组**：与原生“工作区”同一行样式（14px、同一左/右对齐、搜索 / 视图选项 / 新建图标）；显示团队、Leader、成员数、运行状态与待确认角标。
- **Leader + 独立成员**：每个成员都是独立根 Agent，各自配置模型/Preset/思考档/权限/上下文，不是 subagent。
- **主体完全复用 DSH 会话**：点击团队或成员直接在原生 Session 视图打开；消息流、输入框、附件、文件 @、右侧文件/变更 sidebar 全部是 DSH 原组件，不再有独立 Team Mode 页面。
- **25 个原生 `team_*` 工具**（22 个主名 + 3 个兼容别名）：`team_members`、`team_read_messages`、`team_send_message`、`team_interrupt_agent`、`team_mode_goal_create`、`team_mode_goal_list`、`team_mode_goal_update`、`team_mode_task_create`、`team_mode_task_update`、`team_mode_task_claim`、`team_mode_task_list`、`team_mode_inbox`、`team_escalations`、`team_memory_propose`、`team_memory_list`、`team_memory_accept`、`team_list_assistants`、`team_describe_assistant`、`team_spawn_agent`、`team_rename_agent`、`team_clear_agent_context`、`team_shutdown_agent`；兼容别名 `team_create_task`、`team_update_task`、`team_get_task_board`。
- **持久邮箱 + 任务板**：任务 owner 自动唤醒、依赖/阻塞、完成自动解除下游、广播、未读/已读、4000 字符预览。
- **动态成员生命周期**：创建后添加/移出/重命名/换 Leader/清空单成员上下文/优雅下线；只有用户明确要求时 Leader 才能下线成员。
- **每成员权限**：只读 / 工作区可写 / 完全访问；成员列内审批/提问卡片；侧边栏与成员胶囊显示待确认数量。
- **任务板 + 活动看板**：工作台顶部“任务”查看任务；“看板”按成员泳道合并消息与任务，支持排序、类型、成员筛选。

## 并行 / 看板 / 成员控件

- **并行**：每个团队成员一列，使用官方 embedded `conversation.content`，每列独立官方 `InputBar` / input hub；只有列内消息流滚动，外层固定。
- **每列身份色**：列头、成员名、头像、成员胶囊同步。
- **成员控件**：成员栏 `+` 添加成员；团队管理支持双击/铅笔改名；单聊 Header 支持切换成员，不强制打开右侧栏。
- **看板**：任务状态分组、筛选、动态流，点击任务打开 owner 成员 Session。
- **空会话**：官方 hero；普通单聊不显示团队引导卡。

![并行最终版](./docs/assets/dsh-team-mode/parallel-final.png)

![看板](./docs/assets/dsh-team-mode/team-board-empty.png)

## 快速开始

1. 保持 `@contexera/dsh-agent-team` 与旧 `@limeng/dsh-agent-team` 禁用，避免与官方 `agent-team` 或本插件的服务名冲突。
2. 安装到当前 Profile：

```bash
npm pack --pack-destination /tmp
dsh plugin --profile web add /tmp/limeng-dsh-team-mode-0.4.0.tgz
```

也可以直接从本地目录安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-team-mode
```

桌面版也可用插件管理器安装本地 bundle 目录。安装后刷新/重启 DSH Web UI。尚未发布到 npm Registry，详见 [安装文档](./docs/installation.md)。

3. 左侧会话列表出现 **团队** 分组，点击 `+`。
4. 没有成员模板时，在“新建团队”弹窗点击 **创建默认成员**（使用当前真的拥有模型的 Provider）。
5. 选择 Leader 和成员 → 团队名 → Workspace → **创建并启动**。
6. 在 Leader 会话描述目标；Leader 先给出阵容/计划，确认后再 spawn、建任务、派活。

![原生 DSH 会话 + 团队侧栏 + 文件 sidebar](./docs/assets/dsh-team-mode/native-conversation.png)

![团队分组](./docs/assets/dsh-team-mode/sidebar-team-row.png)

## 架构

```text
DSH Web Client
  sidebar.workspaces 的 DOM anchor
    └─ “团队”分组（React Portal；原生 Workspace/Session 浏览器不被替换）
  shell.overlay
    └─ 新建 / 团队管理 Modal（仅弹窗，不替换主区域）
  settings.section
    └─ 成员模板 / 模型 / 权限

Host plugin (@limeng/dsh-team-mode)
  TeamMode service  — 团队、成员、任务、邮箱、活动、配额
  TeamRuntime       — 独立根 Agent Session、Preset、模型、提示词
  InteractionBridge — 每成员提问/审批
  WorkspaceService  — 文件树/搜索/Diff/上传
  Web transport     — /dsh-team-mode/api、/events、/upload
```

成员通过 `ctx.agents.create`/`resume` + `ctx.agentPresets.mount` 创建；工具注册在每个成员自己的 Agent scope。**没有 MCP Server / TCP bridge**。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

产物：`lib/index.js`（Host）、`lib/client.js`（Web Client bundle）。

## 兼容性

- DeepSeek Harness `0.2.1-rc.2`
- Node `^22.19.0 || >=24.0.0`
- React 18

## 已知限制

- Team Mode 不再有独立主页面；左侧分组是入口，团队/成员直接打开 DSH 原生 Session；新建/管理是 Modal。
- Warmup 使用原生 Session 状态；任务板与活动看板在团队管理 Modal 中，不再有自定义工作台。
- 团队 Workspace 里的成员 Session 仍会出现在原生 Workspace 列表（团队分组是快捷入口）；只想保留团队入口时可折叠该 Workspace。
- `team_read_messages` 在工具执行时标记已读；直接消息用 `deliveryState`，广播用 `readBy`。
- shutdown 握手只在内存中，重启后不恢复。
- 某些 Provider 在模型目录里没有模型；创建默认成员会选择第一个**实际有模型**的 Provider。

## 许可证

MIT。Host runtime 派生自 `limuyang2/agent-team`（MIT）；AionUi Team Mode 作为产品行为参考（Apache-2.0）。
