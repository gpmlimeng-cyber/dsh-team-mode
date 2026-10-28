# 团队首响基线（P0：链路 + 往返计数 + 12 条基准定义）

> 2026-10-28 · 对应 `docs/superpowers/plans/2026-10-28-team-responsiveness.md` 的 **P0**。
> 这次**不改任何产品行为**：只新增 `scripts/bench-team-first-response.measure.ts`，并把
> `scripts/vitest.measure.config.ts` 的 include 从单文件改成 `scripts/*.measure.ts`。
> `src/` 一行未改；脚本不进 `npm test`、不进 `npm run check`。

## 1. 这次要回答什么

前一份基线（`notes/2026-10-28-responsiveness-baseline.md`）测的是**插件编排开销**，结论是毫秒级。
但它没回答两件 P1 要动手的事：

```text
1 一条用户消息到第一句用户可见输出，中间有哪些必经环节？各自的耗时归属
2 在“团队已建好、成员已存在”的前提下，当前提示词逼 Leader 做多少次
  工具往返 / 人工批准，才能出第一句话？
```

## 2. Leader 首响链路（逐段，带 file:line）

用户已在团队会话里输入并回车。下面是真实代码路径，不是示意：

| # | 段 | 位置 | 实测/常量 | 用户可感知 |
| --- | --- | --- | --- | --- |
| 1 | 乐观回显（pending 节点先画） | `src/client/workbench/ConversationColumn.tsx:241-253` | 0 ms（同帧） | 否（看到的是自己那句话） |
| 2 | `team.message.send` → service → runtime | `src/transport/web.ts:576` → `src/service/dsh-team-mode-service.ts:4384` → `src/runtime/team-runtime.ts:1325` | 未单独采样 | 否 |
| 3 | 消息落库 `putRuntimeMessage` | `src/runtime/team-runtime.ts:1367` | 本机未单独采样（前一份基线他机「落库→投递确认」118 ms，n=6，含交棒与推送） | 否 |
| 4 | 入队 → 交棒 Leader Agent `followup()`（**模型回合从这里开始**） | `src/runtime/team-turn-coordinator.ts:32,147` | **中位 1–3 ms**（真实 `TeamTurnCoordinator`，n=20，两次运行） | 否 |
| 5 | Leader 首 token（TTFT） | `assistant/attempt` 的首个 stream chunk | **本机未测（n=0）**，模型侧 | **是（主要项）** |
| 6 | 服务端会话发布合并窗口 | `src/runtime/team-runtime.ts:200`（`}, 48)`） | 48 ms 固定 | 是 |
| 7 | 客户端变更 reload 合并窗口 | `src/client/components.tsx:19,112` | 120 ms 固定 | 是 |
| 8 | 首条可见节点时间戳（等于 UI 用的 `firstChunkTime`） | `src/runtime/conversation-projector.ts:110` | = 4 + 5 + 6 + 7 | 是 |

结论 1：**插件侧固定成本 ≈170 ms**（1–3 ms 交棒 + 48 ms 发布合并 + 120 ms reload 合并），
从回车到第一句可见输出 = **≈170 ms + TTFT**。所以“2 秒内有可见状态”这个目标在插件侧是够得着的；
剩下的是模型首 token。

结论 2：**8 段里没有一段是“因为团队才有的额外等待”**（除了第 6/7 段的合并窗口，那是为了少 reload，不是计算）。
首响慢不是链路长，而是链路在等模型，而**等待期间界面什么都不显示**——这与前一份基线的结论一致。

## 3. 已建团队上的强制往返（现状 vs 目标）

### 3.1 强制工具往返

| 项 | 证据 | 说明 |
| --- | --- | --- |
| 首轮必须 `team_members` | `src/runtime/team-prompts.ts:27`（`First turn: call team_members to inspect the current roster`） | 一次工具往返 = 一次额外模型请求（tool call 结束 step，结果再开新 step） |
| 同一句要求还写在工具描述里 | `src/runtime/team-tools.ts:280`（`Call this before planning or delegating.`） | 两处一起逼，单改提示词可能不够 |
| 但 roster **本来就在同一回合的提示词里** | `src/runtime/team-runtime.ts:1884-1889`（`rosterSection`，`order: 11`，`text: () => rosterPrompt(...)`） | 每次回合现场生成，含显示名 / role / slotId / status / assistant + 任务数 + Goal 数；实测 999 字符 |
| 字段重叠 | `src/runtime/team-prompts.ts:301-314`（`rosterPrompt`）vs `src/runtime/team-command-handler.ts:559-584`（`members()`） | 工具多给 provider/model/permission/session_id；**回答一个纯问题一样都用不到** |

### 3.2 强制人工往返

`src/runtime/team-prompts.ts:27` 后半句：`propose a roster and a short plan ... Wait for the user to
approve before spawning or assigning work.` 这条要求**不带条件**——即使团队已经建好、成员都已存在、
要做的只是一个直接回答，Leader 仍然要先提名单/计划并停下等批准。

注意：这是**提示词强制**，不是运行时门禁。runtime / dispatcher / coordinator 里没有任何审批门；
审批只出现在两条别的地方——成员侧的待处理交互（`src/runtime/team-command-handler.ts:376-428`，
经 inbox / workbench / escalations 露出），以及工具撞上 DSH 权限门时落成会话日志的 `approval/asked`
（分析脚本按这个计数）。首响路径上两者都不拦人。

### 3.3 按模式的往返账（当前提示词，已建团队）

| 模式 | 强制工具往返 | 强制人工往返 | 出第一句话前的 Leader 回合数 | P1 目标 |
| --- | --- | --- | --- | --- |
| 对话 / direct | 1（`team_members`） | **1（批准 roster/plan）** | 2 | 1 回合、0 工具、0 批准 |
| 单任务 / single | 1 + `goal_create` + `task_create`（owner 即唤醒，无需再发消息，见 `team-prompts.ts:32`） | **1** | 2 | 1 回合、1–2 工具、0 批准 |
| 编排 / multi | 1 + `goal_create` + N×`task_create` | **1** | 2 | 1 回合、(1+N) 工具、0 批准 |

也就是说：**已建团队上，任何模式都要多付「1 次 `team_members` + 1 次人工批准 + 1 个完整 Leader 回合」**，
而其中 `team_members` 的信息在当轮提示词里已经有了。这正是 P1（L1）要删的那一段。

## 4. 基线表

| 指标 | 现状实测 | 样本 | 来源 |
| --- | --- | --- | --- |
| 回车 → 乐观回显 | 0 ms（同帧） | 源码 | `ConversationColumn.tsx:241-253` |
| 入队 → Leader `followup()`（交棒） | 中位 **1–3 ms**（两次运行，最慢同值） | n=20 | `TeamTurnCoordinator` 实测 |
| 服务端发布合并窗口 | 48 ms | 常量 | `team-runtime.ts:200` |
| 客户端 reload 合并窗口 | 120 ms | 常量 | `components.tsx:19` |
| **插件侧首响下限（不含模型）** | **≈170 ms**（169–171） | — | 上三项相加 |
| Leader 首 token（TTFT） | **未测（n=0）** | 0 | 本机没有可解析的真实团队回合日志（见 §6） |
| 强制工具往返 / 首回合 | **1**（`team_members`，信息重复） | 源码 | `team-prompts.ts:27`、`team-tools.ts:280` |
| 强制人工往返 / 首回合 | **1**（roster/plan 批准） | 源码 | `team-prompts.ts:27` |
| Leader 身份段提示词体积 | 6 791 字符（roster 段另 999） | 1 | 脚本 `fixtureTeam()` |

明确不写进基线的东西：前一份基线里的 **72.3 s（任务下派 → 成员 running，n=2，darwin 机器）**
不是本机数据，也不是 TTFT，不能拿来当首响基线；本机磁盘里那 4 个团队是 2026-10-20 的
“验收团队”演示数据（`summary` 里写着「演示」），其 `team.task_updated` 三条时间戳完全相同，
是批量写入而不是真实成员开跑，所以 **n=0 就报 n=0**。

## 5. 12 条固定基准（定义 + 度量口径）

前置条件固定：**已建好的团队 = 1 leader + 2 members，不需要 spawn**，同一 Workspace、同一模型配置。
每条提示单独开一轮新对话（不要连问，避免上下文叠加）。

| id | 类型 | 提示词 | 期望看板产物 | 目标首回合工具数 |
| --- | --- | --- | --- | --- |
| D1 | direct | 这个团队现在有几个人？一句话回答。 | 0 Goal / 0 Task | 0 |
| D2 | direct | 这个仓库跑测试用哪个命令？只要一行。 | 0 / 0 | 0 |
| D3 | direct | 我们上次为什么决定不做并行分派？一句话。 | 0 / 0 | 0 |
| D4 | direct | Translate to English, one line: 先测量，再优化。 | 0 / 0 | 0 |
| S1 | single | 在 README 的 “Build, Test, and Development Commands” 里补一行 `npm run guard:architecture` 的说明。 | 1 / 1 | 1 |
| S2 | single | 给 `tests/team-prompts.spec.ts` 加一个断言：leader 的 prompt 里包含 roster。 | 1 / 1 | 1 |
| S3 | single | 把 `docs/troubleshooting.md` 里那条过期命令改掉，只改那一处。 | 1 / 1 | 1 |
| S4 | single | Run `npm run typecheck` once and tell me the result. No code changes. | 1 / 1 | 1 |
| M1 | multi | 两个成员并行：一个改 leader 首轮规则，一个补对应测试，然后互相复核。 | 1 / 2 | 3 |
| M2 | multi | 一个成员审计 `src/runtime` 各提示词段的体积占比并出报告，另一个成员独立复核这份报告。 | 1 / 2 | 3 |
| M3 | multi | 一个成员实现真实状态行，一个成员写回归测试，第三个成员做独立验收。 | 1 / 3 | 4 |
| M4 | multi | In parallel: one member investigates the 70s silence after dispatch, one audits the client coalescing window, then summarize both. | 1 / 2 | 3 |

每条记这些字段（脚本已实现解析，全部来自 harness 自己写的时间戳，unix epoch ms）：

```text
sentAt              用户消息写入时刻（团队消息表 createdAt）
ttftMs              turn 内首个 assistant stream chunk − sentAt
firstVisibleMs      用户节点之后第一个被投影出来的节点 − sentAt（与 UI 同一份 projectConversation）
firstToolCallMs     首个 tool/call − sentAt
toolCalls           本回合调了哪些 team_* 工具（按序）
toolRoundTrips      本回合 step 数 − 1（每次工具往返 = 一次额外模型请求）
approvals           本回合 approval/asked 数
turnEndMs           turn/end − sentAt
humanGapMs          下一条用户消息 − 本回合 end（= 等人批准的往返，纯人工延迟）
goals / tasks       本回合产生的看板产物（决定 direct/single/multi 是否走对）
```

判读规则（P1 的验收）：

```text
D1–D4  必须 tasks=0、goals=0、toolRoundTrips=0、humanGapMs=null（不出现批准回合）
S1–S4  tasks=1，且第一回合就建任务；不出现 roster 批准回合
M1–M4  tasks=2/2/3/2；多成员唤醒不串行（看第一个成员的 turn/start）
全部    firstVisibleMs − ttftMs 应 ≈ 168 ms（两个合并窗口），不应更大
```

## 6. 怎么跑（唯一入口）

```bash
# 只跑本文件（脚本内含 5 个用例：seam 固定、分析器自检、12 条定义、插件下限、真实采样）
npx vitest run --config scripts/vitest.measure.config.ts scripts/bench-team-first-response.measure.ts

# 两个测量文件一起跑
npx vitest run --config scripts/vitest.measure.config.ts

# 换一份 profile（默认读 ~/.dsh/storages/dsh_team_mode.json + ~/.dsh/sessions）
DSH_TEAM_STORE=/path/to/dsh_team_mode.json DSH_SESSIONS_DIR=/path/to/sessions \
  npx vitest run --config scripts/vitest.measure.config.ts scripts/bench-team-first-response.measure.ts

# 收工门禁（本次不改 src/，仍按规矩跑）
npm run build && npm run check
```

脚本固定了 6 个 seam（`First turn` 规则、`Wait for the user to approve`、工具描述里的
`Call this before planning or delegating.`、roster 段 `order: 11`、48 ms 发布窗口、120 ms reload 窗口）。
**谁改了这几处，这个用例会先红**——那正是要重新读基线的时刻。

本机当前采样结果（如实）：

```text
Recorded samples: none usable on this machine.
  1 recorded user prompt(s) unusable → 9c84d849…: session log holds a header only (turn never persisted)
```

也就是说：12 条基准的**真实跑分还没做**（需要真实模型 + 真实团队各跑 12 轮）。
脚本、口径、判读规则都已就位，跑完直接出表。

## 7. P1 要动的地方（给 T2 的范围提醒）

```text
src/runtime/team-prompts.ts:27   删掉“首轮必须 team_members + 提名单等批准”，改成
                                 “团队已就绪就直接做；只有新建/扩员/改范围才提名单”
src/runtime/team-tools.ts:280    team_members 描述里的 “Call this before planning or delegating.” 同步改
tests/team-runtime-support.spec.ts:59-60  断言了 leader prompt 含 team_members 与 Wait for the user，
                                 改提示词会红；T2 的 inScope 必须包含 tests/（否则契约漏项）
```

另：`src/runtime/team-prompts.ts:26` 要求“先声明所选模式”，这行是**零成本**的（同一回答里先写一句），
建议保留——它让 direct / single / multi 的判读有据可查。

## 8. 没测到的

1. **TTFT 与 12 条真实跑分**：本机没有可解析的真实团队回合日志，需要真实模型跑一遍；
2. 一次含浏览器渲染的端到端（从回车到首帧），本次只到 SSE 合并窗口 + reload 窗口这两个常量；
3. P1 落地后 direct 占比、roster 批准消失率——那正是 12 条基准的 P1 复测目标。
