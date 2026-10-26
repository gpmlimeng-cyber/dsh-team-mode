# P1 · 助手会话容器 — 设计

> 2026-10-26 · 目标插件 `@limeng/dsh-team-mode` · 状态：待评审
> 上游：`2026-10-26-mausbot-alignment-plan.md`（P1）

## 目标

一个助手可以拥有**多条可见会话**（对齐 MausBot `Bot.threadId` + 多 thread），而不是现状的"一条主会话 + 隐藏的历史主会话"。

## 数据

`assistantInstanceSchema` 增加：

| 字段 | 说明 |
|---|---|
| `threadSessionIds: string[]` | 有序；**不含** `mainSessionId`（主会话单独字段，永远排第一） |
| `retiredThreadSessionIds: string[]` | 归档 = 移到这里，不再列出 |

约束：`threadSessionIds` ≤ 20、无重复、不包含 `mainSessionId`；`mainSessionId` 不可归档/删除。

不加 schema 版本号：旧记录无字段即空数组（与 `retiredMainSessionIds` 同例）。

## 服务

| 方法 | 行为 |
|---|---|
| `createAssistantThread(instanceId, cwd?)` | 在该实例的 workspace 内新建 DSH 会话，append 到 `threadSessionIds`，返回新会话 id |
| `archiveAssistantThread(instanceId, sessionId)` | 从 `threadSessionIds` 移到 `retiredThreadSessionIds`；拒绝主会话 |
| `renameAssistantThread` | 复用宿主会话标题（不新增字段） |

传输：`assistant.thread.create` / `assistant.thread.archive`，结果回 `AssistantInstanceView`。

## UI

- 助手行（单聊）可展开：展开后在该行下方列出 `mainSessionId` + `threadSessionIds` 的会话行，样式复用团队名册行的结构（不新造第三套行样式）。
- **默认折叠**：展开状态按实例 id 存 localStorage；不展开时侧栏与现在逐像素一致。
- 行菜单加两项：「新建会话」「在工作目录中新建…」（后者先选目录再建）。
- 会话行点击 = 打开该会话；会话行右键/⋯ 提供「归档会话」（主会话不提供）。

## 身份不受影响（硬约束）

协调者、Leader、成员身份的判定**一律以助手实例为准，不以会话为准**：
- `isCoordinatorInstance` 仍读实例；
- 团队的 `member.sessionId` 仍指向该实例的**主会话**；
- 新增的会话**不参与**团队角色解析，即使它属于某个团队成员实例。

所以"同一个助手在不同会话里状态不同"不会让协调者/Leader 变得可疑——它们不看会话。

## 验收

1. 给某助手新建一条会话 → 该行展开后能看到两条，主会话排第一且标注「主」。
2. 归档非主会话 → 它从列表消失；归档主会话被拒（返回明确错误）。
3. 未展开任何助手时，侧栏与改动前一致。
4. 新建会话后，该助手仍是原协调者/Leader 身份，团队任务不受影响。

## 不做

- 不做会话间迁移、不做线程级共享记忆（那是 P2 的分区 brief）。
- 不做每会话独立模型（P3 批量设置的范畴）。
- 不重绘会话行本身（沿用宿主的会话行渲染，我们只提供列表与入口）。
