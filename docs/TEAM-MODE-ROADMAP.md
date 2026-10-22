# 团队模式后续规划

> 更新：2026-10-22 · 对齐 DSH 0.2.1-rc.2 · 参考 `@nanmicoder/dsh-agent-teams` 的任务调度与质量门禁，不照搬其“当前会话即队长”的形态。

## 定位不变

```text
独立 Team 实体
├─ Leader 与成员平级，各自拥有原生 Session
├─ 成员 Session 默认隐藏在原生侧栏
├─ 群聊团队 + 单聊助手共用 Agent 生命周期
└─ 不替换 Harness 原生聊天、输入框与审批
```

AgentTeams 值得借鉴的是 **任务所有权/调度协议**；不是把团队退化为当前会话里的临时子 Agent。

## 已有能力

- 团队、成员、Leader、共享 Workspace
- 团队消息、活动记录、任务板（依赖、owner、file scope）
- 成员 Session 隐藏与恢复
- 单聊助手主会话 + 隐藏 worker 任务
- 未读、审批关注、任务线程、会话日志导出
- 移动端侧栏与行操作

## 后续优先级

### P0：可靠性

| 项目 | 目标 | 状态 |
|---|---|---|
| 重载/冷启动主会话接管 | 重载后恢复助手工具与记忆，或明确报错，不静默打开无工具主会话 | 进行中 |
| 任务 attempt / ownership fencing | 每次分配/转派生成 attempt；旧 attempt 的迟到更新被拒绝 | 待开始 |
| 冷恢复状态机 | 区分进程内中断、插件重载、Host 冷启动；遗留任务生成新 attempt | 待开始 |
| 归档并发竞态 | 归档状态与停止 worker 在同一实例锁内完成 | 待开始 |

### P1：任务协议

| 项目 | 目标 | 借鉴点 |
|---|---|---|
| 可选自动调度 | 默认手动分配；高级模式由空闲成员自动领取 ready task | AgentTeams shared scheduler |
| 质量门禁 | requirements → implementation → verification → review → integration，失败自动 repair/re-review | AgentTeams quality gates |
| 任务详情/重试 | 任务级查看、取消、重试、产物与摘要 | AgentTeams attempt lifecycle |
| 成员工具策略 | 部署方声明策略 id，成员按 id 选择，不暴露原始 allow/deny | AgentTeams toolPolicies |

### P2：产品与可观察性

| 项目 | 目标 |
|---|---|
| 任务 DAG / 成员树面板 | 复用团队页展示依赖、owner、attempt、阻塞原因 |
| 团队活动时间线 | 统一任务、消息、审批、成员变更 |
| 团队记忆 | 团队级记忆与成员本地记忆隔离 |
| Workspace 模型收口 | 默认工作区、助手工作区迁移/只读策略 |
| 多 Host | 写入所有权、冲突检测、只读协作 |
| 发布流水线 | 正式 npm 发布、CI、版本升级冒烟 |

## 明确不做

- 不把“当前会话 = Captain”作为团队模型
- 不把成员改成 Leader 的临时子 Agent
- 不迁移到 `.agent-teams` 文件存储
- 不默认开启自动调度
- 不用自定义聊天 UI 替换原生会话页

## 当前执行

进行中计划：[assistant-reload-takeover](./superpowers/plans/2026-10-22-assistant-reload-takeover.md)

完成后再依次进入：

```text
attempt/ownership fencing
→ 冷恢复状态机
→ 归档竞态
→ 质量门禁 / 可选自动调度
```
