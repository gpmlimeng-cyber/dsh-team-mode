# 团队线程（群内会话）：与 MausBot 对齐的设计

> 2026-10-27 · 状态：待实施 · 前置：`2026-10-27-dsbot-avatar-alignment.md`（头像已对齐）

## 1. MausBot 的真实结构（读 `SidebarGroupThreadList.tsx`）

```
群（room）
├─ 头部：成员堆叠头像 + 群名 + 最后消息
└─ 展开：线程列表（threads），每行一条对话
         busy / unread / waiting-on-you 状态
         行菜单：重命名 / 删除 / 置顶
```

关键：**成员只出现在堆叠头像里，从不下沉成行**；下沉的是 `group.tasks`（线程），且当群只有一条线程时用 `group.threadId` 兜底，所以永远至少一行。

## 2. 我们现在的结构（不对齐之处）

```
团队（team）
├─ 头部：成员头像簇 ✅（已对齐）
└─ 展开：成员列表 ❌（应该是线程）
         每个成员绑定一个 sessionId，1 成员 = 1 会话
```

我们"成员行"其实就是把 1:1 的那条会话摊平了。要对齐，必须引入**团队级线程**这一层，成员与会话变成 1:N。

## 3. 数据模型

`teamAggregateSchema` 增加可选字段（**不升 schemaVersion**，旧记录无字段照常加载）：

```ts
threads: z.record(nonEmpty, z.object({
  id: nonEmpty,
  title: nonEmpty,
  sessionId: nonEmpty,
  /** 归到哪条线程之外：线程的发言主体（默认 leaderSlotId）。 */
  speakerSlotId: nonEmpty.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})).optional(),
```

**成员的 `sessionId` 保持不动**——它是"成员会话"，用于从团队成员名册/团队页直接进入某人；线程是另外一层。

## 4. 运行时

- 新建线程 = 在团队 workspace 里创建一个 DSH 会话（复用助手线程那条路径：`assistant.thread.create` 背后的会话工厂）；
- 线程会话默认以 **Leader 身份**运行（`speakerSlotId` 缺省 = Leader），这样"群里的助手"是团队的 Leader 而不是某个隐式机器人；
- 线程归档 = 会话移到 retired 列表（与成员归档同语义，不物理删除数据）；
- **成本提醒**：每条线程是一个真实会话，创建要显式（点 ＋ 或 菜单），不能在展开时自动建。

## 5. 传输（新增，参照 `assistant.thread.*`）

```
team.thread.create  { id } -> TeamView         // 建一条线程并返回最新团队
team.thread.rename  { id, threadId, title } -> TeamView
team.thread.archive { id, threadId } -> TeamView
```

命名与形状照抄助手那三条，不发明新风格。

## 6. UI

- **团队行**：保持现状（头像簇 + 群名 + 状态）；
- **展开后**：线程行，复用已对齐的**原生会话行anatomy**（32px / 单行 / 尾部状态或时间 / hover ⋯）；行标题 = 线程标题；hover ⋯ 提供 打开 / 重命名 / 归档；
- **兜底**：没有线程时，用团队主会话渲染一行（与 MausBot `group.threadId` 兜底一致），避免"展开是空的"；
- **成员入口不丢**：团队成员仍在头像簇 + 团队页名册里可达；行菜单里保留"成员"入口；
- **＋ 新建线程**：放在团队行 hover 时（与 MausBot 的 `+` 位置一致）。

## 7. 验收

1. 新建团队 → 展开至少一行（主会话兜底）；
2. 点 ＋ → 出现新行且是真实可打开的会话；
3. 重命名后行标题立刻变；归档后行消失（可在已归档范围找回）；
4. 成员头像簇不受影响；
5. `npm run check` 全绿。

## 8. 分步交付（建议顺序）

```
T1 数据与服务：schema.threads + create/rename/archive + 单测
T2 传输：team.thread.* 三个方法 + 契约测试
T3 运行时：线程会话的真实创建/归档
T4 UI：线程行 + ＋ + 行菜单（复用原生行）
T5 评审
```

T1/T2 可并行（不同文件），T3 依赖 T2，T4 依赖 T2（可先用 mock 契约）。
