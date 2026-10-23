# 团队模式后续规划

> 更新：2026-10-22 · 对齐 DSH 0.2.1-rc.2 · 参考 `@nanmicoder/dsh-agent-teams` 的任务调度与质量门禁，不照搬其“当前会话即队长”的形态。

## 定位不变

```text
独立 Team 实体
├─ Team Session（Leader Session）作为团队父会话
├─ 成员是按团队创建的持久 membership Session
├─ 单聊助手保留独立的 DM 主会话
├─ 成员 Session 默认隐藏在原生侧栏
└─ 不替换 Harness 原生聊天、输入框与审批
```

AgentTeams 值得借鉴的是 **任务所有权/调度协议**；不是照搬“当前会话即队长”，也不是把成员做成临时 subagent。

## 核心竞品结论

| 竞品                | 主要机制                                                                                                      | 我们采用             |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| **DS Bot**          | 群管理员先答；一次一人顺序发言；`@` 叫人；群记忆、群权限、群工作文件夹；长任务后台完成后再回群                | 群聊秩序与发言体验   |
| **OpenMausBot**     | Chief of Staff；room + responder；`coordinate_bots` 持久委派；Goal 记录、忙时 park/resume、团队记忆、审批继承 | 持久目标与委派账本   |
| **dsh-agent-teams** | Captain + DAG + attempt + 调度器 + 质量门禁                                                                   | 任务所有权与门禁协议 |

结论：

```text
DS Bot      教群聊怎么“像群聊”
OpenMausBot 教团队怎么“不丢活”
AgentTeams  教任务怎么“防旧结果覆盖”
```

我们不直接运行 AgentTeams 作为群聊内核，也不照搬 OpenMausBot 的整套房间系统。

## 团队管家

群聊管理员由 Leader 承担，不新增第二个 Manager。
完整设定：[团队管家设定](./TEAM-STEWARD.md)。

职责：

```text
判断模式 → 建 Goal → 拆 Task → 选成员
→ 派 attempt → 跟踪/解锁 → 验收 → 收口
```

原则：

- 普通聊天不建 Goal
- 简单交付一个 Task
- 复杂目标才建 DAG
- 一次只有一个人说话
- 成员长任务不占群聊发言位
- 管家是运营者，不是所有工作的执行者

## 已有能力

- 团队、成员、Leader、共享 Workspace
- 团队消息、活动记录、任务板（依赖、owner、file scope）
- 成员 Session 隐藏与恢复
- 单聊助手主会话 + 隐藏 worker 任务
- 未读、审批关注、任务线程、会话日志导出
- 移动端侧栏与行操作

## 会话层级决策（2026-10-22 采纳）

采用“固定身份，不固定 Session”的双树模型：

```text
团队树
Team Session (Leader)
├─ 成员 A membership Session
│  └─ 团队任务子会话
└─ 成员 B membership Session
   └─ 团队任务子会话

单聊树
Assistant DM Main Session
├─ 单聊任务子会话
└─ 单聊任务子会话
```

规则：

- `assistantId`、`membershipId` 稳定；`sessionId` 按上下文创建
- 同一助手可同时在多个团队，每个团队一个成员会话
- 成员会话不跨团队复用，避免上下文、权限和并发互相污染
- 单聊任务挂在 DM 主会话下；团队任务挂在成员会话语义下
- Leader 换人时显式创建新 Team Session，不静默换父级
- 成员退出团队时归档 membership Session，不影响 DM 主会话或其他团队

明确拒绝“一个成员固定一个 Session 跨多个团队”：DSH 是单父级，固定会话会导致团队上下文混用、任务串行和归属不清。

## 近期优先队列（2026-10-23）

1. Turn Engine 收尾（team-turn-engine，进行中）
2. 侧栏团队状态行（小需求，优先）
3. 主 Agent 产品形态
4. 协作总览

侧栏团队行设计：[team-sidebar-row-design](./superpowers/specs/2026-10-23-team-sidebar-row-design.md)

## 后续优先级

### P0：可靠性

| 项目                             | 目标                                                          | 状态               |
| -------------------------------- | ------------------------------------------------------------- | ------------------ |
| 重载/冷启动主会话接管            | 已 live 的外来主会话返回可恢复冲突，不再静默打开无工具会话    | 已完成（显式恢复） |
| 任务 attempt / ownership fencing | 每次分配/转派生成 attempt；旧 attempt 的迟到更新被拒绝        | 已完成             |
| 冷恢复状态机                     | 区分进程内中断、插件重载、Host 冷启动；遗留任务生成新 attempt | 待开始             |
| 归档并发竞态                     | 归档状态与停止 worker 在同一实例锁内完成                      | 待开始             |
| 提示词 attempt 提示              | 派发/更新提示补 attempt_id，避免成员首次更新被拒              | 低优先补丁         |

### P1：群聊编排模式

按目标复杂度选择运行模式，避免把普通聊天任务化：

| 模式   | 触发                                        | 行为                  |
| ------ | ------------------------------------------- | --------------------- |
| 对话   | 1 个问题、无需交付/验证                     | 直接回答，不建 Goal   |
| 单任务 | 1 个目标、1 个 owner、一个可验收交付物      | 1 个 Goal + 1 个 Task |
| 编排   | 2+ 并行流、2+ 成员、依赖、验证/评审、长任务 | 1 个 Goal + DAG       |

多目标规则：

- 共享交付物或真实依赖 → 同一 Goal
- 独立目标 → 分开 Goal，共享调度器
- 单 Goal 建议 3–7 个任务；超过 10 个拆子目标

计划：[group-chat-orchestration-modes](./superpowers/plans/2026-10-22-group-chat-orchestration-modes.md)

### P1：记忆管理

分四个 scope：

```text
Assistant memory  身份与偏好
Team memory       团队约定、项目事实、决策
Goal memory       单次目标结论
Working memory    任务板 / attempt / 进度
```

三层：

```text
Core      每轮加载
Topic     按需召回
Archive   不加载，可搜索/恢复
```

顺序：

```text
P0  结构化 MemoryEntry + Assistant/Team scope + 旧字符串兼容
P1  Team memory 提案/接受、pin、journal、UI
P2  recall、自动 capture、去重/冲突整理
P3  会话搜索、图关系、可选社区插件适配
```

完整方案：[记忆管理方案](./MEMORY-ARCHITECTURE.md)

已定边界：[身份、记忆与权限决策](./DECISIONS-IDENTITY-MEMORY.md)

### P1：Raft 式身份与协作

借鉴 Raft，但保留 DSH 的 Session 约束。

| 项目                                | 目标                                              | 优先级 |
| ----------------------------------- | ------------------------------------------------- | ------ |
| membership → assistantInstance 链接 | 团队成员可解析真实助手身份，解锁 team-safe memory | P1     |
| task claim + member inbox           | 可选自动领取 ready task；inbox 先做投影           | P1     |
| thread / task context               | 消息带 threadId/taskId/goalId/replyTo             | P1     |
| reminder / follow-up                | dueAt/remindAt + 超时事件                         | P2     |
| 新成员有界历史                      | 注入摘要 + active memory + 相关 thread            | P2     |
| 成员私有 workspace                  | 团队共享目录 + 成员 scratch                       | P2     |

不照搬：

- 一个成员永久 Session 跨团队
- 无 attempt 的 claim
- 自由抢话
- 全局共享 memory

完整方案：[Raft 借鉴方案](./RAFT-ADOPTION.md)

### P1：任务协议

| 项目          | 目标                                                                                           | 借鉴点                       |
| ------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| 可选自动调度  | 默认手动分配；高级模式由空闲成员自动领取 ready task                                            | AgentTeams shared scheduler  |
| 质量门禁      | requirements → implementation → verification → review → integration，失败自动 repair/re-review | AgentTeams quality gates     |
| 任务详情/重试 | 任务级查看、取消、重试、产物与摘要                                                             | AgentTeams attempt lifecycle |
| 成员工具策略  | 部署方声明策略 id，成员按 id 选择，不暴露原始 allow/deny                                       | AgentTeams toolPolicies      |

### P1：竞品差距

| 项目                   | 目标                                                   |
| ---------------------- | ------------------------------------------------------ |
| Context Steward        | 压缩/分段/checkpoint/handoff，解决长任务失忆           |
| Group Chat Turn Engine | 管理员先答、顺序发言、@、迟到回复、审批胶囊            |
| Autonomous Ops         | routines、reminders、budget、busy park/resume          |
| Memory Automation      | capture/recall/tidy/journal，默认只写 proposed         |
| DSH Ecosystem Reuse    | 复用 MCP/Skills/Tools/Browser/UI slots，按成员策略治理 |

完整分析：[竞品差距与后续路线](./COMPETITIVE-GAPS.md)

### P2：产品与可观察性

| 项目                  | 目标                                         |
| --------------------- | -------------------------------------------- |
| 任务 DAG / 成员树面板 | 复用团队页展示依赖、owner、attempt、阻塞原因 |
| 团队活动时间线        | 统一任务、消息、审批、成员变更               |
| 团队记忆              | 团队级记忆与成员本地记忆隔离                 |
| Workspace 模型收口    | 默认工作区、助手工作区迁移/只读策略          |
| 多 Host               | 写入所有权、冲突检测、只读协作               |
| 发布流水线            | 本地打包/CI/版本说明；外部部署单独确认       |

## 执行模型策略

预算受限时，执行成员优先 `xiaomi-token-plan-cn / mimo-v2.6-flash`，Reviewer 保持独立质量模型。
详见：[执行模型策略](./EXECUTION-POLICY.md)

## 明确不做

- 不把“当前会话 = Captain”作为团队模型
- 不把成员做成临时 subagent；成员是持久 membership Session
- 不让一个成员 Session 跨多个团队复用
- 不迁移到 `.agent-teams` 文件存储
- 不默认开启自动调度
- 不用自定义聊天 UI 替换原生会话页
- **不排 JEV / Open-Jev 决策门（2026-10-23 决定）**
  - 不引入 TypeSafe Jev、Open-Jev、Kev 或类似 System One 模型作为审批/工具护栏
  - 不新增决策模型服务、托管 API、本地推理服务或 shadow 通道
  - 审批继续由确定性 policy + DSH 原生人工审批承担
  - 如未来重新评估，必须单独说明收益、数据出境、误放行风险和评测结果，不能默认恢复

## 当前执行

已完成：

```text
assistant-reload-takeover
team-attempt-fencing
group-chat-orchestration
memory-p0
assistant-identity-link
memory-goal-ui
raft-collaboration
runtime-reliability
team-epoch
quality-gates
```

进行中：

```text
tool-policies
```

后续：

```text
Release readiness（本地/CI，不外部部署）
→ Context Steward
→ Group Chat Turn Engine
→ Autonomous Ops
→ Memory Automation
→ DSH Ecosystem Reuse
```
