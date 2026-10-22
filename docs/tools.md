# 工具清单

## 模型工具（13 个）

| 工具 | 作用 |
|---|---|
| `team_members` | 列出团队成员、角色、状态、Session |
| `team_read_messages` | 读取成员邮箱消息，标记已读 |
| `team_send_message` | 向成员/Leader 发送团队消息 |
| `team_interrupt_agent` | 打断正在运行的成员 |
| `team_task_create` | 创建任务，指定 owner / blocked_by / 文件范围 |
| `team_task_update` | 更新任务状态、owner、依赖、结果（成员需带当前 `attempt_id`） |
| `team_task_list` | 查询任务板（含 owner、依赖、`attempt_id`） |
| `team_list_assistants` | 列出可添加的助手模板 |
| `team_describe_assistant` | 查看助手模板详情 |
| `team_spawn_agent` | 创建/唤醒团队成员 Agent |
| `team_rename_agent` | 重命名成员 |
| `team_clear_agent_context` | 清空单个成员上下文 |
| `team_shutdown_agent` | 优雅下线成员 |

## 任务 attempt / 所有权围栏

- 任务获得 owner 或更换 owner 时生成/轮换 `attemptId`；任务板以 `attempt_id` 返回，`task_create` / `task_update` 的结果同样带 `attempt_id`。
- Leader 更新任务不需要 attempt；非 Leader（当前 owner）必须带上任务当前的 `attempt_id`，否则以 `INVALID_REQUEST` 拒绝，`details.attemptId` 给出当前值。
- 显式重派给同一 owner 不轮换；先转给他人再转回（takeover）会轮换，旧 token 永久失效。
- 历史数据（无 `attemptId`）不受围栏限制；普通状态更新不会补发 attempt，直到下一次 owner 变更才生成。`schemaVersion` 不变，字段可缺省。
- 工具参数：`team_mode_task_update` 用 `attempt_id`（也接受 `attemptId`），旧别名 `team_update_task` 用 `attemptId`（也接受 `attempt_id`）。

## 客户端 Team API

| API | 作用 |
|---|---|
| `team.list` / `team.get` | 团队列表 / 详情 |
| `team.createDraft` / `team.start` / `team.clone` | 创建草稿 / 启动 / 克隆团队 |
| `team.addMember` / `team.renameMember` / `team.removeMember` | 成员增删改 |
| `team.changeLeader` | 切换 Leader |
| `team.member.contextReset` | 清空单成员上下文（新 Session） |
| `team.member.reconnect` | 重启成员 Agent，保留上下文 |
| `team.members.reorder` | 成员顺序（Leader 固定首位） |
| `team.pin` / `team.archive` | 置顶 / 归档 |
| `team.warmup.retry` | 重试 Leader 或失败成员的 warmup |
| `team.member.stop` | 停止单个成员 |
| `team.reset` / `team.dissolve` | 重置 / 解散团队 |
| `team.message.send` / `team.message.list` | 团队消息 |
| `team.task.*` | 任务板读写 |
| `team.activity.list` | 活动流 |
| `team.workspace.*` | 工作区树、搜索、Git 变更 / diff、上传 |
| `team.interaction.respond` | 回答提问 / 审批 |

## 原生 Slot / UI

| 扩展点 | 用途 |
|---|---|
| `sidebar.workspaces` DOM anchor | 「团队」分组 |
| `shell.overlay` | 团队并行墙 host / 新建 / 管理 Modal |
| `conversation.view` | 并行 / 看板页签 |
| `conversation.session.header.utilities` | 动态注册团队 view |
| `conversation.session.header.actions` | 单聊成员切换器 |
| `conversation.hero.options` | 空会话提示（普通单聊隐藏） |
| `conversation.content` factory | 每列官方消息流 + 官方 Composer |
