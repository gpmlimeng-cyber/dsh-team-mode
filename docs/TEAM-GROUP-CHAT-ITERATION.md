# 团队群聊迭代方案

> 结论：采用「DS Bot 骨架 + OpenMausBot 语义 + 原生 DSH UI」。
> 团队群聊不新增独立 Team Room，而是把 **Leader Session 升级为 Team Session**。
> 成员保留自己的 Session；所有交互进 Event Log；任务/配置/记忆放结构化存储。

---

## 1. 目标

1. 人类只有一个团队入口，默认进入 Team Session。
2. Team Session 由 Leader 承载：人说的话、Leader 的回复、团队决策都在这里。
3. 成员用自己的 Session 执行，不共享 Leader 上下文。
4. 成员之间的交互、任务、配置、记忆有统一记录，但不全部塞进模型上下文。
5. 不替换 DSH 原生会话、输入框、审批、工具卡。
6. 与现有单聊助手共用同一套底座，只是“主子”不同。

## 2. 非目标（首版）

- 不新增独立 Team Room / 观察者 / 多真人房间。
- 不做完整 Assignment Runtime（先最小状态）。
- 不做自定义聊天界面或消息气泡。
- 不做成员 Session 切换器（后续详情页可加）。
- 不改项目任务形态。

## 3. 目标模型

```text
Team
├─ teamSessionId = leader slot 的 Session（可见，人类入口）
├─ leaderSlotId
├─ members[]：各自 Session（隐藏）
├─ outbox / event log：所有消息与交互记录
├─ tasks：结构化任务板
├─ memory：团队记忆（Phase 2）
└─ config：团队配置（结构化）
```

### 3.1 为什么不是独立 Team Room

独立 Room + Leader Session 需要：

- 人类消息复制给 Leader；
- Leader 回复镜像回 Room；
- 两套历史同步；
- 任务卡/审批落在哪边要额外定义。

首版不做。Team Session 直接等于 Leader Session，只有一套历史。

### 3.2 谁负责什么

| 对象 | 职责 |
| --- | --- |
| Team Session（Leader） | 人类对话、计划、拆解、决策、汇总 |
| Member Session | 在自己的上下文里执行任务 |
| Event Log / outbox | 所有消息、交接、结果、异常的审计流 |
| Tasks | 任务状态、owner、依赖、结果 |
| Memory | 团队级记忆；成员本地记忆分开 |
| Config | 模型、成员、权限、工作区等结构化配置 |

## 4. 消息流

```text
人 → Team Session（Leader Agent）
        │ team_message / task_assign
        ├─ Member A Session
        ├─ Member B Session
        └─ Member C Session
              │ 结果 / 问题 / 阻塞
              ▼
        Team Event Log
              │ 摘要 / 任务卡 / 需要决策
              ▼
        Team Session（Leader 回答）
```

规则：

1. 人类输入只进 Team Session。
2. Leader 通过现有 team 工具给成员发消息或派任务。
3. 成员在自己的 Session 里执行；完整对话留在成员 Session。
4. 成员结果写入 Event Log，并给 Leader 一条摘要/任务卡。
5. Leader 默认回答人；需要细节时再读成员摘要。

## 5. 模型上下文策略

Team Session 的 prompt 注入**团队快照**，不注入所有成员原文：

```text
Team digest
- 团队：名称、工作区、成员与状态
- 任务：进行中/阻塞/待确认，最多 N 条
- 最近事件：谁交给谁、结果摘要、需要决策
- 团队记忆：团队级 MEMORY 摘要
```

成员 Session 的 prompt 注入：

- 自己的角色、任务 brief、相关文件范围；
- 团队共享的必要背景；
- 不注入其他成员的完整对话。

Event Log 保存完整消息，但只有摘要/关键事件进入模型上下文。

## 6. 数据模型改动

### 6.1 Team aggregate v3

```text
schemaVersion: 3
teamSessionId: string        // 首版 = leader session id
leaderSlotId: string
members: {...}
outbox: {...}                // 现有 teamMessage，继续作为事件流
tasks: {...}
memory?: {...}               // Phase 2
revision, createdAt, updatedAt
```

- v2 → v3 迁移：`teamSessionId = members[leaderSlotId].sessionId`，不新建 Session。
- `directMemberChat` 保留，用于未来直接成员入口。
- `outbox` 增加可选 `audience`/`kind` 字段时保持向后兼容。

### 6.2 派生视图

`team.view` 增加：

```text
teamSessionId
teamSession: { sessionId, leaderSlotId, title }
digest: { members, tasks, recentEvents, pendingDecisions }
```

不新增 Session 类型。

## 7. UI 改动

### 7.1 团队行

- 团队行仍显示为「群聊」。
- 点击团队行 → 打开 Team Session（单聊页签），不是默认看板。
- 看板/群聊/详情/轨迹页签保留。

### 7.2 页签

```text
单聊  = Team Session（Leader）
群聊  = 现有并行成员视图（观察/直接对话）
看板  = 任务列
详情  = 成员/配置
轨迹  = 事件/工具轨迹
```

- 人类默认输入在「单聊」。
- 「群聊」页签保留现有并行视图，不新增输入框逻辑。
- 看板/详情不显示输入框（已实现）。

### 7.3 标题

- 团队会话标题使用团队名，而不是 Leader 个人名。
- 可在不改变 Session 归属的前提下设置 UI 标题；是否需要改 DSH Session title 后续验证。

## 8. 成员与 Leader

- Leader 仍是 Team Session 的 Agent。
- 成员 Session 不变，继续隐藏。
- Leader 换人：
  - 首版：提示“换 Leader 会创建新的 Team Session”，不做静默换绑。
  - 后续：显式迁移事件/摘要。
- 成员离开：保留历史事件，Session 归档。

## 9. 分阶段

### Phase 0：Team Session 别名（1–2 天）

- aggregate v3 + `teamSessionId` 迁移。
- `team.view` 返回 `teamSessionId`。
- 团队行点击默认打开 Team Session。
- 单聊页签标题/入口文案统一。
- 验收：同一团队重启后仍进入同一 Session；成员 Session 仍隐藏。

### Phase 1：统一事件与摘要（3–5 天）

- 所有 team_message/交接/结果写入 outbox，补齐 audience/kind。
- Leader prompt 注入团队 digest。
- 成员结果回 Leader 时只给摘要 + 任务引用。
- 验收：人只在 Team Session 输入；成员执行不污染主上下文；事件可追溯。

### Phase 2：团队记忆与任务卡（4–6 天）

- 团队级 memory（MEMORY.md + 预算加载）。
- 任务卡/待确认/阻塞在 Team Session 里以原生消息/工具卡呈现。
- 成员本地记忆与团队记忆隔离。
- 验收：团队记忆可查看/编辑；任务状态与看板一致。

### Phase 3：路由与多人（可选，5–8 天）

- Leader 判断直接回答 / 派成员 / 追问。
- 多真人、观察者、独立 Team Room 的可行性评估。
- 不与首版绑定。

## 10. 验收清单

- [ ] 团队行点击进入 Team Session。
- [ ] 人类消息只出现在 Team Session。
- [ ] 成员 Session 不在原生 Sidebar 出现。
- [ ] 成员结果以摘要/事件回到 Team Session。
- [ ] 看板任务与 Team Session 摘要一致。
- [ ] 重启后 teamSessionId 不变。
- [ ] 换 Leader 有明确提示，不静默换绑。
- [ ] 单聊助手复用同一套 Session/映射逻辑。
- [ ] 项目任务形态不受影响。

## 11. 风险

| 风险 | 对策 |
| --- | --- |
| Leader 上下文膨胀 | 只注入 digest；完整内容留成员 Session |
| Leader 换人 | 显式新 Team Session，不静默迁移 |
| 多真人并发 | 首版单入口；后续再评估 Room |
| Event Log 无限增长 | 分页/摘要/归档 |
| 原生 Session 标题与团队名不一致 | UI 标题先行，Session title 后续验证 |
| 隐藏成员 Session 失效 | 现有 hider + MutationObserver；详情兜底 |
| 与单聊助手字段分叉 | 共用 assistant/team session 映射接口 |

## 12. 结论

团队群聊的迭代不是“再加一个房间”，而是：

1. 把 Leader Session 正式定义为 Team Session；
2. 人类默认只和它交互；
3. 成员保留自己的 Session；
4. 所有交互进 Event Log；
5. 任务、配置、记忆留在结构化存储；
6. 原生 DSH 会话界面不动。

这样团队群聊和单聊助手共用同一套底座：

```text
主会话（Leader/Bot）+ 隐藏执行 Session + Event Log + Tasks + Memory
```

只是团队的主会话是 Leader，单聊的主会话是 Bot。
