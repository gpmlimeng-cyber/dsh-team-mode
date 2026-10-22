# 工具清单

## 模型工具（24 个）

| 工具 | 作用 |
|---|---|
| `team_members` | 列出团队成员、角色、状态、Session |
| `team_read_messages` | 读取成员邮箱消息（可按 `thread_id` / `task_id` 过滤），标记返回的消息已读 |
| `team_send_message` | 向成员/Leader 发送团队消息，可带 `thread_id` / `goal_id` / `reply_to` |
| `team_interrupt_agent` | 打断正在运行的成员 |
| `team_mode_goal_create` | Leader 专用：为一个需要交付物的目标创建 Goal（mode=`direct` / `single` / `orchestrated`） |
| `team_mode_goal_list` | 按 Goal 汇总任务板：每个 Goal 及其 `task_ids` |
| `team_mode_goal_update` | Leader 专用：修改 Goal 状态（`active` 恢复被纪元暂停的 Goal，`paused` 暂停，`completed` / `cancelled` 结束） |
| `team_mode_task_create` | 创建任务，指定 owner / blocked_by / 文件范围 / `goal_id`，可选 `kind` / `acceptance` / `reviewed_task_id` |
| `team_mode_task_update` | 更新任务状态、owner、依赖、结果；review/verification 用 `verdict` / `findings` 结案；成员需带当前 `attempt_id` |
| `team_mode_task_claim` | 成员认领一个就绪且无 owner 的任务：原子占用并生成新的 `attempt_id` |
| `team_mode_task_list` | 查询任务板（含 owner、依赖、`attempt_id`、`goal_id`、`kind`、`verdict`） |
| `team_mode_inbox` | 只读成员收件箱：分派给我的任务、可认领任务、未读消息、待审批 |
| `team_memory_propose` | 提议/写入团队记忆：成员提议待 Leader 决定，Leader 写入立即生效 |
| `team_memory_list` | 列出团队记忆（状态、可见性、key、作者、版本）；只有 `active` 会进入提示 |
| `team_memory_accept` | Leader 专用：接受或拒绝一条记忆提议（`decision=accept` / `decision=reject`） |
| `team_create_task` | 兼容别名：创建任务（`title` / `ownerSlotId` / `fileScopes`） |
| `team_update_task` | 兼容别名：更新任务（`taskId` / `attemptId`） |
| `team_get_task_board` | 兼容别名：查询任务板 |
| `team_list_assistants` | 列出可添加的助手模板 |
| `team_describe_assistant` | 查看助手模板详情 |
| `team_spawn_agent` | 创建/唤醒团队成员 Agent；可选 `assistant_instance_id` 显式关联单聊助手实例 |
| `team_rename_agent` | 重命名成员 |
| `team_clear_agent_context` | 清空单个成员上下文 |
| `team_shutdown_agent` | 优雅下线成员 |

## Goal 与编排模式（P0）

- 模式固定为三档，由 Leader 在动手前判断：
  - `direct`（对话）：一个问题、无需交付/验证 → 直接回答，**不建 Goal、不建任务**。
  - `single`（单任务）：一个目标、一个 owner、一个可验收交付物 → 1 个 Goal + 1 个 Task。
  - `orchestrated`（编排）：2+ 并行流、2+ 成员、依赖、评审/验证、长任务 → 1 个 Goal + 依赖任务图。
- 多目标规则：共享交付物或真实依赖 → 同一 Goal；独立目标 → 分开 Goal。单个 Goal 建议 3–7 个任务，超过 10 个拆子目标。
- Leader 用 `team_mode_goal_create` 建 Goal、用 `team_mode_goal_list` 查看现有 Goal 及其任务、用 `team_mode_goal_update` 恢复或关闭 Goal；普通聊天不建 Goal。
- Goal 状态新增 `paused`：更换 Leader 会开启新团队纪元并把 `active` Goal 置为 `paused`，新 Leader 用 `team_mode_goal_update {status:"active"}` 恢复；`completed` / `cancelled` 保持历史不变。
- `team.updateGoal` 提供 Leader 权限的 Goal 状态写入（`{teamId, goalId, value}` → `TeamGoal`），与工具走同一服务方法。
- `team_mode_task_create` 的 `goal_id` 可选，必须指向**同一团队**的 Goal，否则以 `INVALID_REQUEST` 拒绝；缺省时任务不归属任何 Goal，旧任务/旧调用保持有效。
- Goal 与 `goal_id` 都是可选字段，`schemaVersion` 不变；`team.reset` 会同时清空任务与 Goal，避免遗留孤立 Goal。
- 本轮不包含 Goal UI、自动调度与自动修复循环；质量门禁见下节。

## 团队记忆（P0）

- 存储：`TeamAggregate.memory`（`{ revision, entries, updatedAt }`）为可选字段，`schemaVersion` 不变；从未写过记忆的团队保持无该字段、原样加载。条目结构与助手记忆共用 `MemoryEntry`：`id`、`scope='team'`、`visibility='team-safe'`、`status`（`active` / `proposed` / `superseded` / `archived`）、`source`（`leader` / `member`）、`authorSlotId`、可选 `key`、`title`、`body`、条目 `revision` 与时间戳。
- 权限：成员用 `team_memory_propose` 提交 `proposed` 提议；Leader 自己的写入直接 `active`。只有 Leader 能调用 `team_memory_accept`（`accept` 激活、`reject` 归档），成员无法决定任何提议，也无法决定自己写的提议。接受时若存在同 `key` 的 `active` 条目，旧条目转为 `superseded`，避免两条相反决定同时生效。
- 版本栅栏：写入的 `expected_revision` 是**记忆容器**的 `revision`（`team_memory_list` 返回，尚无记忆时为 `0`），不是团队聚合的 `revision`；任务板变化不会让记忆写入失效。过期版本返回 `MEMORY_REVISION_CONFLICT`，在团队串行写入中复查，不会覆盖并发写入。
- 注入：只有 `active`、`visibility=team-safe`、`scope=team` 的条目进入团队成员提示（与 roster 同一动态区段，每轮重读，接受后下一轮即可见），`proposed` / `superseded` / `archived` 以及任何 `private` 条目不加载；注入预算 2,000 字符。
- 上限：只统计 `active` / `proposed` 的活条目——title+body 合计 8,000 字符、最多 100 条；`archived` 与 `superseded` 属于历史，仍保留在存储里但不计入上限、不进入提示，因此拒绝提议或按 key 取代不会永久占用额度。活条目没有删除/归档操作，达到 100 条后只能先接受或拒绝未决提议、或用同 key 条目取代现有决定。
- 隔离：记忆按团队聚合存储，DM 会话和单聊助手从不读取团队记忆；其他团队也无法引用本团队条目。`team.reset` **保留**团队记忆（团队、成员、条目与可见性都不变）；解散团队时整个聚合被删除，记忆随之消失。
- 助手侧 `team-safe` 记忆只在成员被显式关联到该助手实例时注入：成员提示词只加载该实例 `active`、`scope=assistant`、`team-safe` 的结构化条目（只读、有界），不加载旧版 `content`、`private`、提案或归档条目；未关联成员不加载任何助手记忆。关联入口为创建/添加成员时的 `assistantInstanceId`、`team_spawn_agent` 的 `assistant_instance_id`，以及 `team.member.setAssistantInstance`（`null` 解除）。创建团队时的校验是写入前尽力而为（团队尚不存在，无法在聚合更新中复查）；添加成员与更新关联都会在 `store.updateTeam` 的原子更新内复查，跨团队唯一性仍是每团队原子更新下的尽力而为，没有全局锁。本轮不含记忆 UI、自动捕获和上下文压缩。

## 任务 attempt / 所有权围栏

- 任务获得 owner 或更换 owner 时生成/轮换 `attemptId`（成员 claim 也算一次获得 owner）；任务板以 `attempt_id` 返回，`task_create` / `task_update` / `task_claim` 的结果同样带 `attempt_id`。
- Leader 更新任务不需要 attempt；非 Leader（当前 owner）必须带上任务当前的 `attempt_id`，否则以 `INVALID_REQUEST` 拒绝，`details.attemptId` 给出当前值。
- 显式重派给同一 owner 不轮换；先转给他人再转回（takeover）会轮换，旧 token 永久失效。
- 历史数据（无 `attemptId`）不受围栏限制；普通状态更新不会补发 attempt，直到下一次 owner 变更才生成。`schemaVersion` 不变，字段可缺省。
- 工具参数：`team_mode_task_update` 用 `attempt_id`（也接受 `attemptId`），旧别名 `team_update_task` 用 `attemptId`（也接受 `attempt_id`）。
- 派发/转派/解锁消息会附一行 `attempt_id` 提示，成员首次更新无需再查任务板。

## 可选的成员 claim

- `team_mode_task_claim { task_id }` 让成员自己领取任务；Leader 手动派发仍是默认路径，本轮**不加**自动调度或轮询。
- 可认领 = `status=pending` **且** 无 owner **且** `dependencyIds` 为空。阻塞由 `dependencyIds` 表达，`status` 单独判断不够；终态任务可能被 Leader 重开，所以只允许 `pending`，不能用“非终态”。
- 认领在串行化的团队写入闭包内复查并落地：两个成员同时认领同一任务时只有一个成功，胜者获得新的 `attemptId`（不是沿用创建者的）。这是 `updateTask` 之外的新分支，不放宽原有的 owner/attempt 校验。
- 拒绝情形：已被认领/指派、`blocked`（依赖未完成）、`completed`/`cancelled`/`failed`、`running`、跨团队或未知任务、空 `task_id`。错误为 `INVALID_REQUEST`，`details` 给出当前的 `owner`、`attemptId`（若存在）、`status`、`blocked_by`（若被依赖阻塞），消息文本同样带上这些值，方便认领失败方直接放弃而不是重试。
- 已拥有该任务的成员重复认领是只读操作：原样返回当前的 owner 与 `attemptId`，不轮换围栏、不写任务板。
- 认领成功不额外发消息给 Leader（任务板立即可见，成员随后的 `in_progress` 更新会走既有状态消息路径）；Leader 重派或接管会生成新 `attemptId`，旧 claim token 随之失效。

## 任务质量门禁（P0）

- 任务新增四个**可选**字段，`schemaVersion` 不变，无迁移：`kind`（`work` / `implementation` / `repair` / `verification` / `review`，缺省即 `work`）、`acceptance`（验收标准，trim，≤2,000 字符）、`reviewedTaskId`（被评审的实现/修复任务）、`verdict`（`pass` / `needs_revision` / `reject`）。旧任务没有这些字段，`taskKindOf` 按 `work` 读取，行为与之前完全一致。
- 创建时（Leader 专用）：`team_mode_task_create` 接受 `kind` / `acceptance` / `reviewed_task_id`，新任务总会落盘 `kind`。`reviewed_task_id` 只能用于 `review` / `verification`，必须指向**同一团队**的 `implementation` / `repair` 任务；无 kind 的历史任务视为实现类目标仍可被评审，`review` / `verification` 任务永远不能作为目标。`kind` / `acceptance` / `reviewedTaskId` 只在创建时可写，更新接口没有对应参数。
- 结案唯一入口：`team_mode_task_update` 的 `verdict` / `findings`。门禁在串行化的团队写入闭包内、owner/attempt 校验之后复查，因此并发改派不会让旧 owner 成功写入裁决。
  - `review` / `verification` 置为 `completed` 必须同时给 `verdict=pass`；缺失或不一致以 `INVALID_REQUEST` 拒绝，任务保持不变。
  - 判失败必须 `verdict=needs_revision` 或 `reject` **且** 带非空 `findings`，任务置为 `failed`，findings 存入既有 `error` 字段（看板与状态邮件本来就会渲染它，不新增字段）。
  - `verdict=pass` 只能与 `completed` 搭配，`needs_revision` / `reject` 只能与 `failed` 搭配；普通任务（`work` 等）不接受 `verdict` 或 `findings`，旧调用保持有效。
  - 只有任务 owner 能写 `verdict`；Leader 若不是该任务 owner 也不能代写，必须先 `team_mode_task_update {owner}` 改派（会轮换 `attempt_id`）再以成员身份结案。
- 裁决只属于本次终态写入：任务离开终态（重开、回到 in_progress 等）时 `verdict` 被删除，再次结案需要新的裁决；`pass` 会清掉上一轮遗留的 `error`，任务板不会显示过期的 `pass`。
- 本流程**没有自动修复/自动评审循环**：`needs_revision` 只把评审任务置为 `failed` 并把 findings 邮给 Leader，是否新建修复任务由 Leader 手动决定。`requirements` / `integration` 两类暂不引入（当前没有可执行规则），自评审（实现者评审自己）也未在 P0 禁止。
- 工具参数：`team_mode_task_update` 用 `verdict` / `findings`；兼容别名 `team_update_task` / `team_create_task` 参数保持冻结，不暴露新字段。工具总数仍为 24。

## 消息 thread / goal / reply 上下文

- `TeamMessage` 新增三个**可选**字段，`schemaVersion` 不变：`threadId`（会话线索键）、`goalId`（该消息服务的团队 Goal）、`replyTo`（所回复消息的 id）。任务链接仍只有 `relatedTaskId` 一个字段，**没有**第二个 `taskId`；`TeamMessageView` 相应暴露 `thread_id`、`goal_id`、`reply_to`，旧消息无这些字段时照常解析与读取。
- 任务派发/转派/解锁/成员状态消息：`relatedTaskId` 是任务链接，`threadId` 取**任务 id** 作为稳定线索键（同一任务的所有消息共享一条 thread），`goalId` 从 `task.goalId` 继承（任务未归属 Goal 时不带）。因此按 `task_id` 与按 `thread_id` 都能筛出同一批任务消息。
- `team_send_message` 新增可选 `thread_id` / `goal_id` / `reply_to`：`goal_id` 必须指向**同一团队**的 Goal，`reply_to` 必须指向**本团队**已存在的消息，否则 `INVALID_REQUEST`；空白值视为未提供，超长（>200）拒绝而不是截断。
- `team_read_messages` 新增可选 `thread_id` / `task_id`：在收件人过滤之后、上限截断之前生效；只有**被返回**的消息会被标记已读，过滤范围外的未读消息保持未读（因此过滤读取不会偷走别人的未读）；不传过滤参数时行为与旧版完全一致。
- 有界性沿用现有约束：消息正文 4,000 字符预览 + `truncated`，单条消息 64 KB 上限，读取上限 50；本轮不做 thread UI 渲染，也不新增消息存储。

## 成员 inbox（只读投影）

- `team_mode_inbox { limit? }` 从既有聚合派生，**不新增任何存储、不启动轮询**；`limit` 为每段上限（1–50，默认 20），每段再封顶 20 行，整个 inbox 封顶 50 行。
- 四个段落按固定顺序填充并消耗 50 行预算：`assigned`（`ownerSlotId=me` 且状态 `assigned`/`running`/`blocked`）、`ready`（可认领：`pending` + 无 owner + 无依赖）、`unread`（消息表中收件人是我或是广播、发送者不是我且非用户私信、`readBy` 未包含我）、`approvals`（当前运行时内存中的审批）；`remaining_unread` 给出未展示的未读消息数。
- 只读：不复用会标记已读的 `team_read_messages` 路径，调用前后消息的 `deliveryState`/`readBy` 不变，可安全反复调用。消息正文沿用既有 4,000 字符预览与 `truncated` 标记。
- 作用域：工具按 `(teamId, member.id)` 注册并只读本团队聚合与消息表，其他团队的任务/消息不可达；用户私信（`sender.kind='user'`）与别人收到的消息不会出现。
- 审批只存在于运行时内存桥（`pendingInteractions`），因此该段是**可选**的：运行时未提供或重启后降级为空数组，不抛错、不落盘。P0 不含 `stale attempts` 段落：成员无法从聚合推导过期 token，该事实只在更新被拒时出现。
- 本轮不引入自动调度：inbox 只是读视图，不会唤醒成员或改变任务状态。

## 客户端 Team API

| API | 作用 |
|---|---|
| `team.list` / `team.get` | 团队列表 / 详情 |
| `team.createDraft` / `team.start` / `team.clone` | 创建草稿 / 启动 / 克隆团队 |
| `team.addMember` / `team.renameMember` / `team.removeMember` | 成员增删改 |
| `team.changeLeader` | 切换 Leader：开启新团队纪元，归档旧成员 Session、阻塞进行中任务、暂停 active Goal |
| `team.updateGoal` | 修改 Goal 状态（Leader 权限；`active` 恢复被纪元暂停的 Goal） |
| `team.member.contextReset` | 清空单成员上下文（新 Session） |
| `team.member.reconnect` | 重启成员 Agent，保留上下文 |
| `team.members.reorder` | 成员顺序（Leader 固定首位） |
| `team.pin` / `team.archive` | 置顶 / 归档 |
| `team.warmup.retry` | 重试 Leader 或失败成员的 warmup |
| `team.member.stop` | 停止单个成员 |
| `team.member.setAssistantInstance` | 显式关联成员与单聊助手实例；`assistantInstanceId=null` 解除 |
| `team.reset` / `team.dissolve` | 重置 / 解散团队 |
| `team.message.send` / `team.message.list` | 团队消息 |
| `team.activity.list` | 活动流 |
| `team.workspace.*` | 工作区树、搜索、Git 变更 / diff、上传 |
| `team.interaction.respond` | 回答提问 / 审批 |

任务板没有独立的 `team.task.*` 客户端 API：`TeamView` 就是团队聚合，看板直接读取其中的 `tasks`，所以新增的任务字段随聚合一起到达 UI，不需要额外传输方法。

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
