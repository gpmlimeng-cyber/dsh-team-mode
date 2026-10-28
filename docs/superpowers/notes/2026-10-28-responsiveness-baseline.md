# 团队响应速度基线（P0′ 测量）

> 2026-10-28 · 对应 `docs/superpowers/plans/2026-10-28-team-responsiveness.md` 的 **P0**。
> **这次没有改任何产品行为**：只新增 `scripts/measure-team-latency.measure.ts`、`scripts/vitest.measure.config.ts` 和本文档。

## 1. 这次要回答什么

四个用户能感知的区间，各自的真实耗时是多少，慢在**插件自己**还是慢在**模型回合**：

```text
1 建团队      → 团队行出现
2 团队行出现  → Leader 会话可打开（team.start）
3 任务下派    → 成员开始跑
4 成员跑完    → 状态回到团队行
```

## 2. 方法

### 2.1 两条数据来源（都不用改运行时）

**A. 进程内编排成本（本脚本，N=8）**

`scripts/measure-team-latency.measure.ts` 启动**真实的** `AgentTeamService` + `TeamRuntime`，只把两样东西换成替身：

- 存储：`DomainAgentTeamStore` 原样运行，底下换成一个 Map 版 `Domain`（写操作在微任务里完成，是真实落盘的下界）；
- Agent：用假 Agent（`followup` / `status` / `session.events`），**不调用任何模型**。

每个样本建一个全新团队（1 leader + 2 members），按真实调用顺序跑「创建 → start → 下派任务 → 回合结束」，用 `service.subscribe`（就是 SSE 推送出去的那条变更流）与 `performance.now()` 打点。因此 A 表回答的是：**这段等待里有多少是 Agent Team 自己的开销**。

**B. 本机已落盘的真实记录（只读，不做任何写入）**

直接读 `~/.dsh/storages/dsh_team_mode.json`，用运行时自己写下的时间戳算差值：

| 区间 | 数据字段 |
| --- | --- |
| 团队记录写入 → 行变更推送 | `teams[].createdAt` → `activities[] team.created .createdAt` |
| Leader 上线 | `teams[].warmup.startedAt` → `warmup.leaderReadyAt` |
| 下派消息投递 | `messages[].createdAt` → `activities[] team.message_delivered` |
| 任务下派 → 成员进入 running | `activities[] team.task_created` → 同名任务的 `team.task_updated ... entered running` |

B 表回答的是：**真实模型 + 真实磁盘上，用户实际等了多久**。

### 2.2 复现命令

```bash
# 门禁（本次改动不碰 src/，仍按规矩跑）
npm run build && npm run check

# A + B 一次跑完，直接打印两张表
npx vitest run --config scripts/vitest.measure.config.ts

# 换一份已落盘数据（例如别的机器的 profile）
DSH_TEAM_STORE=/path/to/dsh_team_mode.json npx vitest run --config scripts/vitest.measure.config.ts
```

脚本不进 `npm test`、不进 `npm run check`（配置在 `scripts/` 下单独一份），生产路径零影响。

### 2.3 机器与负载

```text
darwin arm64 · 8 核 · node v22.22.3
测量时 load average 9.72 / 8.79 / 7.52
（同一检出上还有别的 agent 在跑 build/test，故意的：保留真实负载）
```

负载确实影响长尾：负载 14 的那一次，`team.start` 的 p95 从 3.1 ms 涨到 6.9 ms、`4` 从 1.3 ms 涨到 4.9 ms。**全都还是毫秒级**，没有一项接近秒。

## 3. 基线表

### 3.1 A 表 · 插件自身编排（N=8，假 Agent，不含模型时间）

| # | 区间 | 中位数 | p95 | 最慢 | 样本 | 用户可感知阻塞？ |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 建团队 → 行变更推送（服务端） | 0.2 ms | 1.2 ms | 1.2 ms | 8 | 否 |
| 1b | 侧栏拉取团队列表（`listTeams`） | 0.0 ms | 0.0 ms | 0.0 ms | 8 | 否 |
| 1c | 一次客户端 reload（catalog+assistant.list+team.list） | 0.0 ms | 0.1 ms | 0.1 ms | 8 | 否 |
| 2 | 团队行出现 → Leader 可打开（`team.start`） | 0.5 ms | 3.1 ms | 3.1 ms | 8 | 否（见 B 表真实值） |
| 2b | 记录里 `warmup.startedAt → leaderReadyAt` | 1.0 ms | 3.0 ms | 3.0 ms | 8 | 否 |
| 2c | `warmup.startedAt → phase ready`（含 2 名队员） | 1.2 ms | 2.9 ms | 2.9 ms | 8 | 否 |
| 3 | 任务下派 → 空闲成员被唤醒 | 0.1 ms | 0.6 ms | 0.6 ms | 8 | 否 |
| 3b | 队内已有回合时，给另一名成员发**对话消息** | **queued** | — | — | 8 | **是（见 §4.3）** |
| 3c | 当前回合释放 → 被停泊的成员被唤醒 | 0.0 ms | 0.1 ms | 0.1 ms | 8 | 否 |
| 3d | 队内已有回合时，给另一名成员**分派任务** | **delivered** | — | — | 8 | 否（不排队） |
| 4 | 成员转为 idle → 团队行状态推送 | 1.2 ms | 1.3 ms | 1.3 ms | 8 | 否 |
| 4b | 客户端变更合并窗口（源码常量 `TEAM_RELOAD_DEBOUNCE_MS`） | 120 ms | — | — | 源码 | 否 |

每个样本的变更事件数（每一条都会唤醒客户端；120 ms 内最多合并成一次 reload）：

| 阶段 | 事件数（中位/最大） |
| --- | --- |
| 1 建团队 | 2 / 2 |
| 2 start | 3 / 3 |
| 3 下派 + 运行 | 7 / 7 |
| 4 状态回写 | 2 / 2 |
| 合计 | **14 / 14** |

### 3.2 B 表 · 本机真实记录（只读）

| # | 区间 | 中位数 | p95 | 最慢 | 样本 | 用户可感知阻塞？ |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 团队记录写入 → 行变更推送 | 95 ms | 179 ms | 179 ms | 2 | 否 |
| 2 | Leader 上线（`warmup.startedAt → leaderReadyAt`） | 350 ms | 350 ms | 350 ms | **1（不足）** | 否 |
| 3 | 下派消息落库 → 投递确认 | 118 ms | 238 ms | 238 ms | 6 | 否 |
| 3′ | 任务下派 → 成员进入 running | **72.3 s** | 75.8 s | 75.8 s | **2（不足）** | **是** |

样本说明（照实写，不用单次测量下结论）：

- 本机只有 2 个团队、1 条完整 warmup、6 条投递记录、2 条“任务→running”记录，**B 表全部是“样本不足”级别**；
- 但两条独立记录的量级一致（68.9 s / 75.7 s），且与 A 表“插件侧 0.1 ms 派发”是同一件事的两端，方向明确：**派发是毫秒级，之后几十秒是模型回合**；
- `team.start` 的 B 值是 350 ms（含真实磁盘 + Agent 创建），A 值是 0.5 ms，差额就是真实 IO 与 Agent 装配成本。

## 4. 读数

### 4.1 插件自己不是瓶颈

四个区间里，插件侧全部 ≤ 2 ms；唯一上到两位数的 120 ms 是**客户端故意做的变更合并窗口**，不是计算。建团队写库 + 推送 95 ms（n=2）已经是这条链上最贵的一步，仍不到 0.1 s。

### 4.2 用户的等待几乎全在“回合”里

任务派发 0.1 ms 唤醒、118 ms 投递确认，然后 **72.3 s 才进 running**（n=2）。这段不是编排开销，是成员 Agent 读到指令、决定开工的模型时间。换言之：**首响慢不是“团队机制慢”，而是“团队机制让用户在等待期间看不到任何东西”**。

### 4.3 一个真实的串行点：队内同一时间只有一个回合

`TeamTurnCoordinator` 每队只允许一个活跃回合。实测（3b）：某成员回合在跑时，给另一名成员的**对话消息**被停泊成 `queued`，要等当前回合释放才唤醒（释放→唤醒 0.0 ms，几乎瞬时）。它的等待 = **当前回合的剩余时长**，按 B 表就是 70 s 量级，且没有上限。

注意 3d：**任务分派不走这条门**（走消息直投），已经有回合在跑时依然 `delivered`、不排队。所以“多成员任务串行启动”这个假设在这次测量里**不成立**。

### 4.4 “减少轮询”没有收益

客户端是 SSE 推送 + 120 ms 合并，**不存在轮询**。一个完整流程推 14 条变更，服务端一次 reload（catalog+assistant.list+team.list）实测 0.1 ms 上限，所以把 14 次 reload 压成 3 次也省不到 1 ms。这条优化不值得做。

## 5. 结论：先改哪一个

**先做 P2「真实状态行」（L2），不要先做 P3 并行分派。**

依据：

| 候选 | 数据依据 | 预估收益 |
| --- | --- | --- |
| **P2 真实状态行**（推荐先做） | 插件侧状态写入 1.2 ms + 客户端合并 120 ms；现在这段期间用户看到的是 **72 s 静默**（B 表 3′） | 首条真实状态 **< 200 ms** 可见，把“安静 72 s”变成“2 秒内知道在跑”。不需要新埋点：`team.member_status`、`team.task_updated`、`team.message_delivered` 事件已经在推 |
| P1 已建团队跳过 roster 确认 | 计划中的结构问题，本次未直接测到；用一个回合的长度做代理估算（72.3 s，n=2，**估计值**） | 省 **≈ 1 个完整 Leader 回合（约 70 s）** + 一次用户往返 |
| P3 并行分派 | **反证**：任务派发不排队（3d `delivered`，派发 0.1 ms / 投递确认 118 ms），多成员任务本来就不互相阻塞 | 可省的串行时间 ≈ 0，先不做；真正串行的是“对话回合”，要等 P2 有了状态行才验证得到 |

一句话：**先把已有的真实事件显示出来，比优化一个实测只有毫秒级的链路更值。**

## 6. 这次没有改任何产品行为

- `src/` 一行未改；没有新增开关、没有新增埋点、没有改分派/轮询/合并窗口；
- 新增文件只有：`scripts/measure-team-latency.measure.ts`、`scripts/vitest.measure.config.ts`、本文档；
- B 表只读 `~/.dsh/storages/dsh_team_mode.json`，不写产品存储；
- `npm run build && npm run check` 全绿（1584 tests）。

## 7. 还没测到的（留给下一步）

1. **12 条固定提示的真实跑分**（TTFB / 首 token / direct 占比）需要真实模型跑一遍，今天没做——它测的是 §4.2 那 70 s 里面到底是什么；
2. 一次真实的“建团队 → 行出现”端到端（含浏览器渲染）没测：本次只到服务端推送 + 客户端 120 ms 窗口；
3. 状态行上线后，用同一脚本 B 部分复测「`turn/end` → `team.member_status`」的真实间隔，作为 P2 的验收数字。
