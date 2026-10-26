# 总协调机器人（Coordinator）设计

> 参考：OpenMausBot @ `0.1.127`（`server/chief-of-staff.ts`、`server/store.ts:1710`、`shared/bot-owner.ts`、`src/components/Sidebar.tsx`）
> 目标插件：`@limeng/dsh-team-mode` · 状态：待评审

## OpenMausBot 到底做了什么

| 机制 | 位置 | 行为 |
|---|---|---|
| `chiefOfStaff` 标记 | `store.ts:1718` | 机器人上的布尔字段 |
| 作用域内唯一 | `store.ts:1710` `setChiefOfStaff` | `chiefScope()` = `owner:<email>` 或 `section:<部门>`，同一作用域设新的会清掉旧的 |
| 不可隐藏 | `store.ts:449` | 启动迁移强制 `hidden = false` |
| 不可移入团队 | `Sidebar.tsx:509` | `teamMove.blockedChief` 直接拒绝 |
| 跨部门权限 | `managedSections` | 额外的部门清单，超出时拒绝 |
| 王冠与置顶 | `Sidebar.tsx:1015/1049` | 行内 Crown，`aria-label=chiefOfStaff` |
| 系统提示 | `chief-of-staff.ts:23` | 单一联系人；只协调向自己汇报的 bot；委派后结束回合、回来汇总；不得编造进度；incidents/escalations 两个专属线程；只能关闭「bot 开的、已空闲的」线程；团队组建走 `propose_team_setup` 一次提案 |
| 判断模型 | `docs/decision-model.md` | 房间里没人被 @ 时，用一个快速分类模型选谁答；置信度 <0.6 或超时回落 lead/首成员 |

## 我们现在有什么、缺什么

已有：每队一个 Leader（`team.leaderSlotId`）、任务板与 attempt 所有权、消息/收件箱、记忆、24 个 `team_*` 工具、助手模板与实例、`systemPrompt` 注入缝。

缺：**跨队的「一个人」**。我们的 Leader 只在队内协调，队与队之间没有任何角色；现在顶部那个"总协调"只是按名字猜出来的 UI 置顶，没有数据、没有职责、没有守卫。

## 设计决策

1. **唯一，落在实例上。**
   `assistant_instance.coordinator?: boolean`，由服务端保证同一 workspace 只有一个（设新的自动清旧的）。不做 OpenMausBot 的多 `scope`——我们的团队本来就是 workspace 级，多作用域只会增加没人用的分支。

2. **三处硬守卫**（对应它的 hidden / teamMove / 唯一）：
   - 不能归档：`assistant.instance.archive` 对 coordinator 直接拒绝，提示先取消；
   - 不能被静默隐藏：实例加载时 `coordinator === true` 强制 `status !== 'archived'`；
   - 切换即互斥：`assistant.coordinator.set` 单事务写两条记录。

3. **提示词按职责组装。**
   协调者会话启动时，`systemPrompt` 追加一段：全部团队 + 各队 Leader/成员 + 未完成任务摘要 + 职责（单一联系人、用 `team_*` 委派、委派后结束回合、回来汇总、失败如实说、不得编造进度）。不做它那套 incidents/escalations 双线程——我们已经有 `team_mode_inbox`，先把入口做对，再谈专用线程。

4. **跨队收件箱。**
   协调者的 `team_mode_inbox` 聚合**所有队**的待确认项（审批、提问、待你处理的任务），而不是只有自己队。这是"一个人"最实在的体现。

5. **不做决策模型。**
   群里没人被 @ 时谁答——我们维持 Leader 优先，不引入分类模型。理由：多一个外部依赖、多一个 0.6 阈值调参、多一份失败模式；OpenMausBot 自己也承认阈值只对 Jev 校准过。

6. **UI 由字段驱动。**
   顶部队列不再靠名字含「管家」猜，读 `coordinator` 字段；单聊列表继续过滤它；右键「设为总协调」/「取消总协调」；设置页展示当前总协调。

## 任务拆分

| # | 任务 | 依赖 |
|---|---|---|
| T1 | 域与服务：`coordinator` 字段、`assistant.coordinator.set/get`、三处守卫、迁移（无字段视为 false） | — |
| T2 | UI：置顶行读字段、右键菜单、设置页展示、单聊过滤 | T1 |
| T3 | 提示词：roster + 职责注入 | T1 |
| T4 | 跨队收件箱：协调者 inbox 聚合全队待确认 | T1 |

## 验收

- 设为协调者后：置顶行出现且只有一个；单聊列表不再出现；重启后仍在。
- 再设第二个：旧的自动取消，仍只有一个。
- 归档协调者：被拒绝并给出可执行提示。
- 协调者会话的系统提示包含全部团队与未完成任务摘要。
- 协调者的 inbox 能看到别的队的待确认项。

## 风险

- 改 `assistant_instance` schema 需要迁移；字段可选、缺省 false，老数据不改。
- 提示词注入要控制长度，团队多时按队截断。
- 跨队 inbox 会增加协调者的上下文；先给摘要与计数，不搬全文。
