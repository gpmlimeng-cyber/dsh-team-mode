# P2 · 线程负责人与五项控制

> 2026-10-29 · 批二产物。词汇基线见 `01-domain.md`：**线程 = 团队里的一条会话，有唯一负责人**；对外不叫「频道」。
> 判定依据只认代码与测试：本文件每一节都能在 `src/domain`、`src/service`、`src/transport`、`src/client` 与 `tests/` 里对上号。

## 1. 结论先行

- **一条线程恰好一个负责人**，负责人是**团队成员 slot id**，不是 Session、不是助手、不是人名。
- 负责人缺省 = **Leader**；旧记录没有该字段时由**读取方**兜底，存储里**不补写**。
- Stop / Resume / Reassign / Archive / Restore 五项控制**只改线程记录**，不动任何 Session：线程的会话历史、成员会话、`createdAt` 都保持原样。
- 不升 `schemaVersion`：新字段可选，旧记录照常打开。

## 2. 数据形状

`teamThreadSchema`（`src/domain/schemas.ts:761`）：

| 字段 | 含义 | 备注 |
|---|---|---|
| `id` / `title` / `sessionId` | 线程身份与它自己的会话 | 批一已有 |
| `speakerSlotId?` | 在该线程发言的成员 | 缺省 Leader |
| `ownerSlotId?` | **唯一负责人**（成员 slot id） | 批二新增，可选 |
| `pausedAt?` | 暂停时间戳（ms） | 批二新增，**存在即暂停**，不另设布尔 |
| `createdAt` / `updatedAt` | 线程时钟 | Archive/Restore 不改 `createdAt` |

不变量：

1. 线程的 `sessionId` 与任何成员的 `sessionId` 互不迁移（`requireUnusedThreadSession`）。
2. 归档不删记录：`threads[id]` → `retiredThreads[id]`，Session 仍进 `listTeamSessionIds` 的回收范围。
3. 旧记录（无 `ownerSlotId` / `pausedAt`）解析通过，版本号仍是 1/2。

## 3. 负责人语义

| 规则 | 落点 |
|---|---|
| 负责人必须是该团队成员 | `assignThread`，非法 slot 抛 `THREAD_OWNER_UNKNOWN`（`src/domain/errors.ts:35`） |
| 缺省负责人 = Leader | 读取侧 `threadOwnerSlotId` = `ownerSlotId ?? leaderSlotId`（`src/service/dsh-team-mode-service.ts:4082`） |
| 旧记录不补写 | 兜底只发生在读取路径：不调用 `updateTeam`、不推进 revision |
| 改负责人不动会话 | `assignThread` 只写 `ownerSlotId` / `updatedAt`，`sessionId`、成员会话、历史都不变 |
| 改负责人可审计 | 每次写推进 team `revision` + 一条 `team.thread_assigned` activity + `team` 变更事件 |
| 负责人离队 | `removeMember` 不清 owner；读取按"显式 owner 仍在成员表，否则 Leader"兜底，UI 不会留空白 |

`speakerSlotId`（谁说话）与 `ownerSlotId`（谁负责）是**两件事**：一个线程可以 Leader 发言、成员负责；批二只补负责人，不改发言路由。

## 4. 五项控制的边界

| 控制 | 写入 | 明确不动 | 拒绝条件 | 可逆 |
|---|---|---|---|---|
| **Stop** | `pausedAt = now`、`updatedAt` | 线程 Session、成员 Session、标题、负责人、历史 | 线程不在活动列表（`THREAD_NOT_FOUND`） | 用 Resume |
| **Resume** | 删除 `pausedAt` | 同上；Session 就是暂停前那一条 | 同上 | — |
| **Reassign** | `ownerSlotId`、`updatedAt` | Session、标题、暂停标记 | slot 不是成员 → `THREAD_OWNER_UNKNOWN` | 再 assign 给别人 |
| **Archive** | 记录从 `threads` 移到 `retiredThreads` | Session（保留给回收清理）、`createdAt`、`ownerSlotId`、`pausedAt` | 线程不在活动列表（`THREAD_NOT_FOUND`） | 用 Restore |
| **Restore** | 记录从 `retiredThreads` 原样搬回 `threads` | 整条记录逐字段不变（Session / `createdAt` / owner / 暂停标记） | 两边都没有该 id（`THREAD_NOT_FOUND`）；已在活动列表 = no-op | — |

补充约定：

- 五项控制都返回 `TeamAggregate`，成功时 team `revision` +1（Restore 的"已活动 no-op"除外，它没有状态变化）。
- **Stop 不是关闭会话**：暂停后线程仍在活动列表里，行上出一个暂停标记，**打开仍可看历史**。暂停是否拦派活属于 runtime 行为，见 §7。
- **Archive 不是删除**：记录和 Session 都还在磁盘上，只是换了列表。
- **Restore 是 Archive 的逆操作**：不重新铸造 Session、不重置 `createdAt`，所以归档期间的历史完整回来。
- 线程状态词仍只有 `active / archived`（`01-domain.md` §4）；`pausedAt` 是叠加在 active 上的标记，不引入第三状态。

## 5. 与 OpenBot 的对照

OpenBot 的 `channel` 是**多人共享频道**：每个频道有自己的 transcript、共享指令、工作目录、响应规则与 Bot 名单（依据 `docs/ASSISTANT-COMPETITORS.md:97`；`00-capability-matrix.md` 第 9 行判定为「共享频道聊天，缺单一任务负责人 + 显式分派」）。

| 维度 | OpenBot channel | 我们的线程 |
|---|---|---|
| 单位 | 频道（多人共享的聊天场所） | 一条团队会话（线程），挂在团队下 |
| 参与者 | 频道里多个 Bot 都能发言 | `speakerSlotId` 指定谁发言（缺省 Leader） |
| 负责人 | 无"唯一负责人"这一层，靠分派任务表达 | **`ownerSlotId` 一条线程一个负责人** |
| 控制 | 归档/删除为主 | Stop / Resume / Reassign / Archive / Restore 五项，全部不动会话 |
| 归档后 | 频道记录移除 | `retiredThreads` 软归档，Session 保留可恢复 |
| 共享配置 | 频道级共享指令、响应规则、工作目录 | 继承团队：团队 workspace、`announcement`、成员表；线程不另立一套配置 |
| 命名 | channel / 频道 | **线程**（`01-domain.md` 明令对外不用「频道」） |

结论：我们**不照搬"多人共享频道"**，只取"以会话为单位"这一层，补上 OpenBot 缺的"单一负责人 + 显式分派"，并把五项控制收敛为对线程记录的操作。频道级共享指令/响应规则/独立工作目录本批不做。

## 6. 传输与界面

| 层 | 事实 |
|---|---|
| 传输 | `team.thread.assign` / `stop` / `resume` / `restore` 四个方法，payload 只带 `id` + `threadId`（assign 另带 `slotId`），空 id 在传输层即拒；业务错误原样透出（`src/transport/contracts.ts:141`、`src/transport/web.ts:662`） |
| 界面 | 线程行显示负责人名（无显式 owner 显示 Leader，不空白）；暂停行带灰点且仍可点开；⋯ 菜单恒列六项，不适用项禁用不隐藏（`src/client/team-member-chrome.tsx:263`） |
| 设置负责人 | 二级菜单列团队成员（头像 + 名字，Leader 带皇冠），当前负责人打勾；选中即 `team.thread.assign` |
| 刷新 | 写操作只调传输，视图靠既有 `subscribeAgentTeam` 重拉 `team.list`，不本地改数组 |
| 旧记录 | UI 与 service 用同一条 `ownerSlotId ?? leaderSlotId` 兜底规则 |

## 7. 已知边界（下一批）

1. **归档视图未做**：会话下拉只列活动线程，所以活动行的「恢复归档」恒为禁用（`src/client/team-member-chrome.tsx:278` 注释写明）。Restore 的服务与传输已就绪，入口在**批四（可见性）**的归档分组里给。
2. **暂停目前是标记**：`pausedAt` 落库、UI 显示、历史可开；runtime 是否据此跳过派活**本批未改**，留给 runtime 批次。
3. **负责人随成员离队**：`removeMember` 不清 `ownerSlotId`，读取侧兜底 Leader；不额外写迁移，避免把删除成员变成跨记录写。
4. **归档线程的会话入口**：`teamOwningSession` 目前不匹配 `retiredThreads`，所以从归档线程的 Session 里看不到切换器——归档行的入口随第 1 条一起做。

## 8. 验证

- 服务：`tests/team-threads.spec.ts`（负责人、暂停/恢复、归档/恢复、旧记录兜底与"不写库"）
- 传输：`tests/transport-contracts.spec.ts`、`tests/transport-web.spec.ts`（四方法形状、非法 payload、`THREAD_OWNER_UNKNOWN` 原样透出）
- 界面：`tests/client-session-switcher.spec.ts`（负责人兜底、六项菜单与禁用态、二级负责人菜单、暂停标记、共用 subscribe 刷新）
- 端到端：`tests/team-thread-owner-e2e.spec.ts` —— 真实 `AgentTeamService` + 真实 `DomainAgentTeamStore` 跑完
  `建团队 → 建线程（默认 Leader） → 改负责人 → 暂停 → 恢复 → 归档 → 恢复归档`，每步断言 revision 与 Session 不变；
  另一条用例把持久记录回退成"没有 `ownerSlotId` 的旧线程"，读出为 Leader 且 `writes=0`、revision 不变。
- 收口命令：`npm run build`、`npm run check`（全仓 94 个测试文件）。
