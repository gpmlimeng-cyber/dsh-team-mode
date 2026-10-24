# Context Steward: Team Handoff + Threshold Checkpoint — Audit and Contract

> 2026-10-24 · 架构级审计与契约 · 上游：`docs/superpowers/plans/2026-10-24-context-steward.md`
> 范围：Task 1（审计 + 契约 + 测试清单）。本文件不改代码。
> 依据：`docs/COMPETITIVE-GAPS.md` R1、`docs/HANDOFF.md` Context Steward、`docs/superpowers/specs/2026-10-23-context-checkpoint-handoff-design.md`（已落地的 Assistant DM 版）。

## Status

审计完成。已确认：Assistant 手动 checkpoint/handoff 已落地；Team 侧只有「成员清空上下文」（Leader 被显式拒绝），没有 Leader 段切换；无阈值触发。下面给出可执行的 Team 交接契约与阈值契约，两者都不引入压缩后端、不自动换 Leader、不 bump epoch。

## 1. 现有接缝（audit）

| 接缝 | 位置 | 现状 | 可复用 / 缺口 |
|---|---|---|---|
| 确定性事实构建 | `src/runtime/checkpoint-facts.ts:47` `buildCheckpointFacts` | 取 `projectConversation` 尾部 12 条可见 user/assistant，各 ≤500 字符；`capturedThroughSeq = throughSeq`；无模型、无工具输出 | 尾部抽取逻辑可直接复用；**缺 Team 变体**（任务是 `TeamTask` 而非 `AssistantSession`，且需要 Goals） |
| 交接上下文消息 | `src/runtime/checkpoint-facts.ts:81` `checkpointHandoffMessage` | `createUserMessage` + `source: { kind: 'runtime-context', form: 'instructions' }` | 完全复用。该 source 在 `conversation-projector.ts:84` 被判为不可见节点，所以**不会进入下一份 checkpoint 的事实**，不会自我累积 |
| checkpoint 持久化 | `src/domain/schemas.ts:265` `contextCheckpointSchema`、`src/storage/domain.ts:64` `context_checkpoints`、`src/storage/store.ts:21-27` | 独立表，永不并入 `assistant_memory`；`status: ready/consumed/archived` | 表/访问器模式直接复制为 `team_checkpoints`；`assistantId` 字段**不可复用**：team 成员存的是模板 `assistantId` + 可选 `assistantInstanceId`，混用会打乱 `listContextCheckpoints(assistantId)` |
| Assistant 交接生命周期 | `src/runtime/assistant-runtime.ts:402` `handoff` | 校验 ready/未归档/无活跃任务/宿主所有权 → `agents.create` → `followup(checkpoint)` → 单次 `advanceAssistantMainSession` → 退役旧 handle → `consumeContextCheckpoint` | 顺序语义可照搬；Team 侧没有等价的「先生成 Agent 再落绑定」入口（见 §3.6 失败语义） |
| Team Session 所有权 | `src/domain/schemas.ts:293` `teamMemberSlotSchema.sessionId`、`src/runtime/team-runtime.ts:83` `owned`、`:84` `activating` | 成员 Session = `members[slot].sessionId`；运行时 `owned<Map<sessionId, …>>` 是唯一写入权凭据；`retiredSessions` 记录已退役 Session（epoch 换代、移除成员、成员清空上下文） | **这是 Team Session**。交接 = 只换 Leader 这一个 slot 的 `sessionId`，其余 slot 与 epoch 不动 |
| 成员换段（最接近的既有实现） | `src/runtime/team-runtime.ts:237` `clearMemberContext` | 取消→idle→flush→删 owned→forget interaction→dispose→detach workspace→单次 `updateRuntimeTeam`（换 sessionId + `retiredSessions` 墓碑）→`ensureMemberOnline` 重建 | 交接应以此为骨架；**服务层在 `dsh-team-mode-service.ts:2485` 显式以 `MEMBER_IS_LEADER` 拒绝 Leader**，这就是缺口 |
| Epoch / 写栅栏 | `src/domain/types.ts:163` `epochOf`、`src/runtime/team-runtime.ts:1746` `assertToolIdentity`（第 1 层）、`:1415` `epochAtStart` → 命令闭包 → `src/service/dsh-team-mode-service.ts:3613` `requireEpoch`（第 2 层）、`:736` `changeLeaderEpoch` 是唯一 epoch 写入点 | 语料：Leader 换代 → 全成员 Session 退役、任务 blocked、Goal paused、epoch+1。**epoch 栅栏拦不住「不 bump epoch」的交接**（见 §3.5） | 第 1 层仍有效（旧 handle 已 dispose 且移出 `owned`）；第 2 层需要补 Session 维度 |
| Goals / Tasks / memory / leases / outbox | `src/domain/schemas.ts:483` `teamAggregateSchema`（`goals` ≤ `:502`、`memory` `:504`、`tasks` `:500`、`leases/outbox` `:505-506`、`memberOrder` `:511`、`epoch` `:518`） | 全部挂在同一个 aggregate 上，`updateRuntimeTeam` 一次写入即原子 | 交接只需「一次写入 + 不触碰这些字段」，无需迁移 |
| 阈值信号 | `src/runtime/conversation-projector.ts:35` `projectContextUsage` → `usedTokens` / `contextWindow` | 已有每次会话的 token 用量与窗口；`MemberConversationView.contextUsage` 已上屏 | 直接作为阈值输入；**缺**「配置项 + 触发点 + 去重窗口」 |
| 触发宿主 | `src/runtime/team-runtime.ts:1104` `armReminderTick` / `:1112` `sweepTaskReminders`（30s single-flight，已有 `teamRoutineIdleMs` 的 opt-in 先例） | 每 tick 遍历 active 团队跑提醒 + routine | 阈值 checkpoint 挂在这里，与 routine 同级 opt-in，不新增定时器 |
| 配置风格 | `src/config.ts:41-53`（`teamRoutineIdleMs`、`memoryAutoCapture` 等扁平 optional + default） | 缺省关闭的数值/布尔门 | 阈值同样扁平 optional，`0` = 关 |
| 客户端行隐藏 | `src/client/session-rows.ts:22` `hiddenSessionIds` | 只 union `team.members[].sessionId`、`assistant.mainSessionId + retiredMainSessionIds`、task worker | 换段后旧 Leader Session 会**重新出现在原生侧栏**；需要与 assistant 同款的 `retiredLeaderSessionIds`（§3.2） |
| 传输层 | `src/transport/contracts.ts:499` `team.member.contextReset`、`src/transport/web.ts:23` `expectedRevision`、`src/client/api.ts:19` | 每个路由自动带 `expectedRevision`（If-Match 语义） | 新路由沿用同一 `options`，双击/并发天然由 revision 拦下 |

### 1.1 审计结论（必须知道的三个事实）

1. **Team 侧没有「段」概念的对象**：段就是 `members[slotId].sessionId`。交接不能新建表结构去描述段，只能换这一个 id，并把旧 id 记进墓碑。
2. **epoch 与 Team Session 是两件事**：epoch 表达「谁是 Leader」，交接表达「Leader 换了一段简历」。把交接做成 epoch bump 会顺手把任务 block、Goal pause、全员 Session 退役——那正是计划全局约束禁止的。
3. **Assistant 的 facts 直接拿来用会串味**：`buildCheckpointFacts` 调 `projectConversation(events, limit)` **不传 `teamContext`**（`conversation-projector.ts:68` 第 3 参），团队邮件（`plugin-relay`/`team-message` source）因此被当成 `kind:'user'` 节点抄进「用户消息」。对 Leader 而言「最近用户发言」实际是成员汇报。Team 变体必须传 `teamContext`，把邮件分流到独立的有界字段。

## 2. 设计原则

- 交接只改一个字段族：`members[leader].sessionId` + 旧 id 墓碑 + `desiredState/lastRuntimeState`。其余全保留。
- 阈值只产 checkpoint，**永不**触发 handoff，也永不调整 epoch / leader / 任务 / Goal。
- 两个特性都复用 Assistant 已验证的确定性事实与 `runtime-context` 注入方式，不新增模型调用。
- Opt-in 且缺省关闭（`teamCheckpointThresholdRatio = 0`）。
- 旧 Session 只退役、不删除、不 reparent：`retiredSessions` 继续承担墓碑与发信人显示（`conversation-projector.ts:265`、`team-messages.ts:178`）。

## 3. Team Leader 交接契约

### 3.1 数据模型

新增持久化表 `team_checkpoints`（`src/storage/domain.ts`，与 `context_checkpoints` 同构）：

```ts
// src/domain/schemas.ts
export const teamCheckpointFactsSchema = checkpointFactsSchema.extend({
  /** status=active 的 Goal，按 updatedAt 倒序，≤10 */
  activeGoals: z.array(z.object({ id: nonEmpty, title: nonEmpty, status: nonEmpty }).strict()).max(10),
  /** 最近的团队邮件（成员汇报/指令），≤8 条、每条 ≤300 字符 */
  recentTeamMail: z.array(z.object({
    fromName: nonEmpty,
    type: nonEmpty,
    text: z.string().max(300),
  }).strict()).max(8),
})
// zod 4.4.3 的 .extend() 保留 .strict()（已实测）

export const teamCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  id: nonEmpty,
  teamId: nonEmpty,
  /** 采集时的 Leader slot；交接目标恒为当前 Leader，用于拒绝错位。 */
  leaderSlotId: nonEmpty,
  /** 采集时的 epoch；交接时与当前 epoch 不符即 CHECKPOINT_STALE。 */
  epoch: z.int().positive(),
  sourceSessionId: nonEmpty,
  targetSessionId: nonEmpty.optional(),
  title: nonEmpty,
  note: z.string().max(4000),
  /** manual = 用户显式生成；threshold = 30s tick 自动生成（只备份，不交接）。 */
  origin: z.enum(['manual', 'threshold']).default('manual'),
  capturedThroughSeq: z.int(),
  facts: teamCheckpointFactsSchema,
  status: contextCheckpointStatusSchema.default('ready'),
  createdAt: isoDate,
  consumedAt: isoDate.optional(),
}).strict()
```

- `activeTasks` 沿用父 schema 的 `{id,title,status}`，Team 侧把 `task.subject` 映射进 `title`。
- **口径陷阱**：仓库里已有三份「开放任务」集合，且互不相同——`team-runtime.ts:1925`（`assigned|running|blocked`，用于换代退休）、`team-command-handler.ts:411`（`pending|assigned|running|blocked`，提醒/收件箱）、`global-overview-data.ts:68`（同上，侧栏投影）。checkpoint 事实应采用**后两者**的口径（`pending` 也算开放，因为新 Leader 仍需知道它），并在 `checkpoint-facts.ts` 内定义自己的常量 + 注释说明差异，不要复用 `retireOpenTasks` 那份。
- `teamAggregateSchema` 增加 `retiredLeaderSessionIds: z.array(nonEmpty).max(100).optional()`：与 `retiredMainSessionIds` 完全同构，**不 bump schemaVersion**，缺省视为 `[]`。与 `retiredSessions` 并存：后者是既有墓碑（含 epoch 换代/移除成员），前者只列出「交接退役」的 Session，供客户端隐藏。
- 边界：`note` 与 Assistant 版一致，超限**拒绝**而非截断（`CHECKPOINT_NOTE_LIMIT = 4000`）。

### 3.2 保留 / 变更清单（Review Focus 的可测形式）

一次 `updateRuntimeTeam` 写入后，以下必须**逐字段不变**：

`id, name, workspaceId, workspacePath, schemaVersion, leaderSlotId, epoch, state, directMemberChat, pinned, archivedAt, memberOrder, tasks, goals, memory, leases, outbox`，以及 `members` 中**非 Leader** 的每一项（含 `sessionId`、`assistantInstanceId`、`toolPolicy`、`lastError`）。

唯一允许的变化：

- `members[leaderSlotId].sessionId` = 新 `session-<uuid>`
- `members[leaderSlotId].desiredState = 'online'`、`lastRuntimeState = 'starting'`（激活后由状态监听改写）
- `members[leaderSlotId].lastError`：按 `clearMemberContext` 的口径**原样保留**（`changeLeaderEpoch` 会清掉它，因为换代必然重试全部成员；交接只重启一个成员，保留上次错误更利于诊断）。若 reviewer 要求清掉，加 `delete rest.lastError` 即可，属细节
- `retiredSessions[旧 sessionId] = { formerSlotId, sessionId, displayName, removedAt }`（append，不覆盖既有条目）
- `retiredLeaderSessionIds` append 旧 id（去重、`slice(-100)`）
- `revision + 1`、`updatedAt`

`epoch`、`leaderSlotId`、`tasks[].attemptId/owner/status/blockedBy`、`goals[].status/usedTurns`、`memory` 一律不动——这是与 `changeLeaderEpoch`（`:736`）的根本区别。

### 3.3 事实构建

`src/runtime/checkpoint-facts.ts` 增加（同模块，不新建文件）：

```ts
export interface TeamCheckpointFactsInput {
  events: readonly SessionEvent[]
  team: Pick<TeamAggregate, 'leaderSlotId' | 'members' | 'retiredSessions'>
  messages: readonly TeamMessage[]
  tasks: readonly TeamTask[]
  goals: readonly TeamGoal[]
  workspacePath: string
  note: string
}
export function buildTeamCheckpointFacts(input: TeamCheckpointFactsInput): {
  facts: TeamCheckpointFacts
  capturedThroughSeq: number
}
export function teamCheckpointHandoffMessage(checkpoint: TeamCheckpoint): UserMessage
```

- 尾部消息：完全复用现有常量与规整（`MESSAGE_LIMIT=12`、`MESSAGE_TEXT_LIMIT=500`、`\s+` 折叠、去空）。
- **必须** `projectConversation(input.events, 80, { team: input.team, messages: input.messages })`，使团队邮件投影成 `team-message` 节点（`conversation-projector.ts:89`），从而被 `user|assistant` 过滤排除；邮件单独取 `recentTeamMail`（sender 显示名 + `type` + ≤300 字符）。
- checkpoint 标题沿用 `检查点 <ISO>`；注入文案沿用 Assistant 版结构（标题 / 「确定性提取，非模型总结」/ 用户说明 / 工作区 / 最近消息 / 进行中任务），追加「进行中的 Goal」与「最近团队邮件」两节。
- 消息 `source` 必须是 `{ kind: 'runtime-context', form: 'instructions' }`：不可见（不进 UI 气泡、不进下一份事实），但对模型可见。

### 3.4 API / 服务 / 运行时

```text
TeamRuntime.handoffLeader(teamId, checkpointId, options: { expectedRevision?: number })
  -> { team: TeamAggregate; checkpoint: TeamCheckpoint; sessionId: string }

AgentTeamService
  createTeamLeaderCheckpoint(teamId, note?)          // 读活 handle 或 durable log，落 ready/manual
  listTeamCheckpoints(teamId)                        // 新→旧
  getTeamCheckpoint(id)                              // 未知 -> CHECKPOINT_NOT_FOUND
  createTeamCheckpoint(input)                        // runtime-only 钩子（阈值路径复用）
  consumeTeamCheckpoint(id, targetSessionId)         // 仅 ready -> consumed
  handoffTeamLeader(teamId, checkpointId, options)    // 校验 slot 是 Leader + assertRevision + 委派 runtime
```

传输路由（`AGENT_TEAM_METHODS` + contracts + web dispatch，均自动携带 `expectedRevision`）：

```ts
'team.checkpoint.create'  { payload: { teamId, note?: string }; result: TeamCheckpoint }
'team.checkpoint.list'    { payload: { teamId: string };          result: TeamCheckpoint[] }
'team.checkpoint.handoff' { payload: { teamId, checkpointId };    result: { team: TeamView; checkpoint: TeamCheckpoint; sessionId: string } }
```

UI（`src/client/teams/TeamPanel.tsx`）：Leader 行的操作组新增「交接新会话」，打开一个复用 `assistant-checkpoint-dialog` 形态的对话框（备注 textarea `maxLength=4000` → 生成检查点 → 列表显示 `ready` 项 → 二次确认「交接新会话」→ 成功后 `openSession(sessionId)` 并 `onChanged()`）。客户端 helper（`checkpointNoteError` / `checkpointHandoffLabel`）已存在于 `src/client/assistant-checkpoint.ts`，直接复用，不复制。

**v1 不新增模型可见的 team 工具**（`team_mode_handoff`）：Leader 在自己的 turn 里交接自己会把当前 turn 悬空，且给模型一个「退役自身 Session」的循环诱因。交接是用户动作，走 UI 路由。若后续要工具化，必须在 `registerTeamTools` 里只对旧会话做「发起」而不能自我执行。

### 3.5 写栅栏（Review Focus：旧 Session 不得再写）

现状两层：

1. `assertToolIdentity`（`team-runtime.ts:1746`）：查 `owned`/`activating` 的 `{teamId, slotId, sessionId, epoch}`。交接后旧 handle 已 dispose 且移出 `owned`，旧 Session 任何工具调用 → `INVALID_REQUEST`。**有效**。
2. `expectedEpoch`（命令闭包 `epochAtStart` → `requireEpoch`）：交接不 bump epoch，**失效**。残留窗口：一个已通过第 1 层校验、正在 await 的工具调用，可以在交接写入之后提交聚合写入（迟到写入落到新段）。

补第 2 层的 Session 维度（一处 helper，全成员写入受益）：

```ts
// service
options: {
  expectedEpoch?: number
  expectedRevision?: number
  /** 调用方所属成员的 Session；与 team.members[slotId].sessionId 不符即拒绝 */
  expectedMemberSession?: { slotId: string; sessionId: string }
}
```

- `updateRuntimeTeam`（`dsh-team-mode-service.ts:2755`）与 `putRuntimeMessage`（`:2782`）在 updater 内先 `requireEpoch`、再 `assertRevision('team', current.revision, options.expectedRevision)`、再 `requireMemberSession`，失败抛新错误码 `SESSION_RETIRED`（`src/domain/errors.ts`）：`该 Session 已被交接退役，只读；请在新 Session 中继续。`
- 运行时把 `epochOption(epoch)`（`team-command-handler.ts:2012`）改为 `fenceOption(epoch, slotId, sessionId)`；闭包里已有 `member.id` / `member.sessionId`（`team-runtime.ts:1496-1513`）。
- 由运行时自身发起的写入（`remindDueTasks`、`runDueRoutine`、epoch 换代、交接本身）不传 `expectedMemberSession`，行为不变。
- 交接自身的写入传 `expectedRevision`，从而在聚合层做成 CAS：双击/并发交接只可能有一次成功（`TEAM_REVISION_CONFLICT`）。这比依赖进程内 `exclusive` 锁更强（锁只在单进程内有效）。

顺带修掉的既有同类窗口：`contextResetMember` / `clearMemberContext` 现在也有「已在飞行的写入落到新段」的问题，加上同一把 Session 栅栏即一并关闭。

### 3.6 执行顺序与失败语义

`handoffLeader` 在 `exclusive(teamId)` 内：

1. 读 team/checkpoint；校验 `state ∈ {active, error}`、`checkpoint.teamId === teamId`、`status === 'ready'`（否则 `CHECKPOINT_NOT_READY`）、`checkpoint.epoch === epochOf(team)` 且 `checkpoint.sourceSessionId === members[leader].sessionId`（否则新码 `CHECKPOINT_STALE`）。
2. 旧 Leader 有活跃 turn → 直接 `MEMBER_BUSY` 拒绝（与 Assistant 交接同口径：先等它跑完）。**再做**取消/flush/detach 三步，避免用户以为正在跑的 turn 会被保留。
3. 旧 handle 存在但 `owned` 里没有（另一生命周期持有）→ `AGENT_HANDLE_OWNERSHIP_CONFLICT`（同 `clearMemberContext:247`）。未被任何生命周期持有（重启后未激活）则跳过取消，直接进入 4。
4. 单次 `updateRuntimeTeam`：§3.2 的写入集合，携带 `expectedRevision` + `expectedMemberSession: { slotId: leader, sessionId: oldSessionId }`。
5. `ensureMemberOnline(fresh, freshLeader, false, { seed: teamCheckpointHandoffMessage(checkpoint) })` —— `seed` 是新增可选参数，在该成员的 `setup` 内挂载完 prompt 之后 `agent.followup(seed)`，保证交接事实是**新段的第一个 turn**，不被排队邮件插到前面；`attachSession` 已在 `ensureMemberOnline` 内完成（`:1669`）。
6. `consumeTeamCheckpoint(checkpoint.id, newSessionId)`。
7. 6/7 失败：成员标 `lastRuntimeState='error'`（同 `clearMemberContext:303`），checkpoint 保持 `ready`，抛原错误。旧 Session 已在步骤 4 写进 `retiredSessions` + `retiredLeaderSessionIds`，**永不删除**；恢复路径 = `team.member.reconnect`（续用已落盘的新 Session）或再交接一次。

即「先退役、后激活」（与 `clearMemberContext` 一致），不是 Assistant 的「先建 Agent、后落绑定」。理由：Team 的 Agent 创建入口 `ensureMemberOnline` 从聚合读 `sessionId`，要「先建后落」必须把约 300 行的 setup 从该方法里抽出来（`team-runtime.ts:1398`–`:1726`，含 preset mount / prompt section / 工具注册 / model selection），diff 与回归面都大得多；而 Team 侧的失败不会丢数据（旧段已墓碑，新段可 reconnect/恢复）。**这是本契约唯一需要 captain 签字取舍的点**（见 §6-D1）。

### 3.7 并发与队列

- 排队邮件按**收件 slot** 解析目标 Session（`TeamTurnCoordinator` 在投递时读 `members[slot].sessionId`），所以交接后仍会投给新段，不丢信。契约要测：交接后 `queued` 消息在下次 `releaseSession` 投到新 Session。
- 不调用 `retireQueuedMessages`（那是 epoch 换代的全队清空语义）。
- 交接不写 `warmup`、不改 `state`：团队保持 `active`，避免前端进入「重启中」投影。

## 4. 阈值 checkpoint 契约（opt-in，只备份不交接）

### 4.1 配置（缺省全关，风格对齐 `teamRoutineIdleMs`）

```ts
// src/config.ts
/** 0 = 关闭。Leader 段上下文占用 ≥ 该比例时生成一次 checkpoint。只备份，不交接。 */
teamCheckpointThresholdRatio?: number   // 0..1, default 0
/** 同一 Leader 段两次阈值 checkpoint 的最小间隔，默认 30 分钟。 */
teamCheckpointMinIntervalMs?: number    // 60s..24h, default 1_800_000
```

### 4.2 信号与判定

纯函数（同 `checkpoint-facts.ts`，可单独测）：

```ts
export interface ThresholdCheckpointInput {
  usage: { usedTokens: number; contextWindow?: number } | undefined
  ratio: number
  minIntervalMs: number
  /** 同 team + 同 sourceSessionId 里最新的 origin='threshold' checkpoint 的 createdAt */
  lastThresholdAt?: string
  now: string
}
export function thresholdCheckpointDue(input: ThresholdCheckpointInput): boolean
```

判定顺序（任一不满足即 `false`）：`ratio > 0` → `usage?.contextWindow` 存在且 `> 0` → `usedTokens / contextWindow >= ratio` → `lastThresholdAt` 不在 `minIntervalMs` 窗口内。

### 4.3 触发点（复用既有 30s tick，不加定时器）

`sweepTaskReminders`（`team-runtime.ts:1112`）在 `remindDueTasks` 之后、routine 之前：

```ts
if (thresholdRatio > 0) await this.checkpointIfDue(team.id, now)
```

`checkpointIfDue` 的守卫：

1. `team.state === 'active'`（`draft/error/deleting` 不采）。
2. Leader 的 handle 在 `owned` 内且 `agent.status !== 'running'`（避免采到半轮）；否则跳过（下一 tick 再判）。
3. `projectContextUsage(handle.agent.session.snapshotEvents())`；`thresholdCheckpointDue(...)` 为真才继续。
4. 生成 checkpoint（`origin: 'threshold'`，`note: ''`）。
5. 不做任何会话写入、不发消息、不调用 `agents.create`、不改聚合。

### 4.4 去重与有界

- **窗口**：`minIntervalMs`（缺省 30 min）由「同 team + 同 `sourceSessionId` 的最新 threshold checkpoint `createdAt`」判定，落在表里而不是内存 → 重启不会重复触发。
- **有界**：同一 `(teamId, sourceSessionId)` 最多保留 1 条 `ready` 的 threshold checkpoint，新的一次**原地替换** facts/`capturedThroughSeq`/`createdAt`（旧的一条被覆盖，不留历史）。交接会让 `sourceSessionId` 变化，因此不会无限增长；manual 记录不受影响。
  - 这是刻意的简化：阈值 checkpoint 的唯一用途是「压力来的时候已经有一份够新的快照可以拿去交接」，不需要时间序列。保留时间序列就需要额外保留策略与清理任务，YAGNI。
- **不消费**：没有任何路径自动 consume 阈值 checkpoint；只有 `handoffTeamLeader` 消费它（用户点「交接新会话」时选中的那条）。

### 4.5 红线（Review Focus 的可测形式）

- 阈值路径**不得**调用 `changeLeaderEpoch`、`handoffLeader`、`agents.create`。
- 阈值路径**不得**写 `team.members[*].sessionId`、`epoch`、`retiredSessions`、`retiredLeaderSessionIds`、`tasks`、`goals`。
- 缺省（`teamCheckpointThresholdRatio` 未设 / 0）时，一次 tick 前后 `listTeamCheckpoints` 长度不变。

## 5. 测试清单（每条都要能在不启动真实 Agent 的前提下跑）

| # | 文件 | 用例 | 关键断言 |
|---|---|---|---|
| 1 | `tests/checkpoint-facts.spec.ts`（扩展） | `buildTeamCheckpointFacts` 尾部裁剪 | 12 条、每条 ≤500、空白折叠；tool/notice/reasoning 不出现 |
| 2 | 同上 | 团队邮件不进 `recentMessages` | 传 `teamContext` 后 `recentMessages` 只含真实 user/assistant；邮件进 `recentTeamMail` ≤8、≤300 |
| 3 | 同上 | 任务/Goal 过滤与排序 | 只取 `pending/assigned/running/blocked`，`updatedAt` 倒序，≤20；Goal 只取 `active`，≤10 |
| 4 | 同上 | 空段 | 三组数组均 `[]`，`capturedThroughSeq === -1` |
| 5 | 同上 | 消息来源 | `teamCheckpointHandoffMessage(...).source` 为 `runtime-context`/`instructions`；正文含 note 与「非模型总结」；不含任何 `sessionId` |
| 6 | `tests/agent-team-service.spec.ts`（扩展） | `createTeamLeaderCheckpoint` 校验 | note 修剪、>4000 拒绝、未知 team `TEAM_NOT_FOUND`、落 `ready`/`manual` |
| 7 | 同上 | 交接写入的保留清单 | 新 `sessionId`；`epoch`/`leaderSlotId`/其他成员/`tasks`（含 `attemptId`）/`goals`/`memory`/`leases`/`outbox`/`memberOrder` 逐字段不变；`revision+1` |
| 8 | 同上 | 墓碑与隐藏字段 | `retiredSessions[old]` 存在且 `formerSlotId` 正确；`retiredLeaderSessionIds` 含旧 id、去重、≤100 |
| 9 | 同上 | revision CAS | 旧 `expectedRevision` → `TEAM_REVISION_CONFLICT` 且聚合零变化 |
| 10 | 同上 | 栅栏 | 交接后用 `{ expectedMemberSession: { slotId: leader, sessionId: old } }` 写 `updateRuntimeTeam`/`putRuntimeMessage` → `SESSION_RETIRED`；换新 id 则成功 |
| 11 | 同上 | checkpoint 生命周期 | 未知 id `CHECKPOINT_NOT_FOUND`；重复 consume `CHECKPOINT_NOT_READY`；consumed 记录带 `targetSessionId/consumedAt` |
| 12 | 新 `tests/team-handoff-runtime.spec.ts`（复用 `team-turn-runtime.spec.ts:44` 的 `createHarness` + `adopt` 注入 handle，`vi.spyOn(runtime as any, 'ensureMemberOnline')`） | 拒绝矩阵 | `draft` → `TEAM_NOT_ACTIVE`；`status!=='ready'` → `CHECKPOINT_NOT_READY`；`epoch` 不符 → `CHECKPOINT_STALE`；`sourceSessionId` 与当前 Leader 段不符 → `CHECKPOINT_STALE`；Leader 正在跑 → `MEMBER_BUSY`（且 `ensureMemberOnline` 未被调用） |
| 13 | 同上 | 成功路径 | 旧 handle `cancel(keepInbox:false)`+`whenIdle`+`flush`+`dispose` 各一次；workspace `detachSession(old)`；`ensureMemberOnline` 收到新 id；`seed` 为交接消息；checkpoint 变 `consumed` |
| 14 | 同上 | 激活失败 | 成员 `lastRuntimeState==='error'`；checkpoint 仍 `ready`；聚合仍指向新 id；旧 id 在 `retiredSessions` 中（不丢历史）；错误原样抛出 |
| 15 | 同上 | 不换 Leader / 不 bump epoch | `epochOf` 前后相等；`changeLeaderEpoch` 从未被调用 |
| 16 | 同上 | 排队邮件 | 交接后 `releaseSession` 把 `queued` 消息投到新 Session |
| 17 | 新 `tests/context-steward-threshold.spec.ts` | `thresholdCheckpointDue` 真假表 | 0 关闭；无 usage/window；低于阈值；等于/高于；窗口内 false；窗口外 true |
| 18 | 同上 | tick 集成 | ratio=0.8 + 超阈值事件 → 一 tick 恰好 1 条 `origin:'threshold'`；连跑两 tick 仍 1 条；ratio=0 → 0 条 |
| 19 | 同上 | 只备份 | 阈值路径不调用 `agents.create`、`handoffLeader`、`changeLeaderEpoch`；`members`/`epoch` 不变 |
| 20 | `tests/client-session-rows.spec.ts`（扩展） | 旧 Leader 段隐藏 | `hiddenSessionIds` union `retiredLeaderSessionIds`；空串跳过；与 `members` 去重 |
| 21 | 新 `tests/client-team-handoff.spec.ts` | 对话框 helper | `checkpointNoteError` 边界（4001 拒绝）与二次确认标签（复用 `assistant-checkpoint.ts` 即可，不新增文案函数） |
| 22 | 全量 | 门禁 | `npm run check`（architecture guard + typecheck + vitest + build） |

测试基建说明：`ensureMemberOnline` 的 spy 是刻意的——它保证「编排顺序 + 失败语义」被覆盖，而不需要伪造 `agents.create`/`agentCtx.systemPrompt`。真正的 Agent 装配（preset mount、seed 注入、attach）由 `npm run check` + 手工冒烟（真的开一个团队 → 交接 → 确认新段首条是交接消息）兜底。

## 6. 风险与待裁定

| # | 风险 | 级别 | 处理 |
|---|---|---|---|
| R1 | **阈值自动触发会把成员汇报抄进事实**（若按 Assistant 版直接复用，不传 `teamContext`） | 高 | 契约 §3.3 已要求传 `teamContext` + 独立 `recentTeamMail`；测试 #2 守住。不这么做则 Leader 交接会把自己的「用户指令」写成一堆成员汇报 |
| R2 | **不 bump epoch → 第 2 层栅栏失效**，在飞写入可落到新段 | 中 | §3.5 的 `expectedMemberSession`（约 15 行，一处 helper）；同时关闭 `contextResetMember` 的同类窗口。若不接受，必须在契约里显式记「接受在飞窗口」的 `ponytail:` 注释 |
| R3 | **先退役后激活**：激活失败后团队指向一个尚未装载的 Session | 中 | 与 `clearMemberContext` 同语义；`recoverTeams`/`reconnectMember` 是既有恢复路径；checkpoint 保持 `ready` 可重试。替代方案（抽 `ensureMemberOnline` setup 先建后落）diff 大，不推荐 |
| R4 | **旧 Leader 段在原生侧栏重新出现** | 中 | 新增 `retiredLeaderSessionIds` 并 union 进 `hiddenSessionIds`（同 `retiredMainSessionIds` 模式）。另一条更懒的路是直接 union `Object.keys(team.retiredSessions)`，但那会连带隐藏 epoch 换代退役的段，属于本计划外的行为变更 |
| R5 | **checkpoint 与段错位**（生成后换了 Leader 或又清过一次上下文再交接） | 中 | `checkpoint.epoch` + `checkpoint.sourceSessionId` 双校验 → `CHECKPOINT_STALE` |
| R6 | **阈值记录无限增长** | 低 | §4.4 原地替换：每段最多 1 条 threshold 记录；manual 由用户操作产生 |
| R7 | **`exclusive` 锁只在单进程内**，多 Host 下 revision CAS 是唯一保护 | 低 | 交接写入带 `expectedRevision`；多 Host 本身在 `HANDOFF.md` 里是未启动项 |
| R8 | **`runtime-context` 消息对成员不可见**，新 Leader 可能不知道「这是交接」 | 低 | 消息首行显式写明「上下文交接：<title>」，且 `teamCheckpointHandoffMessage` 文案里说明来源；不新增 notice 节点（避免进 UI 与下一份事实） |
| R9 | **重复交接同一 checkpoint** | 低 | `consumeTeamCheckpoint` 只接受 `ready`；UI 二次确认；服务端 `CHECKPOINT_NOT_READY` |

### 待裁定（交给 captain / 计划作者）

- **D1（必答）**：接受 §3.6 的「先退役后激活」失败语义（R3），还是要求「先建 Agent 后落绑定」？后者要抽 `ensureMemberOnline` 的 setup，diff 显著变大。
- **D2**：旧 Leader 段在侧栏是隐藏（`retiredLeaderSessionIds`，推荐）还是保持可浏览（那就删掉该字段与测试 #20）？
- **D3**：v1 是否需要模型可见的 `team_mode_handoff` 工具？本契约建议**不做**（Leader 自我交接会把当前 turn 悬空）。若要做，是 Task 2 的额外增量。

## 7. 对后续任务的落点（Task 2 / Task 3 用）

```text
Task 2（团队交接）
  src/domain/schemas.ts            teamCheckpointSchema / teamCheckpointFactsSchema / retiredLeaderSessionIds
  src/domain/types.ts              TeamCheckpoint / TeamCheckpointFacts 导出
  src/domain/errors.ts             CHECKPOINT_STALE, SESSION_RETIRED
  src/storage/domain.ts            team_checkpoints 表
  src/storage/store.ts             team checkpoint 访问器（并入 AgentTeamCheckpointStore）
  src/runtime/checkpoint-facts.ts  buildTeamCheckpointFacts / teamCheckpointHandoffMessage
  src/runtime/team-runtime.ts      handoffLeader + ensureMemberOnline 的 seed 参数
  src/service/dsh-team-mode-service.ts  create/list/get/consume/handoffTeamLeader；updateRuntimeTeam/putRuntimeMessage 的 Session 栅栏
  src/runtime/team-command-handler.ts   fenceOption(epoch, slotId, sessionId)
  src/transport/contracts.ts + web.ts   team.checkpoint.*
  src/client/session-rows.ts       retiredLeaderSessionIds 并入隐藏集
  src/client/teams/TeamPanel.tsx   交接对话框入口
  src/client/AgentTeam.module.css  对话框样式（复用 assistant-checkpoint 的类名优先）

Task 3（阈值 checkpoint）
  src/config.ts                    teamCheckpointThresholdRatio / teamCheckpointMinIntervalMs
  src/runtime/checkpoint-facts.ts  thresholdCheckpointDue
  src/runtime/team-runtime.ts      sweepTaskReminders 内 checkpointIfDue + 原地替换
  src/service/dsh-team-mode-service.ts  createTeamCheckpoint（runtime-only 钩子，origin='threshold'）
```

不做（明确排除）：压缩后端 / `ctx.compaction` / 段搜索 UI / 自动 handoff / 自动换 Leader / epoch bump / 新 npm 依赖 / 把 checkpoint 并入 `assistant_memory` 或团队 memory。
