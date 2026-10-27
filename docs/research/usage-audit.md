# 宿主 usage / 费用 API 核对（只读）

> 2026-10-27 · 对应 `docs/superpowers/plans/2026-10-27-post-memory-alignment.md` §3。
> 结论只回答两件事：DSH 现在能查什么；是否值得做只读用量入口。无代码改动。

## 0. 结论

**部分可用，建议做「只读 token 汇总入口」，不做完整用量页，也不自建计费库。**

| 维度 | 现在能否只读聚合 | 依据 |
|---|---|---|
| 单 Session 总 token（输入三桶 + 输出） | ✅ 可以 | `tokenUsage` projection（宿主已挂载、已持久化） |
| 单 Session 轮数 / 步骤 / 耗时 | ✅ 可以 | `sessionStats` projection |
| 单 Session 上下文压力 / 窗口 | ✅ 可以 | `contextPressure` projection |
| 单 Session 最近使用的 provider/model | ✅ 可以 | `modelSelection` projection（只给 lastUsed/next，不是分账） |
| 按 assistant 聚合 | ✅ 可以（插件侧求和） | 实例记录已含全部 Session id；列表/投影已暴露 |
| 按 team 聚合 | ✅ 可以（插件侧求和） | 成员/线程/retired Session id 都在 TeamAggregate |
| 按时间范围 | ❌ 需要宿主改动或自建 ledger | projection 只有整段总数，没有时间维度 |
| 按 provider/model 拆账 | ❌ 需要事件级折叠或宿主改动 | 只有每次请求的 `request/header` / `request/context` |
| 调用次数（calls） | ❌ 只有 steps 近似 | `sessionStats.steps` 不是尝试数 |
| 费用 / 金额 | ❌ DSH 没有价格/货币字段 | 只有账户钱包余额与外部 usage URL |
| 每轮 lastTurn / lastSpeaker | ❌ projection 没有；需事件或插件数据 | `deriveTurnTokenUsage(events)` 是唯一精确 per-turn 折叠 |

因此：
- **做**：助手/团队维度的 token 汇总（总量、缓存命中率、轮数、上下文占用），每个 Session 一行并可跳转原生会话；不建统计库。
- **不做（关闭）**：MausBot 式 `costUsd`、DS Bot 完整 usage page（时间序列 / 按模型 / calls / 活跃热力图）。这些需要宿主新增用量账本；插件自建会违反「不自建 analytics / 计费库」的非目标。

## 1. 核对范围与证据

已安装 DSH 版本：`0.2.1-rc.2`（`/usr/local/lib/node_modules/@deepseek-ai/dsh`）。
实际挂载（来自 `dsh-base` / `dsh-web-app` 的 `cordis.patch.yml` 与运行日志）：

```text
token-meter                 @deepseek-ai/dsh-token-meter
session-stats               @deepseek-ai/dsh-session-stats
session-projection-cache    @deepseek-ai/dsh-session-projection-cache
session-telemetry-otel      @deepseek-ai/dsh-session-telemetry-otel（FEEDBACK_ONLY，只上报，不可查）
session-query-sqlite        @deepseek-ai/dsh-session-query-sqlite（FTS5，只做全文检索）
```

运行时证据（只读读取本机投影缓存）：

```text
/root/.dsh/storages/session_projcache/sessions/*.json
159 个缓存记录，159 个都含 tokenUsage / sessionStats / contextPressure /
contextBreakdown / modelSelection / sessionListMetadata。
例：tokenUsage = {uncachedInputTokens: 163548, outputTokens: 33965,
                   cacheReadTokens: 7404928, cacheWriteTokens: 0}
插件已知的 25 个 assistant/team Session 中 23 个能在缓存里找到（另 2 个是
dsh-team-mode: 前缀的占位/历史 id）。
```

## 2. 可直接查询的服务与投影

### 2.1 `tokenUsage`（按 Session 的整段 token 汇总）

来源：`@deepseek-ai/dsh-token-meter`，`usage-projection.js`，`stateVersion: 2`。

```ts
// wire 值（strict）
{
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
```

语义：
- 计数来自 provider 的 `assistant/message.usage` 或 `assistant/attempt.stream` 最后一个 `usage` chunk。
- 同一 turn/step 的后续 usage 样本替换先前样本；`llm/retry-started` 结束替换作用域，重试算新尝试。
- 四桶互斥；billed input = `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`。
- 没有 calls、provider、model、时间、费用字段。

### 2.2 `sessionStats`（按 Session 的轮数 / 步骤 / 墙钟）

来源：`@deepseek-ai/dsh-session-stats`，`stateVersion: 1`。

```ts
{
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}
```

语义：`step/end` 计步；`assistant/message` 计 LLM 时间、首 token、decode。`decodeTokens` 只是输出侧样本之和，不是完整 token 账。**没有 calls**；`steps` 可当近似。

### 2.3 `contextPressure` / `contextBreakdown`

来源：`@deepseek-ai/dsh-token-meter`，`stateVersion: 5 / 6`。

```ts
// contextPressure wire（字段都可选）
{ pressureTokens?: number, projectedTokens?: number, contextWindow?: number }

// contextBreakdown wire
{ systemTokens: number, toolsTokens: number, messageTokens: number }
```

`contextPressure.pressureTokens` 是最新一次 provider 报告的 prompt 侧大小；`projectedTokens` 加上了之后的 surface 增量；`contextWindow` 来自最新 `request/context`。这是「当前占用」，不是历史累计。

### 2.4 `modelSelection`（最近路由）

来源：`@deepseek-ai/dsh-api-session-controller`，`stateVersion: 2`。

```ts
{
  lastUsed: { provider: string, model: string, reasoningEffort?: string } | null
  next:     { provider: string, model: string, reasoningEffort?: string } | null
}
```

只说明该 Session **最近/下一次**用哪个模型；不是「每个模型花了多少 token」。若一个 Session 中途换过模型，`tokenUsage` 总量无法按模型拆分。

### 2.5 服务面

| 面 | 位置 | 可读内容 | 限制 |
|---|---|---|---|
| `ctx.sessionProjections.snapshot(session, keys?)` | 宿主 | 一个 Session 的全套 wire 投影 | 需要 live `Session` 对象；同步 |
| `ctx.sessionProjections.stateOf(session, key)` | 宿主 | 某个 unit 的持久状态 | 宿主内部用 |
| `ctx.sessionProjections.cachedSnapshot(session, keys?)` | 宿主 | 已物化的缓存值 | 可能落后；未物化时缺失 |
| `ctx.sessionProjectionCache.cachedSnapshot(meta, keys?)` | 宿主 | 冷 Session 的持久 checkpoint（零 I/O） | 需要 projection-cache；只含已 checkpoint 的 key |
| `ctx.sessionController.list()` | 宿主 | 每个 Session 的 `projections: {kind:'sequenced'\|'cached', asOfSeq, values}` | 冷行只含缓存值；无 cwd 的冷行不进列表 |
| `ctx.sessionController.projections({sessionId})` | 宿主 RPC | `{kind:'sequenced', asOfSeq, values}` / `null` / `migration-required` | 会 materialize 冷 Session 的投影 |
| `session.projections`（Remote） | 客户端 | 同上，经 `sessions.manager.refreshProjections(id)` | 插件客户端已可调用 |
| `sessions.manager.getListSnapshot()` | 客户端 | `items[].projectionValues` + `projectionsBySession[id].values` | 需要插件已 inject `sessions`（已有） |
| `sessions.list`（snapshot store） | 客户端 | `byId[id].projectionValues` + `projectionsBySession` | 第一方 subagent UI 已用它读 `tokenUsage` |
| `sessions.manager.projectionValues(id)` | 客户端 | 一个 Session 已缓存的全部投影值 | 未加载时 undefined |
| `sessions.manager.refreshProjections(id)` | 客户端 | 触发 RPC 拉取该 Session 投影 | 无返回值内容；读 store 取值 |

`ProjectionValueStore` 的合成规则：sequenced 值按 seq 高者胜；cached 值不覆盖 sequenced；未出现的 key 读 `undefined`。列表行与已打开会话共用同一个 store。

### 2.6 每轮 / 每次调用的原始事件

精确 per-turn 只能折叠事件：

```text
assistant/message   { turn, step, message, stream, usage?: TokenUsage }
assistant/attempt   { turn, step, stream }              // 失败/重试/取消的尝试
llm/retry-started   { retryId, turn, step, retry }
request/header      { header: EpochHeader, reason }     // header.config.provider/model/...
request/context     { provider, model, contextWindow?, systemPromptUpdate? }
session/end-seed    { inherited?: true }                // fork 继承切点，之前的事件不是本 Session 的账
```

`TokenUsage`（`@deepseek-ai/dsh-llm`）：

```ts
{ inputTokens, outputTokens, totalTokens?,
  cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
```

`inputTokens` 是**非缓存输入**；缓存读/写单独列出；`billed input` 是三桶之和。

`@deepseek-ai/dsh-token-meter/client` 导出 `deriveTurnTokenUsage(events)`，返回一轮的精确聚合：

```ts
{
  uncachedInputTokens, outputTokens, totalTokens,
  cacheReadTokens?, cacheWriteTokens?, reasoningTokens?,
  routes?: Array<{ provider, model }>   // 该轮用到的所有路由
}
```

这正是原生聊天里 per-turn usage 面板用的折叠；它不在 projection 里，必须拿到该轮事件。原生 composer 已有每 Session 的 usage/activity pill（`tokenUsage` + `sessionStats`），所以单会话明细不必由本插件重做。

### 2.7 费用

没有。逐包检查结果：

```text
dsh-llm:              resolveModelInfo() 返回 provider/id/name/description/
                      inputModalities/context.contextWindow/defaultMaxTokens/
                      systemPromptUpdate/toolUpdate/reasoning；没有价格。
dsh-token-meter:      imageRequestPricing() 只给图片的 visualTokens（token 数），不是钱。
dsh-deepseek-account-platform / dsh-api-account-controller:
                      getBalance() 返回钱包余额 [{currency, balance}] 与 bonusWallets；
                      account/status 只给 usageUrl / topUpUrl 外链。
dsh-session-telemetry: 只把原始事件上报给 OTel，不可查询。
全仓 grep costUsd / totalCost / billing / invoice：无实现字段。
```

MausBot 的 `costUsd` 来自它自己的 engine billing（`snapshot.billing`），不是 DSH；DeepSeek 的 usage 只能跳转平台页面，不能在插件里按助手/团队算钱。

### 2.8 时间 / provider / calls

- 投影没有时间维度；`tokenUsage` 不带时间，`sessionStats` 只有耗时合计，没有每条调用的 timestamp。
- provider/model 只有每次请求的 `request/header` / `request/context`，以及 `modelSelection` 的最近路由。
- calls 没有聚合；DS Bot 是在自己的 ledger 里按 usage 样本数算的。

DS Bot 的处理方式（先例，不是本插件要复制的代码）：
`src/host/usage.js` 用 `ctx.sessionController.list()` + `page()` 扫描每个 Session 的
`request/header` / `request/context` / `assistant/message` / `assistant/attempt`，
按 15 分钟桶、session、owner、model、kind 写 `usage.sqlite`；`usage-page.js` 再从
该表按小时/天/周/月聚合。这是「宿主已有原始事件，但没有跨 Session 用量查询」的实证。

## 3. 助手 / 团队映射

插件自己的数据已经给出全部 Session id：

```text
AssistantInstance:
  mainSessionId
  retiredMainSessionIds[]
  threadSessionIds[]
  retiredThreadSessionIds[]
AssistantSession（隐藏任务 worker）:
  sessionId
TeamAggregate:
  members[*].sessionId
  retiredSessions[*].sessionId
  threads[*].sessionId
  retiredThreads[*].sessionId
  retiredLeaderSessionIds[]
```

因此「按 assistant / team 聚合」= 对这些 id 取 `projectionValues(id)` 后逐项相加；不需要宿主聚合 API。DS Bot 的群/单聊用量也是同一做法：

```js
// DS Bot src/client/text.js
const usage = list.projectionsBySession?.[id]?.values?.tokenUsage
input = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
cacheRead = cacheReadTokens
output = outputTokens
```

需要注意的口径：
- coordinator（Chief）与所属团队/助手可能共享 Session，聚合时按 scope 去重，别重复计。
- retired Session 是否计入「历史总量」需要产品决定；不列出来会少算，列出来要标注 retired。
- 任务 worker Session（`assistant_sessions`）和 team thread 都属于对应 assistant/team。
- subagent 子 Session 不在插件记录里；如要包含，读 `subagentCatalog` 投影再递归，当前建议不计，标注「不含子 Agent」。
- DSH session list 只收录有 cwd 的冷 Session；不在列表里的 id 可对 `sessions.manager.refreshProjections(id)` 单独取投影。
- `migration-required` 的 Session 可能只有 cached hints；缺失就显示「—」，不要显示 0。

## 4. 功能要求（只作需求，不作实现）

### 4.1 MausBot `GroupUsageChip`

源码：`/root/openmausbot/src/components/GroupUsageChip.tsx`、`src/lib/usage.ts`。

```text
输入：GroupThreadUsage | null
隐藏条件：!usage?.turns
短文本：有 costUsd → 格式化金额；否则有 cachedInput → uncached input；
        否则 input
tooltip：total（uncached · cached · output）+ lastTurn（含 lastSpeaker.name）+ cost
数据字段：turns, input, output, cachedInput?, costUsd?,
          lastTurn{input,output,cachedInput?}, lastSpeaker{name}, context{tokens,window}
```

对应到 DSH 可提供的字段：

| MausBot 字段 | DSH 来源 | 可得 |
|---|---|---|
| turns | `sessionStats.turns` | ✅ |
| input | `uncachedInputTokens + cacheReadTokens + cacheWriteTokens` | ✅ |
| cachedInput | `cacheReadTokens` | ✅（cacheWrite 单列） |
| output | `outputTokens` | ✅ |
| context | `contextPressure.pressureTokens/projectedTokens/contextWindow` | ✅ |
| costUsd | 无 | ❌ |
| lastTurn | 事件折叠 / 原生 turn usage | 需事件，不是投影 |
| lastSpeaker | 插件 team messages | 团队场景可从消息记录取，助手场景不统一 |

结论：可以做「token 版 chip」= `{tokens} tok · Cache hit {hit}%`（DS Bot 的 details drawer 文案），不要做金额；lastTurn 需要额外事件读取，建议 v1 不做。

### 4.2 DS Bot usage page

源码：`/root/DSBot/ds-bot/src/client/usage-page.js`、`usage-data.js`、`src/host/usage.js`。

```text
时间范围：24h / 7d / 30d / 12w / 12m / 自定义两日
粒度：hour / day / week / month（按范围自动选）
指标：total tokens、cache hit rate、output、calls、与前一区间比较
图表：按小时/天/周/月堆叠；stack 可按 Bot 或 model；top 7 + 其余
列表：按 Bot、group、agent、model、kind 排名与占比
kind：Own chat / Group chats / Compaction and handoff / Image reading /
      Memory / Titles / Other
交互：点 Bot/group/model 进入详情；年月日历选择；活跃度热力图；
      扫描中转圈提示、空状态「No usage yet.」
数据行：[hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls]
```

与 DSH 的差距：

| 需求 | DSH 现状 |
|---|---|
| 时间桶 | ❌ 无 |
| per-call calls | ❌ 无（steps 近似） |
| provider/model 拆分 | ❌ 只有 lastUsed |
| owner/kind 归属 | 插件自己的数据可映射 owner；kind 需扫描时标记 |
| 增量扫描/持久化 | 需要宿主 ledger 或插件 ledger |
| 金额 | ❌ 无 |

## 5. 建议

### 5.1 做：只读 token 汇总入口（推荐）

**范围**：助手 / 团队 / Session 三级，全部来自投影，不写库。

```text
入口：settings.section 的「团队」设置区，或 assistant 详情/团队管理已有的只读页
       （二选一，不要新开导航）
助手行：总 tokens、输入三桶、输出、cache hit%、turns、当前上下文占用
团队行：成员 + 线程 + retired 聚合（按口径配置），点击展开成员行
Session 行：单 Session 明细；点击打开原生会话；原生 composer 已有 per-turn 细节
空/缺失：显示「—」与「该会话尚未生成用量」；不写 0
刷新：跟随 sessions.manager 的列表订阅；冷 Session 用 refreshProjections
```

**不显示**：金额、时间范围、provider/model 分账、calls、lastTurn、lastSpeaker。

**实现依赖（若批准）**：
- 插件已 `inject: ['sessions']`；公开读法是 `sessions.list` 快照
  （`byId[id].projectionValues` / `projectionsBySession`，第一方 subagent UI 即用
  `summary?.projectionValues?.tokenUsage`）；冷/缺失 Session 用
  `sessions.manager.projectionValues(id)` 与 `refreshProjections(id)`。无需宿主改动。
- 可继续用当前的结构化 cast（不新增 peer dependency）；若要类型完整，再加
  `@deepseek-ai/dsh-api-session-controller` peer 依赖。
- 订阅用 `sessions.manager.subscribe(...)`（与现有 sidebar/assistant 列表同一套刷新节奏），
  或复用 `useSyncExternalStore` 模式。
- 兼容性：`tokenUsage.stateVersion` 升级会让旧缓存行失效；缺失时降级显示；不要自行重算。

**验收（供后续任务用）**：
- 打开入口后 1s 内显示已缓存的总量；新完成的 turn 在列表刷新内更新。
- 断言 `tokenUsage` 四桶相加 = 总额；cache hit = cacheRead / (uncached + cacheRead + cacheWrite)。
- 助手/团队聚合 = 其所有已知 Session 之和（抽一个含线程与任务 worker 的实例核对）。
- 无投影/迁移中的 Session 显示「—」，不参与总和分母，页面标注「部分会话暂无法读取」。
- 不出现 `$`/`cost` 字样；不出现时间选择器。

### 5.2 关闭：完整用量页 / 费用

如果产品要求 MausBot 的 `costUsd` 或 DS Bot 的完整 usage page：

- **不要**在插件里自建 sqlite ledger 或价格表（非目标，且会与宿主/供应商价格漂移）。
- 向宿主提需求，最小形态：
  1. 新增宿主 `usage` 查询（service 或 projection 之外的 ledger）：按
     `sessionId / provider / model / kind / time bucket` 聚合
     `inputTokens / cacheReadTokens / cacheWriteTokens / outputTokens / calls`；
     折叠语义复用 `tokenUsage`（attempt 替换、retry 新尝试、fork 继承切点清零）。
     参考先例：DS Bot `host/usage.js` 的 `foldCalls` + 15 分钟桶。
  2. 若只要 calls：给 `tokenUsage`/`sessionStats` 增加 `calls` 字段即可，
     但时间/模型拆分仍需 ledger。
  3. 费用：给 `resolveModelInfo`/adapter 增加货币价格元数据，再由宿主算
     `cost`；账户 `/account/getBalance` 只能看钱包余额，不能按助手/团队分摊。
- 在宿主没有上述能力前，本项标记为「关闭」，不要用估算金额糊弄。

## 6. 结论摘要（给排期）

```text
有：单 Session 的 tokenUsage / sessionStats / contextPressure / modelSelection；
    助手/团队可客户端求和；无需宿主改动。
没有：时间序列、按 provider/model 拆账、calls、金额、lastTurn 投影。
建议：做只读 token 汇总入口（MausBot chip 的 token 回退形态）；
     DS Bot 完整 usage page 与金额关闭，或转宿主需求。
```
