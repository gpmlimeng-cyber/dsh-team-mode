# 竞品差距与后续路线

> 2026-10-23 · DS Bot / OpenMausBot / Raft 对比后的下一步  
> 定位：DSH 原生的团队执行层，不重做聊天壳，也不重做 DSH 插件生态。

## 结论

全部已规划能力落地后，我们会在：

```text
Task / Attempt 所有权
Team Epoch
成员 Session 边界
分 scope 记忆
质量门禁
DSH 原生集成
```

上领先。

主要差距在：

```text
上下文生命周期
群聊 turn engine
自主运营
记忆自动化
发布与社区
```

生态策略不是“自己补连接器”，而是：

> **复用 DSH 插件生态，把团队/助手作为一等上下文接入现有能力。**

---

## 差距优先级

### P0：上下文生命周期

缺失：

```text
Session 分段
压缩
checkpoint
handoff
长任务上下文接续
```

影响：

- 长群聊上下文膨胀
- 任务执行到一半被截断
- 压缩后细节丢失
- 新成员接不上旧上下文

方案：

```text
Context Steward
├─ 判断压缩 or 换段
├─ checkpoint
├─ handoff
└─ 旧段归档/可搜索
```

这是记忆和任务板的地基，优先级最高。

### P0：群聊 turn engine

DS Bot 的成熟点：

```text
管理员先答
一次一人
@ 点名
@all 限制
迟到回复
进度播报
审批胶囊
群公告 / 群权限
```

我们当前更偏工作台。需要补：

```text
普通消息 → 聊天优先
复杂目标 → 编排模式
```

不能只靠任务板假装群聊。

### P1：自主运营

OpenMausBot 的强项：

```text
routines
reminders
durable goals
busy park/resume
delegation ledger
daily tidy
budget / max turns
```

我们目前仍偏“用户推一下才动”。

补：

```text
Task.dueAt / remindAt
Routine
Goal maxTurns / budget
Busy park / resume
Daily / goal-close tidy
```

### P1：记忆自动化

已落地结构化记忆，但还缺：

```text
auto capture
auto recall
topic 整理
去重 / 过期 / 冲突
journal / undo
```

目标：

```text
用户不用管
系统只写 proposed
Leader/用户接受
```

### P1：DSH 生态复用

不自己造：

```text
connectors
browser
computer
cloud
mobile
MCP 市场
```

改用 DSH 插件生态：

```text
MCP servers
Skills
Tools
Browser / computer plugins
UI slots
Approval / permission services
```

我们的职责：

```text
Team/assistant context
Capability allowlist per member
Tool policy
Session / workspace binding
```

需要补的适配层：

- 能力发现：哪些 DSH 能力可用于团队
- 团队/助手作用域：成员能加载哪些 MCP/Skill/Tool
- 成员工具策略：与 DSH 全局工具策略衔接
- 权限继承：成员权限不得超过团队/用户边界
- 插件 UI slot：复用原生，不另造壳

### P2：发布与社区

```text
npm 发布
CI
五语 README
插件市场元数据
升级/迁移说明
示例团队模板
```

不做外部部署前，只做本地发布就绪。

---

## 生态优势

我们的优势不是“功能比 DS Bot/OpenMausBot 多”，而是：

> **DSH 插件生态里的所有能力，都可以被团队/助手复用，而不需要我们再造一套连接器。**

具体：

| 能力 | 谁提供 | 我们做什么 |
|---|---|---|
| MCP | DSH / 插件 | 团队成员按策略挂载 |
| Skills | DSH / 插件 | 成员按角色加载 |
| Tools | DSH / 插件 | 工具策略过滤 |
| Browser | DSH 插件 | 成员按权限使用 |
| UI | DSH slots | 复用原生聊天/审批 |
| 权限 | DSH | 团队边界内继承 |
| 模型 | DSH | 每成员独立路由 |

前提：

- 插件要能感知 team/assistant 作用域
- 成员工具策略要能限制第三方工具
- 不能让第三方插件绕过团队权限

这比 OpenMausBot 自建 connectors 更轻，也更符合 DSH 的长期方向。

---

## 后续路线

```text
R1  Context Steward（压缩/分段/checkpoint/handoff）
R2  Group Chat Turn Engine（管理员先答/顺序/@/迟到回复）
R3  Autonomous Ops（routines/reminders/budget/park）
R4  Memory Automation（capture/recall/tidy/journal）
R5  DSH Ecosystem Reuse（能力发现/成员策略/权限边界）
R6  Release Readiness（CI/package/docs，不外部部署）
```

依赖：

```text
R1 独立，但影响 R3/R4
R2 依赖 steward/team session
R3 依赖 R1 + durable goal
R4 依赖 memory P0 + R3
R5 依赖 tool policy + permission
R6 最后
```

---

## 明确不做

- 不重做 DSH 聊天/输入/审批壳
- 不先造 connectors/cloud/mobile
- 不把第三方插件能力绕过团队权限
- 不让所有群聊默认进入重编排
- 不把上下文压缩和长期记忆混成一个东西

## 判断标准

补齐后应能回答：

```text
长群聊是否不失忆？
复杂任务是否能自动推进？
成员能力是否可治理？
第三方 DSH 插件是否能安全复用？
```

如果四个都是“是”，才具备和 DS Bot / OpenMausBot 正面比较的资格。
