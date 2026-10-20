# 工具清单

## 模型工具（13 个）

| 工具 | 作用 |
|---|---|
| `team_members` | 列出团队成员、角色、状态、Session |
| `team_read_messages` | 读取成员邮箱消息，标记已读 |
| `team_send_message` | 向成员/Leader 发送团队消息 |
| `team_interrupt_agent` | 打断正在运行的成员 |
| `team_task_create` | 创建任务，指定 owner / blocked_by / 文件范围 |
| `team_task_update` | 更新任务状态、owner、依赖、结果 |
| `team_task_list` | 查询任务板 |
| `team_list_assistants` | 列出可添加的助手模板 |
| `team_describe_assistant` | 查看助手模板详情 |
| `team_spawn_agent` | 创建/唤醒团队成员 Agent |
| `team_rename_agent` | 重命名成员 |
| `team_clear_agent_context` | 清空单个成员上下文 |
| `team_shutdown_agent` | 优雅下线成员 |

## 客户端 Team API

| API | 作用 |
|---|---|
| `team.list` / `team.get` | 团队列表 / 详情 |
| `team.createDraft` / `team.create` | 创建草稿 / 启动团队 |
| `team.addMember` | 添加成员 |
| `team.renameMember` | 成员改名 |
| `team.removeMember` | 移出成员 |
| `team.changeLeader` | 切换 Leader |
| `team.clearMemberContext` | 清空单成员上下文 |
| `team.reset` / `team.dissolve` | 重置 / 解散团队 |
| `team.message.send` / `team.message.list` | 团队消息 |
| `team.task.*` | 任务板读写 |
| `team.activity.list` | 活动流 |

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
