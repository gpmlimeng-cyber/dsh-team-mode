# 工具清单

## 模型工具（21 个）

| 工具 | 作用 |
|---|---|
| `team_members` | 列出团队成员、角色、状态、Session |
| `team_read_messages` | 读取成员邮箱消息，标记已读 |
| `team_send_message` | 向成员/Leader 发送团队消息 |
| `team_interrupt_agent` | 打断正在运行的成员 |
| `team_mode_goal_create` | Leader 专用：为一个需要交付物的目标创建 Goal（mode=`direct` / `single` / `orchestrated`） |
| `team_mode_goal_list` | 按 Goal 汇总任务板：每个 Goal 及其 `task_ids` |
| `team_mode_task_create` | 创建任务，指定 owner / blocked_by / 文件范围 / `goal_id` |
| `team_mode_task_update` | 更新任务状态、owner、依赖、结果（成员需带当前 `attempt_id`） |
| `team_mode_task_list` | 查询任务板（含 owner、依赖、`attempt_id`、`goal_id`） |
| `team_memory_propose` | 提议/写入团队记忆：成员提议待 Leader 决定，Leader 写入立即生效 |
| `team_memory_list` | 列出团队记忆（状态、可见性、key、作者、版本）；只有 `active` 会进入提示 |
| `team_memory_accept` | Leader 专用：接受或拒绝一条记忆提议（`decision=accept` / `decision=reject`） |
| `team_create_task` | 兼容别名：创建任务（`title` / `ownerSlotId` / `fileScopes`） |
| `team_update_task` | 兼容别名：更新任务（`taskId` / `attemptId`） |
| `team_get_task_board` | 兼容别名：查询任务板 |
| `team_list_assistants` | 列出可添加的助手模板 |
| `team_describe_assistant` | 查看助手模板详情 |
| `team_spawn_agent` | 创建/唤醒团队成员 Agent |
| `team_rename_agent` | 重命名成员 |
| `team_clear_agent_context` | 清空单个成员上下文 |
| `team_shutdown_agent` | 优雅下线成员 |

## Goal 与编排模式（P0）

- 模式固定为三档，由 Leader 在动手前判断：
  - `direct`（对话）：一个问题、无需交付/验证 → 直接回答，**不建 Goal、不建任务**。
  - `single`（单任务）：一个目标、一个 owner、一个可验收交付物 → 1 个 Goal + 1 个 Task。
  - `orchestrated`（编排）：2+ 并行流、2+ 成员、依赖、评审/验证、长任务 → 1 个 Goal + 依赖任务图。
- 多目标规则：共享交付物或真实依赖 → 同一 Goal；独立目标 → 分开 Goal。单个 Goal 建议 3–7 个任务，超过 10 个拆子目标。
- Leader 用 `team_mode_goal_create` 建 Goal、用 `team_mode_goal_list` 查看现有 Goal 及其任务；普通聊天不建 Goal。
- `team_mode_task_create` 的 `goal_id` 可选，必须指向**同一团队**的 Goal，否则以 `INVALID_REQUEST` 拒绝；缺省时任务不归属任何 Goal，旧任务/旧调用保持有效。
- Goal 与 `goal_id` 都是可选字段，`schemaVersion` 不变；`team.reset` 会同时清空任务与 Goal，避免遗留孤立 Goal。
- 本轮不包含 Goal UI、自动调度与质量门禁。

## 团队记忆（P0）

- 存储：`TeamAggregate.memory`（`{ revision, entries, updatedAt }`）为可选字段，`schemaVersion` 不变；从未写过记忆的团队保持无该字段、原样加载。条目结构与助手记忆共用 `MemoryEntry`：`id`、`scope='team'`、`visibility='team-safe'`、`status`（`active` / `proposed` / `superseded` / `archived`）、`source`（`leader` / `member`）、`authorSlotId`、可选 `key`、`title`、`body`、条目 `revision` 与时间戳。
- 权限：成员用 `team_memory_propose` 提交 `proposed` 提议；Leader 自己的写入直接 `active`。只有 Leader 能调用 `team_memory_accept`（`accept` 激活、`reject` 归档），成员无法决定任何提议，也无法决定自己写的提议。接受时若存在同 `key` 的 `active` 条目，旧条目转为 `superseded`，避免两条相反决定同时生效。
- 版本栅栏：写入的 `expected_revision` 是**记忆容器**的 `revision`（`team_memory_list` 返回，尚无记忆时为 `0`），不是团队聚合的 `revision`；任务板变化不会让记忆写入失效。过期版本返回 `MEMORY_REVISION_CONFLICT`，在团队串行写入中复查，不会覆盖并发写入。
- 注入：只有 `active`、`visibility=team-safe`、`scope=team` 的条目进入团队成员提示（与 roster 同一动态区段，每轮重读，接受后下一轮即可见），`proposed` / `superseded` / `archived` 以及任何 `private` 条目不加载；注入预算 2,000 字符。
- 上限：只统计 `active` / `proposed` 的活条目——title+body 合计 8,000 字符、最多 100 条；`archived` 与 `superseded` 属于历史，仍保留在存储里但不计入上限、不进入提示，因此拒绝提议或按 key 取代不会永久占用额度。活条目没有删除/归档操作，达到 100 条后只能先接受或拒绝未决提议、或用同 key 条目取代现有决定。
- 隔离：记忆按团队聚合存储，DM 会话和单聊助手从不读取团队记忆；其他团队也无法引用本团队条目。`team.reset` **保留**团队记忆（团队、成员、条目与可见性都不变）；解散团队时整个聚合被删除，记忆随之消失。
- 助手侧 `team-safe` 记忆在本轮仍不注入团队：团队成员还无法解析到所属助手实例（成员 → 助手实例身份关联属于 P1），因此不会伪造该链接。本轮不含记忆 UI、自动捕获和上下文压缩。

## 任务 attempt / 所有权围栏

- 任务获得 owner 或更换 owner 时生成/轮换 `attemptId`；任务板以 `attempt_id` 返回，`task_create` / `task_update` 的结果同样带 `attempt_id`。
- Leader 更新任务不需要 attempt；非 Leader（当前 owner）必须带上任务当前的 `attempt_id`，否则以 `INVALID_REQUEST` 拒绝，`details.attemptId` 给出当前值。
- 显式重派给同一 owner 不轮换；先转给他人再转回（takeover）会轮换，旧 token 永久失效。
- 历史数据（无 `attemptId`）不受围栏限制；普通状态更新不会补发 attempt，直到下一次 owner 变更才生成。`schemaVersion` 不变，字段可缺省。
- 工具参数：`team_mode_task_update` 用 `attempt_id`（也接受 `attemptId`），旧别名 `team_update_task` 用 `attemptId`（也接受 `attempt_id`）。
- 派发/转派/解锁消息会附一行 `attempt_id` 提示，成员首次更新无需再查任务板。

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
