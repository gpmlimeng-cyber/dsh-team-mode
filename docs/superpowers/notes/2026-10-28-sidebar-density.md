# 侧栏纵向间距审计（2026-10-28）

范围：`src/client` 侧栏相关样式与注入节点。所有数值取自源码（CSS 行号 / DOM 注入
代码），不从截图量取。原生基线取自宿主安装包内的
`SidebarRoot.module.css.mjs` / `WorkspaceBrowser` CSS（`app.asar` 解包核对）。

结论摘要：

- **空占位 1 处（已修）**：原生 `_panelList` 导航把「插件 / 自动化任务」两行移入
  BOT 页脚后自身仍留在流中，带着原生 `margin-bottom: 8px`，在品牌行与第一个助手行
  之间留一条 8px 空带。现在 `syncBotSidebar` 在无可见行时隐藏整个导航
  （`src/client/sidebar.tsx:1534-1554`），`restoreBotSidebar` 随 `BOT_HIDDEN_ATTR`
  一并恢复。
- **空占位 2 处（已修）**：注入的品牌行 `.sidebarModeRowHost` 用的是原生
  `_logoRow` 的 60px 盒子，但自身内容只有一行 28px 控件——上下各 16px 死区；且
  在 `_logoRow` 前插入节点打断了原生 `.topStrip + .logoRow { margin-top: -12px }`
  的贴附规则，darwin 拖拽条下缘因此露出一条空白带（用户截图问题 1、2 的来源）。
- 其余被隐藏的原生节点（`_logoRow`、工作区 `_sectionHeader` + `_listArea`、
  `_newSession`、空的 `_footerActions`）经逐条核对均为 `display: none`，
  折叠态/展开态两条分支的选择器都命中，**不占位**（见下表核对列）。

## 一、注入节点

| 节点 | 来源 | 审计前现值 | 新值 | 依据 |
| --- | --- | --- | --- | --- |
| `.sidebarModeRowHost`（品牌行） | `AgentTeam.module.css:3077`；注入于 `sidebar.tsx` `ensureModeRow`（`root.insertBefore(element, logoRow)`） | `height: 60px; margin-bottom: 4px; padding: 8px 0 8px 4px` → 品牌区 64px，内容仅 28px 控件行 | `height: 44px`，含 margin 共 **48px**（预算上限） | 44 = 28 内容 + 8×2 padding，零死区；4px 网格 |
| 品牌行与拖拽条的贴附 | 原生 `_topStrip + _logoRow { margin-top: -12px }`（宿主 SidebarRoot CSS） | 插入节点打断相邻选择器 → 拖拽条 52px 下缘外露成空白带 | 新增 `[data-dsh-team-root] > [class*='_topStrip'] + .sidebarModeRowHost { margin-top: -12px }`（`AgentTeam.module.css:3094`） | 复刻原生同一条规则，不是发明负 margin |
| `.sidebarTeamHost` / `.sidebarTeamSection` / `.sidebarAssistantSection` | `AgentTeam.module.css:3326 / 3332 / 3825` | `flex: none`、`padding: 0`、无 margin | 不变 | 本身不产生间距 |
| `TeamNextStepCard`（`.nextStepCard`） | `AgentTeam.module.css:13885` | `margin: 2px 0 4px`（2/4 偏离网格） | `margin: 0` | 卡片由 roster 列表自带 1px gap 分隔，与列表其他子项一致 |
| `.sidebarRosterList` | `AgentTeam.module.css:9622` | `gap: 1px; padding-left: 24px; padding-bottom: 2px` | 去掉 `padding-bottom` | 2px pad + 1px 组 gap = 3px，超过行间 ≤2px 且偏网格 |
| `.sidebarRosterEmpty` | `AgentTeam.module.css:9630` | `padding: 2px 8px 2px` | `padding: 4px 8px` | 4px 网格 |
| `.sidebarRosterRow`（线程行） | `AgentTeam.module.css:9639` | `height: 32px; padding: 0 8px`，标题 `overflow: hidden + nowrap + ellipsis` | 不变（已符合） | 32px 即宿主会话行楼层；单行 + ellipsis，无容器硬剪 |
| `.sidebarTeamToggle`（工作区标题位） | `AgentTeam.module.css:3345`；注入于 `sidebar.tsx` 工作区折叠 effect | `height: 28px`，落在原生 `_sectionHeader`（36px）内 | 不变 | 与原生 header 同槽，DeepSeek 模式保留 |

## 二、原生节点：隐藏是否真的生效（逐条核对）

| 原生节点 | 原生现值（宿主包） | 隐藏方式 | 核对结论 |
| --- | --- | --- | --- |
| `_logoRow`（品牌行） | `height: 60px; margin-bottom: 4px; padding: 8px 0 8px 4px` | `AgentTeam.module.css:3100` `[data-dsh-team-root]:not([class*='_collapsed']) [class*='_logoRow'] { display: none }` | 生效：`_collapsed` 与 `[data-dsh-team-root]` 落在同一根元素（原生 JSX `clsx(root, !wide && collapsed)`；插件把属性打在 `logoRow.parentElement`），两种状态各有分支 → 不占位 |
| 品牌行（折叠态让位） | 折叠时原生行 36px 显示 | `AgentTeam.module.css:3104` `[data-dsh-team-root][class*='_collapsed'] .sidebarModeRowHost { display: none }` | 生效：rail 中品牌区完全由原生行承担 → 不占位 |
| 工作区 `_sectionHeader`（36px + margin-top 2px + margin-bottom 4px）与 `_listArea` | 见宿主 WorkspaceBrowser CSS | `AgentTeam.module.css` `html[data-dsh-surface-mode='team'] [data-dsh-team-mode='sidebar'] ~ * { display: none }`（host 以 `container.firstChild` 插入） | 生效：team 模式下全部原生兄弟节点整块移除 → 不占位 |
| `_newSession`（38px + `margin: 0 2px 12px`） | 宿主 SidebarRoot CSS | `sidebar.tsx:1526` `BOT_DROPPED_ENTRIES` → `display: none` | 生效 → 不占位 |
| `_panelList`（`gap: 4px; margin-bottom: 8px`） | 宿主 SidebarRoot CSS | **审计前无规则**：行被逐个 `display: none`，导航自身留 8px margin | **空占位，已修**：`sidebar.tsx:1534-1554` 无可见行时隐藏导航本体 |
| `_footerActions`（空行） | 宿主 SidebarRoot CSS | `sidebar.tsx:1560-1572` 判空后 `display: none` | 已有修复，保持 |

## 三、分区与行容器（4px 网格收敛）

| 容器 | 来源 | 审计前现值 | 新值 | 判定 |
| --- | --- | --- | --- | --- |
| `.sidebarTeamList`（分区间） | `AgentTeam.module.css:3488` | `gap: 2px` | 不变 | 分区之间 2px ≤ 8px ✓ |
| `.sidebarTeamGroup` | `AgentTeam.module.css:3496` | `gap: 1px` | 不变 | 行间 ≤2px ✓ |
| `.sidebarPartition` / `Header` / `Body` | `AgentTeam.module.css:11909 / 11916 / 12029` | `gap: 1px`；header `height: 24px`；body `gap: 1px` | 不变（已低于原生 36px header） | ✓ |
| `.sidebarPartitionEmpty` | `AgentTeam.module.css:12038` | `padding: 2px 8px 4px` | `padding: 4px 8px` | 4px 网格 |
| `.sidebarTeamRowWrap` | `AgentTeam.module.css:3504` | `height: 34px` | 不变 | ≥32px ✓ |
| `.sidebarTeamRowWrapTwoLine` | `AgentTeam.module.css:9368` | `min-height: 44px; padding: 3px 8px` | `padding: 4px 8px` | 4px 网格；总高仍 44px |
| `.sidebarTeamRowTwoLine` | `AgentTeam.module.css:9374` | `min-height: 38px`（36px 头像之上强制 2px 死区） | `min-height: 36px` | 与头像座位同高，行总高 44px 不变 |
| `.sidebarAssistantRowWrap` / `Row` | `AgentTeam.module.css:3831 / 3838` | `min-height: 44px; padding: 4px 8px` / `min-height: 34px` | 不变（36px 头像实际驱动高度） | ≥32px ✓ |
| `.sidebarGroupCreateRow`（新建分组 / 导入分组） | `AgentTeam.module.css:12048` | `height: 30px`（低于 32px 楼层，注释误写 34px） | `height: 32px`，注释改真 | 行楼层 ≥32px；问题 4 的行本体 |
| `.sidebarTeamScope` | `AgentTeam.module.css:9420` | `padding: 2px 8px 4px` | `padding: 0 8px 4px` | 4px 网格，收紧 2px |
| `.sidebarTeamEmpty` / `.sidebarTeamError` | `AgentTeam.module.css:3812 / 13534` | `padding: 3px 5px 6px` | `padding: 4px 8px` | 4px 网格 |

## 四、用户四条空白带的归因

1. **品牌行上方空白带** = darwin 拖拽条 52px 下缘外露（`-12px` 贴附规则被插入节点
   打断）+ 60px 盒子的 16px 上死区 → 由贴附规则复刻 + 44px 盒子消除。
2. **DeepBot 行与第一个助手行之间空白带** = 品牌行 16px 下死区 + 清空后的
   `_panelList` 导航 8px 原生 margin → 由 44px 盒子 + 导航判空隐藏消除。
3. **「主会话」线程行附近空白** = roster 列表 `padding-bottom: 2px` 与相邻行叠加成
   3px 偏网格带 → 已去掉；线程行本体经核对为宿主 32px 单行 + ellipsis，
   **无容器高度硬剪**（`overflow` 只在标题 span 上做 ellipsis，行内容垂直居中）。
4. **「导入分组」上下空白** = 列表尾部行 30px 低于楼层、周围 empty/error 文案
   padding 3/5/6px 全偏网格 → 行提到 32px，周围 padding 收敛到 4/8px。

## 五、契约断言

`tests/client-sidebar-density.spec.ts`（新增）：

- 品牌区 `height + margin-bottom ≤ 48px`；
- 各可点行 `height/min-height ≥ 32px`；
- 行间 gap ≤2px；分区之间 ≤8px（section 无 margin，分区由 `sidebarTeamList` 2px gap 分隔）；
- 隐藏规则存在且覆盖折叠态（`_logoRow` 宽态 / 品牌行折叠态 / team 模式兄弟节点）；
- 清空的 `_panelList` 被隐藏并随 `BOT_HIDDEN_ATTR` 恢复。

`tests/client-surface-mode.spec.ts:273` 的品牌行断言同步为 `height: 44px`。
