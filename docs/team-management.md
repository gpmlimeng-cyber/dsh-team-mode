# 团队管理

[上一篇：Workspace](./workspace.md) · [文档首页](./README.md) · [下一篇：故障排查](./troubleshooting.md)

点击工作台顶部的 **团队管理**，可以管理成员、Leader、上下文和团队生命周期。

## 添加成员

点击 **添加成员** 后，会打开助手列表弹窗：

1. 选择一个助手。
2. 系统基于助手当前配置创建新的成员快照。
3. 为成员创建独立 Session，并关联团队 Workspace。
4. 新成员启动成功后自动加入工作台。
5. Leader 收到包含成员名称、成员 ID、模型和就绪状态的通知。

同一个助手可以重复添加，不需要设置别名。界面名称保持助手原名，系统使用稳定成员 ID 区分实例。

## 关联单聊助手实例（API，本期无界面）

团队成员可以显式关联到一个单聊助手实例，从而只读地获得该实例的结构化记忆。关联完全显式：插件不会根据助手模板、Workspace 或已有实例自动推断，未关联的成员（包括所有旧成员）行为不变，`assistantInstanceId` 字段可选且没有 schema 版本升级。

可用的入口：

| 入口 | 字段 |
| --- | --- |
| `team.createDraft` 的 `members[]` | `assistantInstanceId`（可选） |
| `team.addMember` | `assistantInstanceId`（可选） |
| `team.member.setAssistantInstance` | `assistantInstanceId: string \| null`，显式更新或解除关联 |
| `team_spawn_agent` | 可选 `assistant_instance_id` |

写入前会严格校验：

- 实例必须存在且未归档。
- 实例的 `workspaceId` 与 `workspacePath` 必须与团队完全一致。
- 同一实例不能被同一团队的第二个成员关联，也不能被另一个已存储的团队关联（尽力而为：检查发生在同一团队的原子更新内，没有全局锁）。
- 本仓库没有助手 owner 字段，因此无法校验 owner；Workspace 是当前可执行的最高作用域。

注入规则：只有被显式关联成员的系统提示词会加入该实例的结构化记忆，且仅包含 `active`、`scope=assistant`、`visibility=team-safe` 的条目，长度有界；`private` 条目、提案、归档条目和旧版 `content` 文本永远不会进入团队提示词。成员只能读取，没有修改助手记忆的工具。提示词每回合实时读取，因此新增、解除或归档关联会在下一回合生效，无需重启成员 Session。

关联的生命周期：

- 更换 Leader、重置单个成员上下文、重置团队：保留关联。
- 克隆团队：丢弃所有关联，避免克隆团队继承源团队的助手记忆。
- 实例归档或不可用：读取降级为空，成员 Session 继续正常工作。

本期不提供界面选择器；创建/添加成员可通过现有传输方法传入链接，更新/解除通过服务层方法完成。

## 团队记忆

团队管理弹窗中的团队卡片（以及已经存在记忆的团队列表卡片）会显示「团队记忆」面板，直接读取 `TeamView.memory`，不做额外轮询：

- **生效记忆**与**待确认提案**分组显示；每条显示可见性、状态、来源、可选 key、更新时间和条目版本。`archived` / `superseded` 历史折叠展示，只渲染最近 20 条，避免无界列表。
- **变更日志**单独列出每次新建/修改/接受/驳回/按 key 取代的动作、操作者、时间与原因；未脱敏、未截断且仍是当前版本的记录可点「撤销」，通过 `team.memory.undo` 精确恢复前一版内容（新建则归档条目）。日志最多 10 条、合计 8,000 字符，随 `TeamView.memory.journal` 返回。
- 人类用户可以直接新建或编辑条目（标题、正文、可选 key），也可以接受或驳回成员的提案。接受提案会激活条目；同 key 的已有生效条目会被标记为 `superseded`，驳回则归档提案。
- 所有写入和撤销都携带 `expectedMemoryRevision`（团队记忆版本，不是团队聚合版本）。版本过期时写入返回 `MEMORY_REVISION_CONFLICT`、撤销返回 `MEMORY_UNDO_STALE`，面板提示刷新后重试，不会覆盖并发写入。
- 团队界面只渲染 `scope=team` 且 `visibility=team-safe` 的条目。助手私有记忆、`scope=assistant` 条目以及旧版 `content` 永远不会出现在团队面板中。
- 没有自动捕获或写入提示；团队记忆仍主要由成员工具和 Leader 写入。模型侧的 `team_memory_list` 是只读召回，可用 `query` / `status` / `limit` 过滤，不能写或接受。

## 成员工具策略（部署配置）

成员默认拥有完整工具面。部署方可以在插件配置中声明命名策略，创建/添加成员时用 `toolPolicy` 选择其中一个，从部署侧收窄成员可用的工具；模型无法定义或放宽策略。

```yaml
toolPolicies:
  readonly-member:
    description: 只读协作者
    allow: [team_members, team_read_messages, team_mode_task_list]
```

规则：

- 配置结构为 `toolPolicies: { [id]: { description?: string, allow: string[] } }`；成员槽位新增可选 `toolPolicy` 字段（仅策略 id），入口为 `team.createDraft` 的 `members[]` 与 `team.addMember`。schema 为 strict，直接传 `allow`/`deny` 列表会被拒绝，`team_spawn_agent` 也没有策略参数。
- 有效工具面 = 成员基线 ∩ `allow`：策略只能移除工具，不能授予基线之外的工具；`allow` 中无法识别的名称被忽略。`allow: []` 表示关闭该成员的全部团队工具。
- 未指定 `toolPolicy` 的成员保持完整基线，行为与之前一致；旧团队/旧成员没有该字段，照常加载（无 schema 版本升级）。
- 未知策略 id（创建/添加时）以 `TOOL_POLICY_INVALID` 明确拒绝。已持久化的成员若引用的策略在部署配置中缺失，成员激活时同样失败关闭，不会静默回退到完整基线。
- Leader 不受任何策略影响：即使此前以成员身份保存了 `toolPolicy`，成为 Leader 后仍使用完整工具面；Leader 变更会重建所有 Session，普通成员按新角色重新计算工具面。
- 过滤发生在成员注册团队工具时（团队工具属于成员自己的作用域，`tools.restrict` 无法移除）；继承的 Host、Preset 与 MCP 工具在 MCP/Skill 校验之后用 `tools.restrict({allow})` 收窄。成员提示词中的工具清单按实际注册结果生成。
- 策略只在创建/添加成员时写入，本版没有运行时修改入口。修改部署配置后需要重载插件或重新连接团队，下一次成员激活才生效。

## 移出成员

可以从成员卡片、顶部标签悬停操作或团队管理窗口移出普通成员。操作前会出现自定义警示弹窗。

确认后：

- 停止该成员正在运行的任务。
- 归档并解除当前 Session。
- 从团队活动成员中移除。
- 通知 Leader 该成员已移出，并附带成员 ID。
- Workspace 文件和该成员已经完成的产出保持不变。

Leader 不能直接移出。应先把 Leader 角色转交给其他成员。

## 更换 Leader

更换 Leader 不再是单纯交换角色：它是一道**团队纪元（epoch）**边界。点击普通成员卡片上的 **设为 Leader** 会先出现确认弹窗；确认后：

- 原 Leader 与所有成员的 Session 都会停止、落盘、释放并从 Workspace 解绑；它们被归档为历史（聊天记录保留），但不再属于团队，也不会被重新挂到新 Leader 名下（没有 Session 重挂）。
- 每位成员（包括新 Leader）都会换用全新的 Session；只有新 Leader 会立即启动，其他成员在后台预热。
- 进行中（`assigned` / `running` / `blocked`）的任务变为 `blocked`，同时清除负责人和 `attempt_id`：旧尝试失效，旧成员无法继续写入；需要由新 Leader 重新派发（一次 `team_mode_task_update` 会生成新的 `attempt_id`）。
- 进行中的 Goal 变为 `paused`，由新 Leader 用 `team_mode_goal_update {status:"active"}` 恢复；已完成/已取消的 Goal 不变。
- 排队中的团队消息被标记为失败；新 Leader 会收到一条交接通知（包含纪元和被阻塞任务/暂停 Goal 的数量，不含 Session ID）。
- 团队 `epoch` 加 1；界面在团队卡片上显示 `纪元 N`（只有 N > 1 时显示）。确认成功后界面会自动切到新 Leader 的会话。
- 草稿团队没有启动过任何 Session，因此只递增纪元、交换角色，不归档、不换 Session。
- 团队始终只有一个 Leader。

旧纪元的 Session 仍是只读历史：任何残留的团队工具调用都会以 `EPOCH_STALE` 被拒绝，而不是写入新纪元。如果新 Leader 启动失败，团队进入 `error` 状态，但纪元、Session 轮换与任务暂停不会回滚；重启或重试会从 `error` 继续恢复。

## 重命名团队

点击团队卡片标题旁的 **重命名**，输入新名称并保存。只修改团队显示名，成员、Session、任务板与 Workspace 都不变。

## 交接 Leader 新会话

当 Leader 的上下文太长、想换一段干净会话继续，但**团队、任务、Goal 都不该重来时**使用。这是显式的用户动作，不会自动发生，也不会换 Leader、不会开启新 epoch。

入口：团队卡片里 Leader 那一行的「交接新会话」。

流程：

1. 填一段可选交接说明（最多 4,000 字，超限拒绝而不是截断）。
2. 点「生成检查点」。检查点只包含确定性事实：最近 12 条可见 user/assistant 消息（每条 ≤500 字）、最多 20 条进行中任务（含 pending）、最多 10 条 active Goal、最多 8 条成员邮件（每条 ≤300 字）、工作区路径与你填的说明。团队邮件单独成节，**不会被当成“用户说过的话”**；不调用模型生成总结，也不复用工具输出或推理内容。
3. 在列表里点「交接新会话」，再点一次「确认交接」（两次点击才会执行）。

交接后会：

- 给当前 Leader 换一段全新 Team Session，Leader 槽位与成员列表不变。
- 旧 Session 只退役、不删除：它进入 `retiredSessions` 墓碑与 `retiredLeaderSessionIds`，并从原生侧栏隐藏；日志仍由 Harness 持久化保留。
- 团队 id、epoch、Leader、其余成员与其 Session、任务（含 `attemptId` 与 owner）、Goal、团队记忆、文件租约、outbox 与成员顺序**逐字段不变**。
- 新 Session 的第一个 turn 就是那份检查点事实，排队邮件会排在它后面投递。
- 旧 Session 从此只读：它发起的写入会被 `SESSION_RETIRED` 拒绝。取消/超时的旧写入不会被静默落到新会话。
- 交接写入带聚合 revision 做 CAS，双击或并发只有一次成功（`TEAM_REVISION_CONFLICT`）。

失败与恢复：如果新 Session 装载失败，成员标记为 `error`，检查点保持 `ready` 可重试；聚合已指向新 Session（先退役后激活），用「重连」继续该 Session，或直接再交接一次。旧 Session 永远不会被重新挂上。

## 阈值检查点（默认关闭）

团队可以按上下文压力**自动备份** Leader 会话，但绝不自动交接。默认关闭；由部署侧两个配置开启：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `teamCheckpointThresholdRatio` | `0`（关） | Leader 会话最近一次观测到的上下文占用 ≥ 该比例（0–1）时，生成一次阈值检查点 |
| `teamCheckpointMinIntervalMs` | `1_800_000`（30 分钟） | 同一 Leader 段两次阈值检查点的最小间隔（60 秒–24 小时） |

行为：

- 复用既有的 30 秒 tick，不新增定时器；只有 `state=active` 且未归档的团队参与。
- 判定是纯函数：比例 > 0 → Leader 有已知 context window → `usedTokens / contextWindow ≥ ratio` → 距上次阈值检查点已超过最小间隔。任一不满足就不生成。
- Leader 的 turn 正在跑时跳过（半轮用量既不是最终成本，窗口也不稳定），下一个 tick 再判。
- 记录写入独立的检查点表，`origin: 'threshold'`，只带有界事实（近 12 条消息 × ≤500 字、进行中任务 ≤20、active Goal ≤10、成员邮件 ≤8 × ≤300 字），不含用户手写说明。
- **同一 (团队, Leader 段) 只有一个阈值检查点**：第二次捕获原地替换 facts / `capturedThroughSeq` / 时间，不追加历史。手动生成的检查点不受影响。
- 只备份：不调用模型、不写 Session、不写团队聚合、不换 Leader、不加 epoch、不发起交接。唯一状态是那条记录本身。
- 阈值检查点不会被任何路径自动消费；用户点「交接新会话」时可以选中它，与手动检查点等价。

## 清空任务与上下文

当上下文过长、任务需要完全重新开始，或团队状态混乱时使用。

确认后会：

- 停止所有成员。
- 清空团队任务、待处理消息和文件租约状态。
- 为每个保留成员创建全新 Session。
- 保留成员列表、Leader、助手快照和运行配置。
- 保留 Workspace 及其中的全部文件。

这不是“撤销文件修改”，也不会回滚 Git 变更。需要回滚文件时，请使用 Git 或其他版本管理工具。

单个成员的上下文可以在工作台成员菜单中单独清空。Leader 不提供“清空上下文”（那会把 Leader 变成一个陌生的新会话），而是提供**交接**：见下一节。

## 解散团队

解散是不可恢复的团队领域删除操作，确认弹窗不要求输入团队名称。

| 会删除 | 会保留 |
| --- | --- |
| 团队配置 | 助手模板 |
| 团队任务 | Workspace 文件 |
| 团队消息和活动记录 | Provider、模型、Skills 和 MCP 配置 |
| 插件对旧 Session 的恢复关系 | Harness 底层可能保留的 Session 日志 |

解散后，该团队会从左侧列表消失，助手仍可用于创建其他团队。

## 为什么没有暂停团队

团队本身是成员和协作关系，不是一个持续运行的单进程。成员空闲时不会执行任务，因此“暂停团队”没有明确价值。

需要停止时可以：

- 停止某个成员当前输出。
- 清空全部任务与上下文。
- 移出不再需要的成员。
- 解散整个团队。
