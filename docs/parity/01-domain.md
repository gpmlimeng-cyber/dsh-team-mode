# 域词汇表（唯一命名）

> 2026-10-29 · 批一产物。规则：**代码里的 API 名不动**（transport 方法名保持稳定），统一的是**文档、注释与 UI 文案**。

## 1. 三个实体

| 统一名 | UI 用语 | 曾经用过的名字（禁止再用于文案） | 含义 |
|---|---|---|---|
| `assistantInstance` | **助手** | bot、assistant、instance、coworker、同事、成员模板 | 用户创建的一个具体助手：有形象、指令、模型、技能、记忆、工作区 |
| `assistantTemplate` | **助手模板** | role、preset、成员模板 | 可复用的一份角色定义，用来快速创建一个助手 |
| `team` | **团队** | room、group、channel、群 | 多人协作的容器 |

**关键区分**：*助手*（人）≠ *助手模板*（角色）。一个模板可以创建多个助手；助手可以加入多个团队。

## 2. 团队内的两个概念

| 统一名 | UI 用语 | 含义 |
|---|---|---|
| `team.members` | **成员** | 助手在某个团队里的身份（显示名、角色 leader/member） |
| `team.threads` | **线程**（OpenBot 叫 channel） | 团队里的一条会话；有唯一负责人 |

成员是"助手 × 团队"的连接；线程是"对话发生的地方"。**不要用「频道」**——我们对外统一叫线程。

## 3. 待确认

| 统一名 | UI 用语 | 曾经用过的名字 |
|---|---|---|
| `escalation` | **待确认** | approval、gate、confirm、确认卡 |

三种来源：`approval`（要批准）、`question`（要回答）、`blocked_task`（任务卡住）。这三者是待确认的**原因**，不是不同实体。

## 4. 状态词表

```
助手   idle / running / waiting_approval / error / archived
任务   pending / queued / running / waiting_approval / completed / failed / cancelled
线程   active / archived
待确认 open / lifted（+ 派生的「已过期」显示态）
记忆   private / team-safe（可见性） × active / proposed / superseded / archived（状态）
```

**同一状态词一旦定下就不要在别处换写法**（例如不要一边写 `waiting_approval`、文案里写「等待确认」、另一处写「待批准」）。

## 5. 执行约定

1. UI 文案里**只允许**出现本表右列「UI 用语」的写法；
2. 代码标识符保持现状（`assistantView`、`team.members` 等），**不为了统一而重命名 API**——那会破坏已有调用与存档数据；
3. 新增概念必须先加进本表再写代码；
4. 本表与 `00-capability-matrix.md` 一起构成后续每个 parity 文档的词汇基线。
