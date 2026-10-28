# 会话头控件收进 ⋯ 菜单：可行性调查（群聊会话 / BOT 模式）

- 日期：2026-10-28
- 状态：调研结论（只读，不改任何代码）
- 范围：**群聊/团队会话**的会话页标题区（不是普通助手会话、不是工作区 landing）
- 证据基线：DSH `0.2.1-rc.2`，宿主 bundle 为 `/Applications/DSH NEXT.app/Contents/Resources/app.asar`。
  下文 `app.asar!` 前缀即该 asar 内的路径（`app.asar!/node_modules/@deepseek-ai/...`）；
  这些包不在本仓 `node_modules` 里，用只读 asar 解包脚本读取（见文末“复核方法”），未修改任何宿主文件。
- 结论前置：**A（往原生 ⋯ 加菜单项）不可行；严格意义上的“三项搬进原生 ⋯”= C。
  B（自建 ⋯ + 隐藏原生控件）可做，但只有“后台任务”一项值得做，“子智能体”是降级复刻，
  “Agent 预设”根本不是可切换控件（宿主只给只读标签）。**

---

## 1. 三类控件的真实归属

会话头本体由 `conversation` 包渲染：标题行 = `.titleRow`（`app.asar!/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:17993`），
其中 `.titleCluster`（:17995）承载面包屑 + `headerActions` 槽（:18032-18034），
右侧 `.headerUtilities`（:18036-18038）与 `.headerCorner`（:18039-18042）。
`conversation.session.header` 作为 single 槽**只声明四个子槽**，没有更多菜单槽：

| 子槽 | kind | scope | 依据 |
| --- | --- | --- | --- |
| `conversation.session.header.lineage` | single | session | `.../dsh-client-ui-conversation/lib/client.js:19850-19854` |
| `conversation.session.header.actions` | list | session | 同上 `:19855-19858` |
| `conversation.session.header.utilities` | list | session | 同上 `:19859-19862` |
| `conversation.session.header.corner` | single | session | 同上 `:19863-19866` |

三类控件的归属与注册方式（**都走槽，不是硬编码在 header 里**）：

| 控件（截图文案） | 渲染包 | 注册点（槽 / id / order） | 组件与渲染条件 |
| --- | --- | --- | --- |
| Agent 预设模式（`标准模式` 胶囊） | `@deepseek-ai/dsh-client-ui-agent-preset` | `conversation.session.header.actions` / `agent-preset` / `order:-10`。`app.asar!/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js:2407-2413` | `AgentPresetLabel`（`:1001`）；`projectionValues.agentPreset` 存在才渲染（`:1004-1014`）。**只读**：组件注释明确“session 的组合在对话开始后固定，提供控件等于承诺一个宿主会拒绝的切换”（`:990-996`） |
| 子智能体选择器（`2 个子智能体 ⌄`） | `@deepseek-ai/dsh-client-ui-subagent` | `actions` / `subagent-catalog` / `order:10`。`app.asar!/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js:983-990` | `SubagentCatalogAction`（`:611-621`）→ `CatalogDropdown`（`:356`）。仅 root session，且 `subagentCatalog` 有条目或读取失败才显示（`:495`）；触发器是 `aria-haspopup="tree"` 的按钮（`:538-575`），菜单是 body 挂载的 336px 递归树（`:12`、`:576-600`） |
| 后台任务选择器（`N 个后台任务 ⌄`） | `@deepseek-ai/dsh-client-ui-jobs` | `actions` / `job-list` / `order:20`。`app.asar!/node_modules/@deepseek-ai/dsh-client-ui-jobs/lib/client.js:627-640` | `JobListAction`（`:323`）；无任务行时返回 null（`:407`）；触发器仅有动态 `aria-label`（`:459-465`），弹层是 `MenuSurface`（`:492` 起） |

补充：三个包都注册进 `actions` 这个 list 槽，**槽渲染器不给单个条目任何 DOM 标记**（见第 4 节）。

---

## 2. ⋯ 更多菜单：谁渲染、能不能加项

**归属**：`@deepseek-ai/dsh-session-log-export`，注册到 `conversation.session.header.utilities`，
id `session-log-download`，`order` 默认 0（`app.asar!/node_modules/@deepseek-ai/dsh-session-log-export/lib/client.js:291-308`）。

**构成（硬编码，无扩展点）**：

- `Menu` 的 `items` 只有两项：`download`（`:203-207`，busy 时 disabled）与 `feedback`（`:208-211`，仅当 `feedbackUi` 服务存在时加入，`:281-287`）。
- 触发器是 `aria-label = t("header.more")` 的图标按钮（`:216-226`；中文文案 `更多操作`，`:238`），样式类 `QBnHBq_moreButton`（`:173`、`:182`）。
- 选择回调直接 `openFeedback(sessionId)` 或 `request(sessionId)`（`:212-215`），`request` 最终调 `sessionLogDownload.download`（`:301`）。

**有没有“加菜单项”的公开槽：无。**

- 宿主声明只有第 1 节那四个子槽（`dsh-client-ui-conversation/lib/client.js:19850-19866`）；
- 全 bundle 检索 `session.header.more` / `header.more` / `more.actions` 仅命中该按钮的 `aria-label` 与 locale，没有任何 slot 名；
- 客户端槽目录里 `utilities` 的 occupant 只有 `schedule-catalog`、`session-log-download` 等独立条目，没有“菜单项”这一级
  （`app.asar!/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:3999-4060`）；
- 槽 API 也没有“移除/替换别人的 list 条目”的公开方法：只有 `register`（`app.asar!/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js:163-198`）与只读的 `entriesOfSlot`（`:279-300`），
  `abdicated` 只用于条目崩溃自愈（`:453-459`）。

结论：**原生 ⋯ 不提供加项能力，也没法从外部替换它的 items。**

---

## 3. 没有加项槽时，自建 ⋯ 需要哪些公开 API

自建菜单本身没有障碍：`Menu` / `MenuSurface` / `MenuItemButton` 都在
`@deepseek-ai/dsh-client-ui-primitives` 公开导出（`dsh-team-mode/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js:12581` 导出列表；本仓已在用 `Menu`，见 `src/client/team-member-chrome.tsx:2-9`）。

难的是“把三项功能搬进去”：

| 目标动作 | 公开 API 是否存在 | 依据 | 结论 |
| --- | --- | --- | --- |
| 切 Agent 预设（`setPreset` 之类） | 有 Remote `agentPresets/select(sessionId, presetId)`，但**宿主对已开始会话直接拒绝** | Remote 生成：`app.asar!/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js:783`；参数名 `agentId`：`.../dsh-agent-preset-registry/lib/typert.remote-client.js:90-101`；宿主实现与拒绝：`.../dsh-agent-preset-registry/lib/index.js:750-758`（`agent-preset/locked` / `This session has already started`）；客户端调用：`.../dsh-client-ui-agent-preset/lib/client.js:2079`；UI 注释：同文件 `:990-996`、`:945`（“本任务的 Agent 预设，在任务开始时确定”） | **不可用**（对群聊这类已开始会话）。只有空白会话（未产生第一轮）可切；群聊头里的胶囊是“已定组合”的只读展示 |
| 打开子智能体列表（公开 panel / tab id） | **没有“列表”面板或 tab id**；只有单个子会话的右侧栏 tab kind `subagentchat` | tab 注册：`.../dsh-client-ui-subagent/lib/client.js:817-828`；打开子会话：`openChild` / `openChildAside`，`kind:"subagentchat"`（`:965-971`） | **原生列表不可编程打开**。自建列表可行：数据在公开 `sessions` 服务里 —— `projectionsBySession[*].values.subagentCatalog`（组件同款读法 `:363`、`:388`），`sessions.list` 快照结构见 `.../dsh-api-session-controller/lib/types/client/sessions/service.js:165-166`，`subagentAddress(id)` `:239-241`，`refreshProjections` `:246-248`；本仓已注入 `sessions`（`src/client/index.tsx:62`）。代价：原生树的嵌套展开、token/时长统计、行尾“在侧栏打开”需要自己复刻（`.../dsh-client-ui-subagent/lib/client.js:164-340`） |
| 打开后台任务面板 | **没有面板**；原生就是 header 下拉。数据服务 `ctx.jobs` 公开 | `ctx.jobs` 服务：`.../dsh-api-job-controller/lib/client.js:205`（`super(ctx, "jobs")`）、`kill/watchRows/observe` `:217-235`；文档说明 `ctx.jobs` 是唯一 roster：`.../dsh-api-job-controller/README.md:30`；原生弹层：`.../dsh-client-ui-jobs/lib/client.js:492` 起 | **自建可行**：菜单项显示计数，点开自建弹层，用 `watchRows` 拿行、`kill` 停止。复刻成本中等；若不实现“展开行看输出流”（`observe`），就是明确的能力降级 |
| 用 `layout.selectPanel('schedules')` 替代后台任务 | **不是同一个东西** | `schedules` = 自动化任务主面板：`.../dsh-client-ui-schedule/lib/client.js:7363`（`PANEL_ID = "schedules"`）、`:7475`/`:7487`；本仓用法 `src/client/assistant-detail.tsx:467`、`src/client/index.tsx:196`。后台任务是 `job.list` 流（`.../dsh-api-job-controller/README.md:12`、`:26`） | **不能替代**：数据和页面都不同（schedule.catalog vs job.list） |
| 保留“下载 Session 日志 / 反馈” | 公开服务都在 | `ctx.provide("sessionLogDownload", controller)`：`.../dsh-session-log-export/lib/client.js:271-273`；`feedbackUi`：`.../dsh-client-ui-message-feedback/lib/client.js:808-811`（原生菜单就是这样拿的：`:281-287`、`:305`） | 自建 ⋯ 可以无损接管这两项（本仓已有 `ctx.get('remote.schedule')` 式取服务先例，`src/client/index.tsx:185-198`） |

注意：如果只隐藏三个控件、不接管原生 ⋯，那三项仍然进不了 ⋯；如果接管 ⋯ 却把原生 ⋯ 留在原地，会出现两个 ⋯。
所以 B 的完整形态必然是：**自建 ⋯（接管下载/反馈） + 隐藏原生 ⋯ + 隐藏三类控件**。

---

## 4. 隐藏原生控件：钩子与脆弱性

槽渲染器的 outlet 只有 `data-slot="<槽名>"`（`display:contents`，不进布局），
list 条目**没有** `data-slot-id` / `data-entry` 之类的标记：
`app.asar!/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1116-1126`；会话头出口 `.../dsh-client-ui-conversation/lib/client.js:18033`。

| 控件 | 稳定钩子 | 只能猜的写法（脆弱） | 宿主升级后的表现 |
| --- | --- | --- | --- |
| Agent 预设标签 | **无**（`<span>`；没有 `aria-label`、没有 `data-*`） | hashed CSS 类 `f8BMvq_label`（`.../dsh-client-ui-agent-preset/lib/client.js:972`、`:983`、`:1014`），或 `title` 文案（`:1015`，随 preset 描述/本地化变化） | 类名一换，标签重新出现；且它没有语义钩子，只能靠 class / 结构位置，属于**脆弱隐藏** |
| 子智能体触发器 | 语义属性较可靠：`button[aria-haspopup="tree"]` + `aria-label`（“N 个子智能体”，运行中为“N 个子智能体，正在运行”），且位于 `[data-slot="conversation.session.header.actions"]` 内 | hashed 类 `_3K3mEa_trigger`（`.../dsh-client-ui-subagent/lib/client.js:12`）；`aria-label` 文案在 `:541-543`、locale `:876-880` | 宿主换弹层语义或改文案时失效；**语义钩子仍优于 class**，但非契约 |
| 后台任务触发器 | 弱：只有动态 `aria-label`（“{n} 个后台任务运行中 / {n} 个后台任务”，`:527-529`），**无** `aria-haspopup` | hashed 类 `.../dsh-client-ui-jobs/lib/client.js:461` | 文案/本地化一改就失效，属于**脆弱隐藏** |
| 原生 ⋯ 按钮 | 弱：`aria-label` = 本地化 `更多操作` / `More actions`（`:220`、`:238`） | hashed 类 `QBnHBq_moreButton`（`:173`） | 同上，脆弱 |

现有同类做法可参照本仓 BOT 侧栏的“隐藏原生节点”：用自有 `data-dsh-bot-hidden` 标记 + MutationObserver 恢复/重标
（`src/client/sidebar.tsx:1277-1290`、`:1378-1390`、`:1498-1550`），CSS 里也已出现 `[class*="headerActions"]` 这类“按类名片段匹配”
（`src/client/AgentTeam.module.css:7049-7056`）——它今天能用，但同样随宿主类名变化而失效。
建议：若走 B，隐藏逻辑加一个“探针”：找不到目标节点时在控制台/诊断处告警，避免宿主升级后控件静默重现而无人发现。

---

## 5. 总表：能力 × 能不能做 × 依据 × 风险

| 能力 | 能不能做 | 依据（文件:行号） | 风险 |
| --- | --- | --- | --- |
| 往原生 ⋯ 加菜单项 | **否** | `.../dsh-client-ui-conversation/lib/client.js:19850-19866`（只声明 4 子槽）；`.../dsh-session-log-export/lib/client.js:197-212`（items 硬编码） | 无路径；除非宿主新增槽 |
| 自建 ⋯ 并接管下载/反馈 | 是 | `.../dsh-session-log-export/lib/client.js:271-273`、`.../dsh-client-ui-message-feedback/lib/client.js:808-811` | 必须同时隐藏原生 ⋯，否则双菜单；隐藏靠 class/本地化文案（脆弱） |
| 隐藏 Agent 预设标签 | 是（脆弱） | `.../dsh-client-ui-agent-preset/lib/client.js:972`、`:983`、`:1014-1015` | 无 aria/data-*；宿主改类名 → 标签重现 |
| 隐藏子智能体触发器 | 是（较稳，非契约） | `.../dsh-client-ui-subagent/lib/client.js:541-543` | 依赖 `aria-haspopup="tree"` 语义；改属性/改结构即失效 |
| 隐藏后台任务触发器 | 是（脆弱） | `.../dsh-client-ui-jobs/lib/client.js:459-465`、`:527-529` | 依赖动态本地化文案；改文案即失效 |
| 菜单里显示 preset 名 | 是 | `projectionValues.agentPreset`：`.../dsh-client-ui-agent-preset/lib/client.js:1004-1014`；`sessions.list`：`.../dsh-api-session-controller/lib/types/client/sessions/service.js:165-166` | 无（只读数据） |
| 菜单里切 preset | **否**（已开始会话） | `.../dsh-agent-preset-registry/lib/index.js:750-758` | 宿主显式 `agent-preset/locked`；不要做“看起来能切”的控件 |
| 菜单里列子智能体 | 是（复刻） | `.../dsh-client-ui-subagent/lib/client.js:363-388`；`sessions` 服务 `.../dsh-api-session-controller/lib/types/client/sessions/service.js:165-166`、`:239-241` | 原生树（嵌套/token/时长/侧栏打开，`.../dsh-client-ui-subagent/lib/client.js:164-340`）不复刻即降级 |
| 菜单里打开子会话 | 是 | `.../dsh-client-ui-subagent/lib/client.js:965-971`；右侧栏 kind `subagentchat` `:817-828` | 需自己构造 `{parentSessionId, childSessionId, mode}` address |
| 菜单里打开后台任务列表 | 是（自建弹层） | `.../dsh-api-job-controller/lib/client.js:205`、`:217-235`；`.../dsh-api-job-controller/README.md:30` | 无 panel id；不复刻输出流则丢掉“展开看输出/停止”的完整能力 |
| 用 `layout.selectPanel('schedules')` 代替后台任务 | **否** | `.../dsh-client-ui-schedule/lib/client.js:7363`；`src/client/assistant-detail.tsx:467` | 不同面板、不同数据源 |

---

## 6. 推荐方案

**推荐：先不搬（保留原生），把“B 的收敛版”作为可选，同时向宿主提 A。**

1. **A（公开槽）= 上游最优解，本仓内不可得。** 请在宿主侧新增一个
   `conversation.session.header.more`（list, scope:session）或让 `session-log-export` 的菜单从槽里读 items。
   一旦有该槽，三项都能以普通列表项接入，无需任何隐藏。
2. **B 的收敛版（如果产品坚持本仓内解决）**：
   - 只搬 **后台任务**：自建 ⋯ 菜单项显示计数，点开自建弹层，数据走 `ctx.jobs`（`watchRows` / `kill`）。
     不接管“展开输出流”就明确记为能力降级。
   - **不搬子智能体**：原生菜单是带嵌套与统计的树，自建只能做“直接子会话扁平列表 + 打开”，
     属于功能缩水；若必须要搬，先确认产品接受缩水。
   - **Agent 预设不搬**：它不是控件（`:990-996`、`:945`），搬进菜单只能显示名字。
     真要减负，只需隐藏标签（脆弱隐藏，见第 4 节），不需要菜单项。
   - 自建 ⋯ 必须接管 `下载 Session 日志` + `反馈`（`:271-273`、`:808-811`），并隐藏原生 ⋯；否则双菜单。
   - 隐藏逻辑加探针告警（宿主升级后类名/文案变化会让控件重现）。
3. **C 的适用面**：如果验收口径是“必须出现在**原生** ⋯ 菜单里”，答案就是 **C（卡点：宿主没有加项槽，且不接受外部替换 items）**。

一句话判定：**“三项都进原生 ⋯”= 做不了（C）；“本仓自建 ⋯ 收后台任务”= 可做（B）；子智能体与预设搬进去只会降级或只是换个地方显示。**

---

## 7. 成员选择器（BOT 模式下应去掉，不是改造）

口径：BOT 模式下群聊不需要切换成员，所以这个选择器应当**去掉**。以下只回答三件事。

### 7.1 它是谁渲染的：**我们插件自己**

| 证据 | 文件:行号 |
| --- | --- |
| 组件 `TeamMemberSwitcher` | `src/client/team-member-chrome.tsx:79` |
| 注册进 `conversation.session.header.actions`，id `dsh-team-mode-member-switcher`，`order:20` | `src/client/index.tsx:420-428` |
| 胶囊按钮（头像首字母 + 名字 + Leader 皇冠 + chevron） | `src/client/team-member-chrome.tsx:184-200`，`aria-label` 在 `:187` |
| 旁边 ＋ 按钮（`aria-label="添加成员"`，与胶囊共用外框） | `src/client/team-member-chrome.tsx:212-227`；外框样式 `src/client/AgentTeam.module.css:6458-6487` |
| 定位到标题簇最右（宿主 `headerActions` 内） | `src/client/AgentTeam.module.css:7049-7056` |

宿主没有渲染它，也没有对应的宿主控件；截图里的胶囊和 ＋ 都来自上面这段代码。
因此“BOT 模式下去掉”是**改我们自己的注册/渲染**，不需要 DOM 隐藏。

### 7.2 去掉会不会丢功能

它除了“切换”还有这些能力：

| 能力 | 依据 | 去掉后是否还有替代入口 |
| --- | --- | --- |
| 跳到某个成员的 Session（并强制该会话停在 Chat 视图） | `openSession(member.sessionId)`：`src/client/team-member-chrome.tsx:177-178`；`keepChatView`：`:68-76`（写 `dsh.conversation.<id>` 的 view） | 有：**团队面板**的成员行点击即打开成员会话（`src/client/index.tsx:269-272`、`src/client/team-main-agent.tsx:104`、`:214-215`），且团队面板只在 BOT 模式出现（`src/client/index.tsx:283-287`） |
| 显示当前成员名 + Leader 标记 | `:187`、`:198` | 有：团队面板成员行同样显示名字/状态（`src/client/team-main-agent.tsx:100-120`） |
| 底部“管理团队”快捷项（跳到团队管理 tab） | `src/client/team-member-chrome.tsx:158`、`:160-176` | 有：“详情”tab（`TeamManageView`）本身就在会话视图里（`src/client/team-manage.tsx:19-20`、`:84`） |
| ＋ 添加成员（打开助手搜索列表，`team.addMember`） | `src/client/team-member-chrome.tsx:118-126`、`:212-227` | 有，但**不是同一位置**：“详情”页 `TeamCard` 头部的“添加助手”会打开同一个添加流程（`src/client/team-manage.tsx:84` → `src/client/teams/TeamPanel.tsx:459-469`，对话框标题 `:717`、提交 `:691-698`）。**该 ＋ 不是唯一入口** |

结论：去掉**不会丢失数据或不可替代的能力**；丢的是“标题栏一键跳成员 / 一键加成员 / 一键进管理”的快捷入口。
若产品仍想保留“加成员”动线，可以只去掉胶囊、保留 ＋（两者虽然是同一个 `teamSwitcherGroup`，但结构上可分拆，`:152-227`）。

顺带说明语义，避免误读：

- 它不是“当前发言者”切换器，也不改本轮任务归属；点击只做 Session 导航 + 记住 Chat 视图（`:177-178`）。
- 群聊线程真正的 `speakerSlotId` 是**线程创建时**写入的字段（默认 Leader），本仓没有“改 speaker”的传输命令：
  字段定义 `src/domain/schemas.ts:701-711`，创建校验 `src/service/dsh-team-mode-service.ts:3229-3245`，
  线程创建时取 Leader `src/runtime/team-runtime.ts:863-906`；`contracts.ts` 里没有 update-speaker 命令。
- 它列出的集合 = **团队成员**（`sortedMembers(team.members)`，`:61-67`），不是宿主“会话参与者”：
  只有当前 Session 命中某个 `member.sessionId` 才渲染（`useMembership`，`:31-60`），
  所以团队线程 Session（`team.thread.create` 创建的另一个 Session）上它根本不出现。两者不是一回事。

### 7.3 隐藏稳定性 / 判定

它是我们自己的 DOM，**不需要宿主钩子**：BOT 模式下按 `useSurfaceMode()`（`src/client/sidebar.tsx:179`）在注册处卸载或组件内 `return null` 即可；
它自身的 `aria-label="切换团队成员，当前 X"`（`:187`）与 `.teamSwitcher*` 类（`AgentTeam.module.css:6166`、`:6458`、`:6469`）都由本仓维护，不受宿主改类名影响。

**判定：去掉安全。** 不丢功能（仅失去标题栏快捷入口，团队面板/详情页均有替代）；无需隐藏技巧，也无“宿主改类名后重现”的风险。
如果选择保留 ＋，把 `teamSwitcherGroup` 拆成独立按钮即可（样式与逻辑已分开，`:184-227`）。

附（仅当以后要做下拉时）：成员名字/角色/状态可从 `teamPanelView(team).members` 取（`PanelMember`：`src/client/team-main-agent-data.ts:13-27`、`:130-150`），
但**头像不在 PanelMember 里**；头像要用原始 `TeamView['members'][*].assistantSnapshot.avatar`（`src/domain/schemas.ts:71-85`、`:519-549`），
渲染用现成的 `MemberAvatar`（`src/client/member-avatar.tsx:5-27`）。

---

## 复核方法（只读）

1. 读 asar：`app.asar` 头部为 `uint32 @0=4`、`uint32 @4=headerPickleSize`、`uint32 @8=headerJsonSize`，数据区从 `12 + headerPickleSize` 开始；
   按 header JSON 的 `offset`/`size` 取文件即可（本次未落盘修改任何宿主文件，仅在 `/tmp` 解出只读副本）。
2. 版本核对：上述各包 `package.json` 均为 `0.2.1-rc.2`；宿主升级后行号会漂移，结论需按包名 + 语义重新核对。
3. 槽清单核对：`.../dsh-cordis-client-runner/lib/client.js` 的客户端槽目录（`conversation.session.header.*` 段）与
   `.../dsh-client-ui-conversation/lib/client.js:19850-19866` 的声明一致，可交叉验证“没有 more 菜单槽”。
