# Native UI 适配 · T1 基线审计

> 2026-10-27 · 只读审计，无产品代码改动。
> 依据：`docs/superpowers/plans/2026-10-27-native-ui-adaptation.md`。
> 审计对象：`src/client` 全部 `createPortal` / `document.body.append` / `position: fixed` /
> 全局 `z-index`，以及承载它们的侧栏宿主与原生 Slot。

## 0. 结论摘要

1. 计划里的「17 处」把 portal、body 宿主、观察者和 CSS 混在一起计数。按可替换的**浮层**
   实际是：6 个 React portal（4 个进 body 层：2 个直接 `document.body`、2 个进 body 宿主；
   另 2 个进宿主容器）、2 个 body fixed 宿主、7 条 CSS `position: fixed`
   （`AgentTeam.module.css` 6 条 + `ConversationColumn.module.css` 1 条），
   另有 1 处内联 fixed 重复覆盖主 Agent 面板。
2. 「团队/助手列表 body portal」这条现状描述已过期：两个列表已经渲染在
   `[data-slot="sidebar.workspaces"]` 的容器内（`#dsh-team-mode-sidebar-host`），
   真正的 body 浮层只剩**模式行**与**Chief/总协调行**。T2 不需要重写列表挂载。
3. 37 处插件弹窗已经统一走 `AnimatedModal` → 宿主 `Modal`（focus trap、Escape、
   backdrop、`aria-modal`、z-index 1000）。T3 不需要重做这批，只需收口 4 个非 Modal
   浮层 + 1 个 mention 气泡：新建对话面板、添加成员面板、头像编辑器、放大对话、
   @ 提及。
4. 自定义 `z-index` 最大 91，**没有 >1000**；1000/1100 属于宿主 `Modal`/`Menu`。
   计划里「不再出现 >1000 的全局 z-index」对插件自建层本来就不成立，问题在布局权，
   不在数值。
5. 两个 body 宿主（`#dsh-team-mode-brand-host`、`#dsh-team-mode-steward-host`）在
   `SidebarPortal` 的 effect cleanup 里**没有移除**，只在页面刷新时消失（宿主泄漏）。
6. 未挂载的死代码：`AgentTeamOverlay` / `FloatingTeamLauncher`（fixed z-index 30）
   已无注册点，可直接删除，不属于迁移工作。

## 1. 方法与证据

静态证据：

```text
grep createPortal / document.body / position: fixed / z-index / zIndex
grep data-slot / data-dsh-* / role="dialog" / AnimatedModal
读取 DSH 原生 ui-sidebar、ui-primitives 的 slot 注册与 DOM/CSS
```

视觉证据（历史截图，只作布局佐证；生产 3080 的 token 已轮换，当前无法从本机再取图）：

```text
/tmp/e2e-screens/real-final-mobile.png   390x844@2x，BOT 模式抽屉打开：模式行 + Chief + 团队/助手列表
/tmp/e2e-screens/real-scrolled.png       同尺寸，抽屉内滚动后：团队行从模式行下方穿过/被裁切
/tmp/e2e-screens/blank-real.png          同尺寸，模式行与 Plugins 之间的空白带
/tmp/e2e-screens/inline-mobile-final.png 同尺寸，宿主 Modal 打开时模式行被遮罩正确压住
```

上述截图由 `/tmp/e2e/{real-check2,real-scroll,blank-check}.mjs` 通过 CDP 生成，探测对象正是
`#dsh-team-mode-brand-host` 与 `#dsh-team-mode-steward-host`，与本审计的 DOM 结论一致。
截图时间 2026-10-26，之后的提交只改了分组 brief/提示词，没有改模式行与 Chief 布局。
桌面端当前没有可用截图，T2 开工前应先按 §5.5 的协议补拍桌面基线（在改动前拍）。

## 2. 浮层清单（迁移对象）

### 2.1 React portal（6 处）

| # | 位置 | 挂载目标 | 用途 | 依赖 / 副作用 | 处理 |
|---|---|---|---|---|---|
| P1 | `sidebar.tsx:2165-2293` | `#dsh-team-mode-brand-host`（body，fixed z-50） | 模式行：DeepBot 切换 + 搜索 + 筛选 + 新建 | `.logoRow` / `.brand` rect、`brandColumnOffset`、`[data-dsh-team-mode="sidebar"]` rect、body MutationObserver、resize | **T2 改为侧栏根内局部 header** |
| P2 | `sidebar.tsx:2305-2318` | `#dsh-team-mode-sidebar-host`（`[data-slot="sidebar.workspaces"]` 容器首子节点） | 群聊区 + 单聊区 | `WorkspaceBrowser` 根、`data-dsh-team-scroll`、内层滚动塌平 | **保留**（已在侧栏容器内，不是 body） |
| P3 | `assistant-sidebar.tsx:976-981` | `#dsh-team-mode-steward-host`（body，fixed z-5） | Chief/总协调行，固定在原生「新会话」按钮盒上 | `useStewardHost` 轮询 180 帧、`coordinatorAssistant`、`[class*="_newSession"]` rect/隐藏 | **T2 移入团队列表正常流** |
| P4 | `team-parallel.tsx:329-368` | `document.body`（fixed z-60） | @ 提及候选面板 | 触发器 rect、`window.resize/scroll` 关闭、列表键盘 | **T3 换宿主 `Menu`**（portal 定位） |
| P5 | `team-parallel.tsx:603-717` | `[data-team-parallel-anchor]`（会话内容内） | 多成员并行墙 | `shell.overlay`、`TeamParallelView`、`data-conversation-content` 选择器 | **保留**（容器内绝对定位，非 body） |
| P6 | `new-chat-panel.tsx:93-110,187` | `document.body`（fixed z-60） | 「跟谁聊」搜索 + 新建 + 助手列表 | anchor rect 计算、Escape/外部点击、自动聚焦 | **T3 换宿主 `Menu`**（带搜索的自定义内容）或 `AnimatedModal` |

### 2.2 body 宿主 / append

| 位置 | 内容 | 依赖 | 处理 |
|---|---|---|---|
| `sidebar.tsx:1640-1649` | 创建 `#dsh-team-mode-brand-host`：`position:fixed; z-index:50; transform:translateY(-50%); body.append` | `rect`/`teamRect`/`titleLeft` 每帧计算（`1651-1679`） | T2 删除 |
| `sidebar.tsx:1690-1705` | 创建 `#dsh-team-mode-steward-host`：`position:fixed; z-index:5; body.append`；非 team 模式或没有 `.newSession` 时 `remove` | `.newSession` rect；`syncBotSidebar` 用 `visibility:hidden` 保留盒子 | T2 删除 |
| `sidebar.tsx:2013-2018` | 导出会话日志的临时 `<a>` | 浏览器下载需要真实 DOM | 保留（非视觉浮层） |
| `sidebar.tsx:1800-1813` | cleanup | 只 `current?.remove()`，**未移除 brand/steward 宿主** | T2 顺手修泄漏 |
| `assistant-sidebar.tsx:184-202` | `useStewardHost` rAF 轮询 | 宿主晚于 3s 出现则 Chief 永不渲染 | 随 P3 去掉 |

`document.body` 上的 MutationObserver（仅列与本主题相关）：

```text
sidebar.tsx:1798  模式行/Chief/团队宿主布局（T2 可随宿主一起简化）
sidebar.tsx:1887  Workspace 折叠按钮注入
sidebar.tsx:1970  footer 动作重排
sidebar.tsx:2066  原生行菜单注入「导出会话日志」
sidebar.tsx:2146  sidebarScrollArea 组装
index.tsx:101     当前会话 id
session-row-hider.tsx:70 / team-trigger-enhancer.tsx:322 / team-parallel.tsx:530 / WorkspacePanel.tsx:384
```

这些观察者不是浮层本身，但 T2 删除 P1/P3 时不要误删其余 DOM 适配逻辑。

### 2.3 CSS `position: fixed`（7 条）与内联 fixed

| 选择器 | 位置 | z-index | 用途 | 归属 / 处理 |
|---|---|---|---|---|
| `.floatingTeamLauncher` | `AgentTeam.module.css:8-12` | 30 | 悬浮团队入口 | **死代码**（`AgentTeamOverlay` 无注册点，`components.tsx:456`）→ 删除 |
| `.conversationFocusBackdrop` | `:2829-2832` | 90 | 放大对话遮罩 | T3：随 `.conversationColumnExpanded` 一起改 headless `Modal` 或工作台内局部放大 |
| `.newChatPanel` | `:4235-4237` | 60 | P6 面板 | T3 删除 |
| `.memberAddScrim` | `:6824-6827` | 60 | 添加成员遮罩 | T3 删除，换 `Menu` |
| `.memberAddPanel` | `:6830-6834` | 61（absolute） | 添加成员面板 | T3 删除，换 `Menu` |
| `.teamMentionPopover` | `:7295-7297` | 60 | P4 提及面板 | T3 删除，换 `Menu` |
| `.mainAgentPanel` | `:9758-9762` | 40（内联覆盖为 60，`team-main-agent.tsx:168-176`） | 右侧执行面板 | 不属 T2/T3；T4 接 `sidebar.right` 或会话分栏 |
| `.conversationColumnExpanded` | `workbench/ConversationColumn.module.css:43-45` | 91 | 放大对话 | 与遮罩同一处 T3 |

允许保留的 `fixed`：宿主 `Modal`（1000）与宿主 `Menu` portal（1100）。它们由 DSH 管理，
插件不写坐标、不写层级。

### 2.4 局部 z-index（不需要全局迁移）

```text
AgentTeam.module.css
  1  :5074 .sidebarAssistantActions（触屏行内动作）
  1  :6050 .teamParallelAnchor（会话内容内的并行墙）
  1  :12343 .sidebarPartition 拖拽落点标记
  6  :901/.skillsInfoPopover、:1069/.contextUsagePopover（列内气泡）
  7  :6326 并行 pane composer sticky
  12 :741 composerTriggerMenu（列内候选）
  30 :6355 .teamWarmupOverlay（并行墙内部）
  30 :12456 .avatarEditor（弹窗内部）
ConversationColumn.module.css 同上（12/6/6）
```

这些都在各自局部 stacking context 内，T2/T3 不动。

### 2.5 弹窗现状（T3 的对照面）

```text
37 处 <AnimatedModal>：sidebar 2、team-dialogs 3、TeamPanel 15、AssistantPanel 6、
  assistant-dialogs 1、assistant-task 1、assistant-checkpoint 1、sidebar-group-ui 6、
  assistant-library 1、WorkspacePanel 1
```

全部落到宿主 `Modal`：`role="dialog" aria-modal="true"`、`aria-label=title`、focus trap、
Escape、backdrop 点击、z-index 1000。T3 只需把这 5 个自建浮层对齐到同等行为：

| 自建浮层 | 位置 | 现在的问题 |
|---|---|---|
| 新建对话面板 | `new-chat-panel.tsx` | `role=dialog` 但无 `aria-modal`/focus trap；固定坐标；滚动后不跟随（直接留在原地） |
| 添加成员面板 | `team-member-chrome.tsx:205-284` | `role=dialog` + 独立 scrim，无 `aria-modal`/focus trap；scrim 拦截整个视口 |
| 头像编辑器 | `assistant-avatar-editor.tsx:253` | 弹窗内 absolute 气泡，局部；可保留，但 `role=dialog` 无 modal 语义 |
| 放大对话 | `ConversationColumn.tsx:366-370` + `TeamPanel.tsx:433-439` | 自建遮罩 + fixed + z 90/91，无 focus trap；Escape 只在最大化分支处理 |
| @ 提及 | `team-parallel.tsx` + `.teamMentionPopover` | 自算坐标；滚动/缩放直接关闭；`role=listbox` 无宿主 Menu 行为 |

## 3. 基线（当前视觉与几何）

### 3.1 桌面（宽侧栏，约 1440x900）

原生侧栏结构（`@deepseek-ai/dsh-client-ui-sidebar` 的 `.root`）：

```text
padding 6px 12px；纵向 flex
.logoRow  高 60px，padding 8px 0 8px 4px，gap 8，右对齐
  .brand（flex:1，包含 FishLogo + brand.name slot）—— 插件把 .brand 隐藏
  .toggle（28x28，原生折叠按钮）—— 保留
.newSession 高 38px，team 模式 visibility:hidden（保留盒子给 Chief 叠放）
.panelList  Plugins / Automation tasks（team 模式行被隐藏并代理到 footer）
.regionArea → [data-slot="sidebar.workspaces"] → WorkspaceBrowser
  └ #dsh-team-mode-sidebar-host[data-dsh-team-mode="sidebar"]
      ├ 群聊 section（分区标题 + 团队行/线程行）
      └ 单聊 section（默认分组 + 助手行/线程行）
.footArea  footer 动作 + 账号
```

叠加层：

```text
#dsh-team-mode-brand-host
  位置：body；fixed；z 50；transform translateY(-50%)
  范围：left/top/width 由 .logoRow 与团队宿主 rect 算出
  内容：DeepBot(19px/500) + caret；右侧 28x28 搜索/筛选/新建，gap 2
  同行右侧：原生 .toggle（28x28）
#dsh-team-mode-steward-host
  位置：body；fixed；z 5
  范围：完全盖住 .newSession 盒子
  内容：Chief 两行助手行（头像/名称/皇冠/置顶/时间/状态/⋯）
```

群聊/单聊行：行高 34px（单行），分区标题带 `data-dsh-sidebar-title`；团队行左侧
头像堆叠，右侧展开 chevron 与 ⋯；助手行头像/吉祥物 28px，悬停出现动作。
弹窗：宿主 Modal 居中，z 1000，遮罩覆盖全屏（含模式行）。

### 3.2 移动端（390x844；320 抽屉同构）

```text
抽屉宽由宿主管理（截图为 280 CSS px）
模式行同桌面：DeepBot 左，搜索/筛选/新建右，原生折叠按钮同一行最右
抽屉外右上另有宿主的 sidebar 开关（不属于插件）
Chief 行仍在 .newSession 盒上，位置在 Plugins/Automation tasks 之后、团队群聊之前
团队/助手行：触屏行内动作常显（hover:none），第二行右侧 ⋯
弹窗：宿主 Modal 居中，遮罩同时压住抽屉与模式行
```

### 3.3 基线缺陷（T2/T3 应修）

```text
1. 模式行 body fixed：滚动时团队行从它下方穿过并被裁切（real-scrolled.png）；
   顶部透明区域看似空白带（blank-real.png）。
2. 坐标靠 JS 每帧算：折叠/展开、字体、语言、侧栏宽度变化都可能错位；
   只在 rect 宽高 >0 时 visible，隐藏/恢复会闪。
3. Chief 固定压住原生「新会话」：.newSession 被 visibility:hidden，点击被 Chief 捕获；
   Chief 晚加载时先空一块再弹出。
4. 两个 body 宿主 unmount 不清理（SidebarPortal cleanup 只删团队宿主）。
5. 5 个自建浮层缺少宿主弹窗的 focus trap / aria-modal / 滚动锁 / Menu 定位。
6. 死代码 FloatingTeamLauncher 仍占 fixed z-30 与拖拽/持久化代码。
```

### 3.4 基线与验收共用的稳定选择器

```text
侧栏滚动容器   [data-dsh-sidebar-scroll="true"]
模式切换       [data-dsh-surface-switch][data-dsh-surface-mode="team|native"]
模式行动作     button[aria-label="搜索"|"筛选"|"新建"]
原生折叠       [aria-label="收起侧栏"|"Collapse sidebar"|"关闭侧栏"|"Close sidebar"]
团队宿主       #dsh-team-mode-sidebar-host[data-dsh-team-mode="sidebar"]
团队 section   [data-dsh-team-mode-section]（aria-label="群聊"）
分区标题       [data-dsh-sidebar-title]（团队群聊 / 默认分组 / 自定义名）
团队行         [data-dsh-team-mode-section] [class*="sidebarTeamRowWrap"]
线程展开       [data-dsh-team-roster-toggle]
新建线程       [data-dsh-team-thread-create]
助手 section   [data-dsh-assistant-section][data-dsh-assistant-display-mode]
助手行         [data-dsh-assistant-row]
Chief 标记     [data-dsh-assistant-coordinator]（在助手行内）
助手状态       [data-dsh-assistant-status] / [data-dsh-escalation-count]
助手线程       [data-dsh-assistant-thread-toggle]
旧 Chief 宿主  #dsh-team-mode-steward-host（T2 后必须不存在）
旧模式行宿主   #dsh-team-mode-brand-host（T2 后必须不存在）
原生会话行     [data-row-key^="session:"] / [data-conversation-session]
弹窗           [role="dialog"][aria-modal="true"]
菜单           [role="menu"] / [role="menuitem"]
```

## 4. 依赖与风险

```text
模式行事件：SIDEBAR_SEARCH_EVENT / SIDEBAR_MENU_EVENT / SIDEBAR_ASSISTANT_CREATE_EVENT /
  SIDEBAR_GROUP_CREATE_EVENT / SURFACE_MODE_EVENT；Menu 使用宿主原语。
模式行依赖：hide .brand；保留原生 .toggle；宽度对齐团队宿主；syncBotSidebar(mode)；
  data-dsh-surface-mode 全局 CSS（:3238 隐藏团队宿主之后的所有兄弟）。
Chief 数据：实例列表归 assistant-sidebar 所有；团队区归 sidebar.tsx。
  最小改法是在团队区顶部留一个 local host，由 assistant-sidebar 把 coordinator 行 portal 进去
  （仍是 portal，但目标是正常流里的宿主，不是 body fixed）。
New Session：syncBotSidebar:1503-1509 为了给 Chief 让位而 visibility:hidden。
  Chief 回到流后必须改成 display:none（保持“无新会话按钮”的现状）或恢复按钮（视觉变化，需要确认）。
测试耦合：tests/client-surface-mode.spec.ts 断言 BRAND_HOST_ID/ensureBrand 与
  createPortal(renderAssistantRow(coordinator)；T2 必须同步改测试。
  另 tests/client-team-main-agent-panel.spec.ts 断言面板渲染，T4 改面板时要看。
```

## 5. T2 验收（模式行局部化）

### 5.1 目标结构（建议，T2 可微调但不得回退）

```text
模式行：sidebar 根内的局部 header（新增 data-dsh-team-mode-mode-row 作为验收锚点）。
  推荐：直接子节点 + CSS absolute/sticky 覆盖原生 .logoRow 的空白品牌区；
  右侧给原生 .toggle 留出 40px，不重排、不 portal 到 body、不写 rect 坐标。
  原生 .brand 继续隐藏；原生 .toggle 保留并保持同一视觉行。
  关键依赖：SidebarRoot 的 .root 目前没有 position:relative。T2 需给根加一个
  data-dsh-team-root 标记，并在插件 CSS 里写 `:global([data-dsh-team-root]){position:relative}`，
  或接受每次 ensure 重写 inline（React 重渲染可能覆盖）。
  若改用流内 sticky（.sidebarScrollArea 内），它会落在 logoRow 下方，拿不到同一行的原生
  折叠按钮；此时必须隐藏 .logoRow 并在模式行内用代理点击原生 toggle 重建折叠按钮。
Chief：团队区顶部正常流（建议 #dsh-team-mode-coordinator-host 作为团队 section 首子节点，
  由 assistant-sidebar portal 进来；或上提 coordinator 数据后直接渲染）。
  不再有 #dsh-team-mode-steward-host。
New Session：display:none（视觉与现状一致；不要保留 38px 空盒）。
清理：unmount 删除所有插件宿主；模式行不再随 body 变化重算。
```

不采用 `sidebar.brand.name` slot 的原因：它在原生 `<button class=_brand>` 内部、只在宽侧栏
渲染、且是 single slot；把 4 个可交互控件塞进 button 会破坏语义和 rail 形态。原生 sidebar
没有与「模式行 + 搜索 + 筛选 + 新建 + 折叠」等价的 slot，因此按计划「不能保真时保留自定义组合」
走局部 header。

### 5.2 屏幕矩阵

| ID | 视口 | 状态 | 断言 |
|---|---|---|---|
| T2-S1 | 1440x900 | team 模式，列表顶部 | 模式行在侧栏内；无 body 宿主；Chief 在团队群聊标题之上 |
| T2-S2 | 1440x900 | 侧栏滚动 600px | 模式行 top 不变（±1px）；团队行不从行内穿过；无空白带 |
| T2-S3 | 1440x900 | 打开「新建」Menu | Menu 在模式行下方，模式行不被裁切；选择后事件仍工作 |
| T2-S4 | 1440x900 | 打开「新建助手」Modal | Modal 盖住模式行；模式行不响应点击；关闭后焦点回到触发按钮 |
| T2-S5 | 390x844 | 抽屉打开，顶部 | 模式行与原生折叠按钮同一行（中心线 ±2px）；无横向滚动 |
| T2-S6 | 390x844 | 抽屉滚动 | 同 T2-S2；模式行固定在抽屉内 |
| T2-S7 | 390x844 | 打开新建助手 Modal | Modal 遮罩压住抽屉与模式行；Esc 关闭 |
| T2-S8 | 320x568 | 抽屉打开 | 模式行四个动作 + 折叠不换行、不溢出 |

### 5.3 可执行断言（浏览器控制台 / CDP）

```js
// 1. 没有 body 宿主
document.querySelector('#dsh-team-mode-brand-host, #dsh-team-mode-steward-host') === null

// 2. 模式行在侧栏根内且不再 fixed
const row = document.querySelector('[data-dsh-team-mode-mode-row]')
const root = document.querySelector('[class*="_footArea"]')?.parentElement
const scroller = document.querySelector('[data-dsh-sidebar-scroll="true"]')
row && root?.contains(row) && getComputedStyle(row).position !== 'fixed'

// 3. 同一行：模式行动作 + 原生折叠
const els = [...row.querySelectorAll('button[aria-label]')]
const toggle = document.querySelector(
  '[aria-label="收起侧栏"],[aria-label="Collapse sidebar"],[aria-label="关闭侧栏"],[aria-label="Close sidebar"]')
const centers = [...els, toggle].filter(Boolean).map(e => {
  const r = e.getBoundingClientRect(); return r.top + r.height / 2 })
Math.max(...centers) - Math.min(...centers) <= 2

// 4. 滚动固定（滚动的是侧栏内部的 scroll 容器，不是 row 自己）
const before = row.getBoundingClientRect().top
scroller.scrollTop = 600
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
Math.abs(row.getBoundingClientRect().top - before) <= 1

// 5. 滚动时行内不被内容穿透
const r = row.getBoundingClientRect()
row.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))

// 6. Chief 在团队列表正常流
const chief = document.querySelector('[data-dsh-assistant-coordinator]')
const section = chief?.closest('[data-dsh-team-mode-section]')
const firstHeader = document.querySelector('#dsh-team-mode-sidebar-host [data-dsh-sidebar-title]')
const fixedAncestor = n => {
  for (let e = n; e !== null; e = e.parentElement)
    if (getComputedStyle(e).position === 'fixed') return e
  return null
}
section !== null
&& fixedAncestor(chief) === null
&& chief.getBoundingClientRect().bottom <= firstHeader.getBoundingClientRect().top

// 7. New Session 不再是空盒
const ns = document.querySelector('[class*="_newSession"]')
getComputedStyle(ns).display === 'none'

// 8. Modal 在模式行之上
const cx = row.getBoundingClientRect().left + 40, cy = row.getBoundingClientRect().top + 20
!row.contains(document.elementFromPoint(cx, cy))
```

### 5.4 静态闸门

```bash
! grep -n "position = 'fixed'" src/client/sidebar.tsx
! grep -n "document.body.append(element)" src/client/sidebar.tsx
# T3 后 AgentTeam.module.css 里只允许 .mainAgentPanel 保留 fixed（T4 处理）
grep -n "position: fixed" src/client/AgentTeam.module.css
# 放大对话若 T3 处理，ConversationColumn 的 fixed 也应消失
grep -n "position: fixed" src/client/workbench/ConversationColumn.module.css
npm run check
```

T2 需要同步更新 `tests/client-surface-mode.spec.ts`（BRAND_HOST_ID / createPortal 断言）。
T5 截图前先在同一 1440x900 / 390x844 / 320x568 视口补拍 T2 之前的基线。

### 5.5 截图协议（T2 前基线 / T5 回归共用）

```text
浏览器：/root/.cache/ms-playwright/chromium-1208/chrome-linux/chrome --headless=new --no-sandbox
桌面：1440x900，侧栏展开；移动：390x844、320x568（移动端先点宿主
  button[aria-label="Open sidebar"] 打开抽屉）
状态：
  a. 顶部：模式行、Chief、团队群聊、默认分组、Plugins/Automation/foot
  b. 滚动：抽屉内 [data-dsh-sidebar-scroll="true"].scrollTop = 600
  c. 菜单：点 [data-dsh-create-trigger]（新建）
  d. 弹窗：新建 → 新建助手（或 模板库），截遮罩与模式行相对层级
  e. 行：桌面 hover 团队行/助手行；移动触摸态
统一裁切侧栏区域，保留 24px 外围；文件命名 t2-<viewport>-<state>.png。
比对只允许 T2/T3 声明的差异；模式行坐标、行高、字号、间距、遮罩层级逐项对照。
```


## 6. T3 验收（弹窗/菜单原生统一）

### 6.1 迁移映射

| 现状 | 原生替代 | 保留内容 |
|---|---|---|
| 新建对话面板（P6） | 宿主 `Menu`（`portal`，anchor=＋按钮；`children` 放搜索/列表，`footer` 放模板库） | 搜索、新建助手/团队/分组、助手列表、↑↓/Enter/Esc |
| 添加成员面板 | 宿主 `Menu`（`portal`，anchor=＋按钮；搜索 + 候选行 + footer 链接） | 搜索、候选、告诉 Leader 链接 |
| @ 提及面板（P4） | 宿主 `Menu`（`portal`，anchor=@ 按钮；`children` 保留 listbox 行） | 成员/Leader/mention token、键盘、滚动时跟随定位 |
| 放大对话 | `AnimatedModal`/宿主 `Modal`（headless）或工作台内局部放大（去 aria-modal + 局部遮罩） | 双击放大、Esc/遮罩关闭、列内交互 |
| 头像编辑器 | 保持弹窗内 absolute（局部 z 30）；如要 modal 语义，换成 `Menu`/`Modal` | 当前内容与操作 |
| 主 Agent 面板 | 不在 T3；T4 走 `sidebar.right` 或会话分栏 | 面板内容 |

### 6.2 屏幕矩阵

| ID | 视口 | 状态 | 断言 |
|---|---|---|---|
| T3-S1 | 1440x900 | 新建对话面板 | `role=menu`；Tab/↑↓ 在面板内；Esc 关闭且焦点回＋；点击外部关闭；滚动时跟随＋或关闭，不悬空 |
| T3-S2 | 1440x900 | 添加成员面板 | 同上；无独立全屏 scrim；候选行可键盘选择 |
| T3-S3 | 1440x900 | @ 提及（群聊 composer） | 不被 pane 裁切；Esc 焦点回 @；滚动/resize 不留下脱离气泡 |
| T3-S4 | 1440x900 | 新建团队 / 团队管理 / 新建助手 三个 Modal | Tab 循环；Esc 关闭；backdrop 点击关闭；焦点回触发；遮罩只有一层 |
| T3-S5 | 1440x900 | Modal 内打开 Menu（如新建团队的模型选择） | Menu 在 Modal 之上（宿主 1100 > 1000）；Esc 关闭 Menu，不残留无锚点气泡 |
| T3-S6 | 1440x900 | 双击放大对话 | Esc/遮罩关闭；无第二层遮罩；关闭后焦点/滚动回到原列 |
| T3-S7 | 390x844 | 抽屉 + 新建助手 Modal | 背景抽屉不滚动；无重复遮罩；关闭后抽屉位置不变 |
| T3-S8 | 390x844 | @ 提及 / 添加成员 | 面板不超出视口；无横向滚动；触屏可关闭 |

### 6.3 可执行断言

```js
// 所有插件弹窗都带 aria-modal 与标题
[...document.querySelectorAll('[role="dialog"]')]
  .filter(d => d.closest('[data-dsh-team-mode]') || d.getAttribute('aria-label')?.includes('团队'))
  .every(d => d.getAttribute('aria-modal') === 'true')

// 自建层已删除
!document.querySelector('[class*="newChatPanel"],[class*="memberAddScrim"],[class*="teamMentionPopover"]')

// Menu 由宿主 portal，不在侧栏里抢布局
const menu = document.querySelector('[role="menu"]')
menu !== null && !document.querySelector('[data-dsh-sidebar-scroll="true"]').contains(menu)
```

键盘/遮罩/滚动锁必须在真实浏览器里做，不用 jsdom 冒充（现有测试是源码字符串断言）。

## 7. 交付建议

```text
T2：只做 P1 + P3 + .newSession 占位 + 宿主清理；删死代码 FloatingTeamLauncher。
T3：只做 P4/P6 + 添加成员 + 放大对话；不碰 37 个已用 AnimatedModal 的弹窗。
T4：主 Agent 面板、设置/记忆等 slot 接入。
T5：按 §5.2/§6.2 截图对比；任何视觉差异逐项列出。
```
