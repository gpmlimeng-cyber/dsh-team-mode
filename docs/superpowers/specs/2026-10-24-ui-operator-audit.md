# UI Operator 审计 — 侧栏机器人名册与注意力中心

> Task 1 of `docs/superpowers/plans/2026-10-24-ui-operator.md`。只读审计：本文件之外**没有源码改动**。
> 基线：`npx vitest run` = 58 files / 788 tests 全部通过（2026-10-24）。
> 参照：`docs/superpowers/specs/2026-10-23-team-sidebar-row-design.md`、`docs/superpowers/specs/2026-10-23-global-overview-design.md`、
> `docs/research/assistant/OpenMausBot-UNDERSTANDING.md`（bot = contact，task = thread）、GrokBot Guide 的「一 bot 一职、状态先行、注意力先行、交付物优先」。

## 1. 现状地图

| 表面 | 入口 | 数据 | 请求 | 行 / 状态 |
|---|---|---|---|---|
| 群聊（团队）区 | `SidebarTeamSection`（`src/client/sidebar.tsx:184-189`） | `team.list` | 1 次 + 每次 SSE change | 两行式团队行：name+time / `N 人 · M 运行 · K 待审批`；展开仅看任务（`recentTeamTasks`） |
| 单聊（助手）区 | `AssistantSidebarSection`（`src/client/assistant-sidebar.tsx:131`） | `assistant.instance.list` + `assistant.task.list` | 2 次 + 每次 SSE change | 头像行 + 状态点 + 预览；「待你处理」区含审批卡片 |
| 团队行数据 | `teamSidebarSummary` / `teamSidebarStatusText`（`src/client/team-sidebar-data.ts:98,129`） | 纯函数 | — | 运行 / 待审批 / 等待前置 / 生命周期标签 |
| 成员级投影 | `teamPanelView` → `PanelMember`（`src/client/team-main-agent-data.ts:105-133,135`） | 纯函数 | — | 已有 name/role/model/state/currentTask/completed-total/chips |
| 全局总览 | `GlobalOverview`（`src/client/global-overview.tsx:373`）挂在「详情」tab 的 `<details>` 内（`src/client/team-manage.tsx:54-62`） | `team.list`（外部传入）+ instance/task | 2 次 | 统计 4 项 + 「需要你」列表 + 4 个筛选 + 团队/助手两列 |
| 团队头像 | `teamAvatarTiles/teamAvatarColor`（`src/client/team-avatar.ts`） | teamId + name | — | 2×2 四格方形 mark，`--team-avatar-ink` 走 `TEAM_IDENTITY_COLORS` |
| 成员头像 | `MemberAvatar`（`src/client/member-avatar.tsx`） | name + `assistantSnapshot.avatar` | — | 50% 圆角 + 首字母回退 |
| 原生 Session 行 | `SessionRowHider`（`src/client/session-row-hider.tsx`） | team/instance/task | 3 次 + 每次 SSE change | 成员 Session、助手主/任务 Session 一律隐藏 |

结论：团队行只有「团队」粒度，没有 bot（成员）行；成员 Session 又被原生行隐藏，所以**成员只能经团队行或会话头 `TeamMemberSwitcher` 抵达**——名册不是装饰，它是成员级导航的唯一侧栏入口。

## 2. 插槽与挂载结论

- 已注册（`src/client/index.tsx:99-336`）：`settings.section`、`shell.overlay`×4、`conversation.view`（动态，仅团队 Session）、`conversation.session.header.utilities`×2、`conversation.session.header.lineage`、`conversation.session.header.actions`、`conversation.hero.options`。
- 侧栏可用座位（静态核对 `@deepseek-ai/dsh-client-ui-sidebar` 与 `-workspace`）：`sidebar.workspaces`（single，已被 ui-workspace 占用）、`sidebar.panellist`、`sidebar.toggle.badge`、`sidebar.brand.mark/name`、`sidebar.settings`、`sidebar.footer.action`，以及 Session 行子座位 `sidebar.session.row.leading/hover`、`sidebar.workspaces.session.menu.item/row.action`。**没有“侧栏分区”座位。**
- 因此名册继续走现有 `SidebarPortal` DOM host（`src/client/sidebar.tsx:590-763`）：插到 WorkspaceBrowser 根节点首位，容器宽度 <80px 自行隐藏。不新开 slot、不抢 `sidebar.workspaces`。
- `sidebar.panellist` + layout `main` 是唯一“原生”的新面板路径，但选中即离开会话且要另建主视图，与「不替换会话页」冲突；本次不用。
- `SidebarTeamSection` 已收到 `openSession` 却从未使用（`src/client/sidebar.tsx:184-189`）。名册行点击成员即用它，**无需新管道**。

## 3. 样式与令牌清单

复用即可：`.sidebarTeamSection/Header/RowWrap/Row/Copy/Name/Time/Badge/StateDot/More`（`AgentTeam.module.css:3050-3520`）、两行式 `.sidebarTeamRowWrapTwoLine` / `.sidebarTeamSubtitle`（`:8474-8505`）、头像 `.sidebarTeamAvatar*`（`:10522-10570`）、`.sidebarAssistant*` 行语法（`:3594-3860`）、总览 `.globalOverview*`。

现存问题（本次不修，只约束名册）：

| 问题 | 位置 | 处置 |
|---|---|---|
| 非 DSH 令牌 `--dsw-alias-text-1/3`（渲染为未设置颜色） | `AgentTeam.module.css:5059,5065,5723,5730,5738` | 名册禁止使用；后续统一改 `--dsw-alias-label-*` |
| `--dsw-alias-bg-layer`（合法，但层级别名易混） | `:9177,10181` | 名册用 `bg-layer-1/2` |
| 内联硬编码底色 `light-dark(#ffffff,#17181a)` | `src/client/team-main-agent.tsx:169` | 不在名册范围 |
| `PANE_TINTS` 硬编码 | `src/client/team-parallel.tsx:88` | 不在名册范围 |
| 身份色板硬编码 8 组 `light-dark(...)` | `src/client/team-identity.ts:2-12` | **保留并复用**（团队 mark 与成员身份色），名册头像本身用 `MemberAvatar`，不加第二套色 |

名册允许的令牌集合（写进 CSS 合同测试）：`--dsw-alias-label-primary/secondary/tertiary/quaternary`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-border-l1/l2`、`--dsw-alias-interactive-bg-hover/active`、`--dsw-alias-state-{success,warn,error,business}-primary`、`--dsw-radius-{xs,sm,md}`、`--dsw-focus-ring-{width,color}`。

## 4. 数据不一致（必须由 Task 2/3 收敛）

| # | 症状 | 现状证据 | 决策 |
|---|---|---|---|
| F1 | 「运行」两义：侧栏只数 `member.running`，总览/看板把 `waiting_approval` 也算执行 | `team-sidebar-data.ts:102-105` vs `team-status.ts:6-10` + `global-overview-data.ts:96` | 保留 `isTeamExecuting`（有活动）；总览计数文案由「运行中」改为「有活动」（`title` 说明含待审批），侧栏 `N 运行` 只数在跑成员。两处不再用同一个词表达两种数 |
| F2 | 「等待前置/阻塞」三套判定：侧栏只数 `status==='blocked'`；总览数 `pending/assigned/running/blocked` + 未完成前置；看板面板只数 `pending/assigned` | `team-sidebar-data.ts:107-110`、`global-overview-data.ts:68-73,98-100`、`team-main-agent-data.ts:160-163` | 统一为一条：`OPEN = {pending,assigned,running,blocked}` 且 `unresolvedDependency !== undefined`。侧栏「等待前置」按此计数（当前会漏报 pending/assigned，导致「空闲」假象） |
| F3 | 助手实例 `status:'error'` 在单聊行显示「空闲」 | `assistant-instances.ts:114,131-136` 只看 activity，不读 instance.status；总览 `global-overview.tsx:104-107` 却显示「异常」 | `assistantRowStatusText` 增加实例状态入参：无活动任务且 `status==='error'` → 「异常」+ error tone |
| F4 | 搜索会把待处理藏起来：单聊「待你处理」区与摘要都基于 `visible`（被 query 过滤） | `assistant-sidebar.tsx:196-211,232-245` | 注意力区/计数一律基于**全部未归档**实例；只有行列表受 query 影响 |
| F5 | 首次加载期间假装「空」：两个侧栏区都没有 loading 态，先渲染「新建团队/新建助手」 | `sidebar.tsx:193,386-399`、`assistant-sidebar.tsx:137,658-676` | 增加 `loaded` / `loading` 标志，见 §7 |
| F6 | 团队 `state==='error'|ownership_conflict|delete_blocked'`、成员 `lastRuntimeState==='error'`、`team.warmup.phase==='error'` 不进任何注意力计数 | 侧栏只在副标题拼状态词；总览无此计数 | 新增 `error` 类别（§6），数据全在 `team.list` 内（`lastError` 可做 title） |
| F7 | 依赖语义双规则：`unresolvedDependency` 只认 `completed` 释放；`taskDependencyView` 还把 `cancelled` 当释放 | `team-sidebar-data.ts:86-96` vs `labels.ts:274,281`（服务端 `clearDownstreamBlockers` 在 completed/cancelled 时删除依赖：`team-command-handler.ts:751-754,2141-2153`） | 注意力/名册统一用 `unresolvedDependency`（对历史脏数据保守）；`taskDependencyView` 的差异记为已知债务，不改 |
| F8 | 同一页面重复拉取：侧栏团队/助手、`SessionRowHider`、总览、看板各自 list | `sidebar.tsx:206-221`、`assistant-sidebar.tsx:175-194`、`session-row-hider.tsx:50-68`、`global-overview.tsx:385-406`、`components.tsx:302-390` | 名册/团队注意力**只读已加载的 `team.list`**，不新增请求；合并缓存另行立项 |
| F9 | 状态标签三份拷贝且不全：`labels.TASK_STATE_LABELS` 缺 `running/blocked`；侧栏与面板各自维护一份 | `labels.ts:12-19,39-41`、`team-sidebar-data.ts:41-50`、`team-main-agent-data.ts:51-60` | 名册一律走 `labels.ts`；先补齐 `running/blocked`，再删掉重复表（Task 2 内最小改动） |

## 5. 名册行规格（Task 2 的唯一数据契约）

新增纯函数模块 `src/client/team-roster-data.ts`（无 React、无请求），组合现有投影而不是重算：

```ts
export interface RosterRow {
  teamId: string
  slotId: string
  sessionId: string
  name: string                      // member.displayName
  role: 'leader' | 'member'
  avatar?: string                   // 仅 assistantSnapshot.avatar 的受限 data URL（复用 isAssistantAvatarDataUrl）
  initial: string                   // 1 字回退，MemberAvatar 同规则
  model: string                     // assistantSnapshot.model
  runtimeState: MemberRuntimeState
  statusLabel: string               // memberStatusLabel(runtimeState)
  tone: 'running' | 'waiting' | 'error' | 'starting' | 'idle' | 'offline'
  currentTask?: { id: string; title: string }   // running 最新 → assigned 最新；标题空 → 「未命名任务」
  attention?: 'approval' | 'error'  // 最多一个标记；approval 优先
  progress: { completed: number; total: number } // 自有任务；cancelled 计入 total
  errorText?: string                // member.lastError，仅 error tone
}
export function teamRosterRows(team: TeamView): RosterRow[]
```

规则：

- **顺序**：`memberOrder` 排名 → `joinedAt` → `id`（与 `team-main-agent-data.ts:96-103` 完全一致；该函数导出复用）。
- **来源**：只读 `TeamView.members` / `TeamView.tasks`；无任务 = 无 `currentTask`（不造占位）；无成员 = `[]`。
- **状态词**：`running→运行中`、`waiting_approval→等待审批`、`error→异常`、`starting→启动中`、`idle→空闲`、`offline→离线`（`labels.memberStatusLabel`）。
- **tone**：running→success dot；waiting→warn 徽标（与团队徽标同款）；error→error 文本/点；starting→business；idle/offline→无彩色。
- **计数不为假**：`approval` 只有「此成员停在等待审批」这一事实，**不显示数字**（精确交互数需 `team.workbench.get`，逐团队 = N+1，拒绝）。团队行徽标继续显示待审批**成员数**。
- **点击**：整行是按钮 → `openSession(row.sessionId)`（同一团队内切换成员，不重开团队页）；Leader 行额外 `Leader` 文本（不靠颜色/图标单独表达）。
- **团队行**：保留现有两行状态语法；新增名册容器作为团队行**兄弟**（不在行按钮内），disclosure 带 `aria-expanded`/`aria-controls`，默认见 §8。

## 6. 注意力契约（Task 3 的唯一语义）

类别（`AttentionCategory`）：

| id | 文案 | 单位 | 判定 | 数据来源 |
|---|---|---|---|---|
| `approval` | 待审批 | 团队成员 | `lastRuntimeState==='waiting_approval'` | `team.list` |
| `assistant_input` | 待输入 | 助手任务 | `status==='needs_input'` 且任务/实例均未归档 | instance+task list |
| `blocked` | 等待前置 | 任务 | `OPEN_TASK_STATUSES` 且 `unresolvedDependency!==undefined`（F2） | `team.list` |
| `error` | 异常 | 实体 | `team.state∈{error,ownership_conflict,delete_blocked}` ∨ 成员 `error` ∨ `warmup.phase==='error'` ∨ 实例 `status==='error'` | team/instance list |
| `unread` | 未读 | 助手实体 | 客户端已读状态（`assistant-read-state`） | instance + 本地 |

- **“需要你”列表只含决策项**：`approval` + `assistant_input`（与现有 `isAttention` 一致，`global-overview-data.ts:131-133`）。`blocked`/`error`/`unread` 是状态与筛选，不进需要你列表，避免把「等依赖」冒充「等你点按钮」。
- **去重**：一个实体一条（`team:<id>` / `assistant:<id>`）；同一实体命中多个类别时只在条目上列类别，不重复成行；类别计数 = 该类别下**不同实体数**，条目 meta 才显示成员/任务个数。类别之间可重叠（沿用现有「四项计数不是分区」的说明），同一类别内绝不重复计。
- **排序**：决策量（approval 成员数 / 待输入任务数）降序 → `updatedAt` 降序 → 团队先于助手 → id 升序（沿用 `global-overview-data.ts:144-183`）。
- **动作归属**：审批按钮只在单聊「待你处理」区（`assistant-sidebar.tsx:611-643`）；团队审批只导航到团队，不在侧栏直接处置（现有行为）。名册徽标只做提示。
- **计数归属**：工作区级合并计数只由 `global-overview-data.ts` 产出（侧栏拿不到 assistant 数据时不显示合并总数）；团队级徽标只由 `team.list` 产出。任何计数不因搜索/筛选变化（F4）。

## 7. 加载 / 错误 / 空 状态

| 表面 | loading（无数据） | 错误（无缓存数据） | 错误（有缓存） | 空 | 筛选空 |
|---|---|---|---|---|---|
| 团队区 | `正在加载团队…`，`role="status"`，隐藏「新建团队」行 | `团队数据加载失败：{message}`，`role="alert"` + `重试`，不显示建队行 | 顶部 alert + 保留行 | 现有「新建团队」行 | 现有 `没有匹配的团队` / `暂无历史团队` / `暂无进行中的团队` |
| 名册 | 无（同步派生） | 无 | 无 | `还没有成员`（防御） | — |
| 助手区 | `正在加载助手…`，隐藏「新建助手」 | `助手数据加载失败：{message}` + `重试` | alert + 保留行 | 现有「还没有助手」+ 新建 | 现有 `没有匹配的助手`；注意力区不受 query 影响 |
| 总览 | 现有 StatusCard（`global-overview.tsx:277-282`） | 现有 `团队数据加载失败：…` | 现有顶部 error | 现有 | 现有「当前筛选下没有…」+「查看全部」 |

补充：`team-manage.tsx:57-61` 未传 `teamsLoading/teamsError`（`useAgentTeamData` 已经返回，`components.tsx:302-390`），补传即可让总览不再把「未知」画成 0。

## 8. 移动端与可访问性

- `@media (max-width: 420px)`（沿用 `:8701-8705` 的既有断点）：团队行隐藏相对时间；名册行隐藏 `model` 与 `progress`，缩进降到 34px，**默认收起**；桌面默认展开。展开状态按团队存 `dsh-team-mode:roster-expanded:<teamId>`，与 `dsh-team-mode:sidebar-expanded` 同风格。
- `@media (hover: none)`：名册行「更多」按钮常显（镜像 `:8573-8580`）；不提供只有 hover 才可达的动作。
- 容器 <80px（收成 rail）：宿主隐藏（`sidebar.tsx:683-684`），名册无需处理。
- 键盘：Tab→团队行 Enter 打开团队；Tab→成员行 Enter 打开该成员 Session；disclosure 单独按钮，Enter 展开/收起，`aria-expanded` + `aria-controls`；行按钮内**不得嵌套**按钮（沿用 `sidebarTeamTaskList` 的兄弟结构，`:8622-8690`）。
- 语义：`aria-current="page"` 标当前 Session 对应行；徽标/状态点带文本 `aria-label`（不只靠颜色）；`!` 徽标保留 `role="img"` + label。
- 320px 不溢出：行 `min-width:0` + ellipsis，禁止固定宽度 > 120px 的元素进入名册行；用源码级 CSS 断言守护。

## 9. 测试计划（不加依赖：`react-dom/server` + CSS 源码断言，仓库既有模式）

1. `tests/client-team-roster-data.spec.ts`（新）：顺序（memberOrder/joinedAt/id）、leader/member、currentTask 取 running 后 assigned、空任务无 currentTask、空标题→`未命名任务`、avatar 仅合法 data URL、initial 回退、`approval` 优先于 `error`、`progress` 含 cancelled 分母、`errorText` 仅 error、空成员→`[]`、未知 runtimeState 不抛错。
2. `tests/client-team-sidebar-data.spec.ts` 扩展：F2 新规则（pending/assigned + 未完成前置 → 计数 1；`running` 带未完成前置仍计入）；**跨面一致性**：同一 fixture 下侧栏 approve 数 === `globalOverviewModel.teams[i].approval`；「运行」不再把 `waiting_approval` 计入侧栏数字；状态文案仍不出现「空闲」于有待办时。
3. `tests/client-global-overview-data.spec.ts` 扩展：类别计数（`approval/assistant_input/blocked/error`）、实体多类别只出现一次、归档排除、`error` 计数来自 team.state / member.error / warmup.error / instance.status、类别计数为「不同实体数」。
4. `tests/client-global-overview-panel.spec.ts` 扩展（SSR）：类别筛选按钮与 `aria-pressed`；loading/error 不渲染 0；「有活动」标签与 title；attention 条目唯一。
5. `tests/client-team-main-agent-panel.spec.ts`：若 `teamPanelView` 与名册共用成员投影，断言两者对同一 fixture 的 currentTask/state/completed 一致（防止再长第三套规则）。
6. CSS 合同（放进 1 或 2）：≤420px 名册收起相关类存在 `display:none`；`hover:none` 下更多按钮常显；名册块只出现 §3 白名单令牌（正则扫描名册类块，捕获 `--dsw-alias-text-*` 这类回归）；名册无 `min-width` 大于 120px。
7. 结构断言（SSR / 源码）：disclosure 与成员行是兄弟而非嵌套；`aria-expanded`/`aria-controls` 成对；状态点有 `aria-label`。
8. 收尾：`npm run check`（guard + typecheck + test + build）。

## 10. 边界与拒绝项

- 不新增传输方法、不新增 EventSource、不为名册/注意力新增 list 调用（F8）；`TeamView` 已含全部字段（displayName/role/assistantSnapshot.avatar/lastRuntimeState/lastError/sessionId/tasks.ownerSlotId/status/dependencyIds/updatedAt）。
- 不用 `team.workbench.get` 做侧栏计数（逐团队 N+1）；精确交互明细仍只在当前团队的群聊/看板内。
- 不新建聊天/输入框/消息列表，不替换会话页；名册与注意力都是导航与摘要。
- 不造状态：无任务不显示任务，无审批数字不显示数字，未知（loading）不显示 0。

## 11. 交给 Task 2 / Task 3 的最小改动顺序

1. `src/client/labels.ts`：补齐 `running/blocked`；`team-main-agent-data.ts`、`team-sidebar-data.ts` 删本地表改引用（F9）。
2. `src/client/team-sidebar-data.ts`：导出一份 `OPEN_TASK_STATUSES` 判定（F2），侧栏/总览共用；补 `error` 计数。
3. `src/client/team-roster-data.ts` + `sidebar.tsx` 名册块与 disclosure（含 §7 状态、§8 响应式）；`openSession` 接线。
4. `src/client/global-overview-data.ts`：类别计数 + 去重 + `error` 类别（F1/F6）；`global-overview.tsx` 类别筛选、「有活动」文案；`team-manage.tsx` 传 `teamsLoading/teamsError`。
5. `src/client/assistant-instances.ts` + `assistant-sidebar.tsx`：F3 异常状态、F4 注意力不受 query 影响、加载态。
6. 测试按 §9 落地，最后 `npm run check`。
