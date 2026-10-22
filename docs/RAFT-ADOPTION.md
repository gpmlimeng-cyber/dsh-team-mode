# Raft 借鉴方案

> 2026-10-22 · 参考 Raft 的 agent-native workspace，不照搬其“一个 Agent 一个永久 Session”的技术形态。

## 结论

Raft 最值得借鉴的是：

```text
身份独立于 Session
共享任务板 + claim
thread / task 级上下文
每成员 inbox
reminder / follow-up
新成员读有界历史
成员私有 workspace
```

不照搬：

```text
一个成员永久 Session 跨多个团队
自由抢话的共享频道
所有上下文汇成一个共享 memory
无 attempt 的任务 claim
```

我们的形态仍是：

```text
assistantId 稳定
membershipId 稳定
sessionId 按上下文创建
Team Session + membership Session
attempt fencing + 团队管家
```

参考：

- [Introducing Raft](https://raft.build/resources/blog/introducing-raft-where-humans-and-agents-build-together/)
- [Build your agent team](https://docs.raft.build/build-your-agent-team/)

## 借鉴矩阵

| Raft 能力 | 我们的实现 | 优先级 |
|---|---|---|
| Agent 持续身份 | `membership → assistantInstance` 显式链接 | P1 |
| 共享任务板 claim | 可选自动调度：ready task → claim + attempt | P1 |
| thread / handoff | `TeamMessage.threadId/taskId/goalId/replyTo` | P1 |
| 每成员 inbox | 从任务/消息/审批派生的投影 | P1 |
| reminder / follow-up | `Task.remindAt/dueAt` + reminder 事件 | P2 |
| 新成员读历史 | 加入时有界注入团队摘要 + active memory + 相关 thread | P2 |
| 每 Agent workspace | 团队共享 Workspace + 成员私有 scratch | P2 |

## P1：身份链接

当前缺口：

```text
团队成员.assistantId = AssistantTemplate.id
助手记忆 = AssistantInstance.id
```

导致：

- 团队成员无法读取 assistant 的 `team-safe` memory
- 团队里的助手身份与单聊助手实例不是同一个

方案：

```ts
TeamMember {
  assistantId: AssistantTemplateId   // 现有
  assistantInstanceId?: AssistantInstanceId  // 新增，显式链接
}
```

规则：

- 只有创建/更新成员时显式提供 `assistantInstanceId` 才建立链接
- 不根据模板、Workspace 或名称推断实例；未提供则保持 `undefined`
- 成员读取 assistant memory 时只使用显式链接
- 链接不可跨 Workspace/用户
- 旧团队无链接 → 不注入 assistant memory，继续兼容

这是记忆 P0 之后最优先的身份基础。

## P1：任务 claim 与 inbox

### Claim

```text
Leader 创建 ready task
→ 空闲成员 claim
→ 生成 attempt
→ 执行
```

约束：

- 只有 ready 且有 goal/owner 规则允许的任务可 claim
- 同一任务只能一个有效 attempt
- claim 失败返回当前 owner/attempt
- 不替代 Leader 手动派发，默认仍由管家决定

### Inbox

不新增独立存储，先做投影：

```text
MemberInbox
├─ assigned tasks
├─ ready tasks（可选 claim）
├─ unread messages
├─ pending approvals
├─ stale attempts
└─ reminders
```

来源：

- 任务板
- 团队消息
- 审批状态
- reminder

## P1：Thread 上下文

给消息加：

```ts
TeamMessage {
  threadId?: string
  taskId?: string
  goalId?: string
  replyTo?: string
}
```

用途：

- 任务结果与讨论可追溯
- 新成员只读相关 thread，不读完整频道
- Leader 汇总时按 thread 聚合
- 避免频道噪音污染任务上下文

## P2：Reminder / follow-up

```ts
Task {
  dueAt?: string
  remindAt?: string
}
```

事件：

```text
task.reminder_due
task.overdue
```

用途：

- 等待型任务
- 定时跟进
- 长任务超时升级
- 不依赖 Agent 自己“记得”

## P2：新成员有界历史

新 membership Session 启动时注入：

```text
团队摘要
active team memory
相关 Goal / Task 摘要
最近 thread 片段
```

不注入完整频道历史。  
遵守预算，避免破坏缓存和上下文。

## P2：成员私有 workspace

保留团队共享 Workspace，同时给成员：

```text
member scratch / notes
```

用途：

- 草稿、临时文件、个人笔记
- 不污染团队共享目录
- 不自动进入团队记忆

## 明确不做

- 不把一个成员 Session 永久复用到多个团队
- 不做无 attempt 的 claim
- 不做自由抢话
- 不做全局共享 memory
- 不复制 Raft 的频道/任务/记忆三套独立模型
- 不用 Raft 替代团队管家

## 落地顺序

```text
memory P0 完成
→ P1 membership → assistantInstance 链接
→ P1 task claim + inbox
→ P1 thread/task context
→ P2 reminders
→ P2 new-member context
→ P2 member private workspace
```

## 判断

Raft 帮助我们补齐三个产品能力：

```text
1. 身份先于 Session
2. 任务板要能被成员认领
3. 上下文要按 thread/task 组织
```

但技术底座仍用我们的：

```text
Team Session
membership Session
attempt fencing
团队管家
分 scope 记忆
```
