# 可自定义侧栏布局 — 设计

> 2026-10-26 · 目标插件 `@limeng/dsh-team-mode` · 状态：待评审

## 目标

让用户把 DSH 侧栏里的「导航级可点条目」自由分配到四个插槽，并有一套配置界面。
不改工作区（Workspace/Session 列表）本身的任何内容。

四个插槽（已与用户确认，对应现有 DOM）：

| 插槽 id | 中文名 | 现有容器（class 子串） |
|---|---|---|
| `top` | 顶部工具栏 | `_topStrip`、`_logoRow` |
| `panels` | 上菜单 | `_panelList`（`_panelRow`：插件、自动化任务…） |
| `submenu` | 下菜单 | **新建的夹层**，位于 `_regionArea` 与 `_footArea` 之间 |
| `footer` | 底部工具栏 | `_footerActions`（市场图标、账户行…） |

`_regionArea`（群聊/单聊/工作区）不可分配，也不出现任何条目。

## 非目标

- 不做拖拽排序。配置界面用下拉选择，先解决"放到哪里"。
- 不改 DSH 官方包，不 patch `app.asar`。
- 不移动 Workspace/Session 行、不重新排序工作区内容。
- 不做跨设备同步；配置只存本机。

## 关键决策

1. **镜像代理，不搬原生节点。**
   原生节点留在原位并 `visibility:hidden` + `aria-hidden`，在目标插槽渲染插件自己的按钮，点击时对原生节点调 `.click()`。
   理由：跨父节点搬 React 管的 DOM，下一次 reconcile 可能把节点拆掉或挪回；镜像方式下最坏情况只是显示错，原生功能仍在。

2. **范围 = 全部导航级条目（含第三方）。**
   发现范围就是上面四个容器里的可点节点。第三方只要按官方 slot 注册到 `sidebar.panellist` / `sidebar.footer.action`，就自动可被分配，不需要改它们的代码。

3. **默认值 = 现状。**
   未配置时一个节点都不动。新增条目（升级后第三方加的）默认留在自己的原生插槽。

4. **失败开口（fail open）。**
   任何一步识别不出来就**保留原样**：宁可没生效，也不能出现「原生被藏了、镜像没渲染」的黑洞。

## 组件与职责

新增三个文件，外加一处集成：

```
src/client/sidebar-layout-data.ts     纯函数：条目模型、key 推导、配置序列化、布局规划
src/client/sidebar-layout-dom.ts      DOM：发现条目、隐藏/还原、把原生状态抄到镜像
src/client/sidebar-layout-section.tsx 配置界面（settings.section 里的一节）
src/client/sidebar.tsx                现有 ensure() 副作用里调用应用逻辑
```

### `sidebar-layout-data.ts`（可单测，无 DOM）

```ts
type SlotId = 'top' | 'panels' | 'submenu' | 'footer'
type EntryKey = string          // `${originSlot}:${labelSlug}`
interface LayoutEntry {
  key: EntryKey
  label: string                 // 无障碍名（aria-label ?? textContent）
  originSlot: SlotId            // 原生所在插槽
  order: number                 // 容器内 DOM 顺序
  movable: boolean              // 见「排除规则」
}
interface LayoutConfig {
  version: 1
  assignment: Record<EntryKey, SlotId | 'hidden'>
}
```

- `parseLayoutConfig(raw: string | null): LayoutConfig` — 非法 JSON/版本不符 → 空配置（= 现状）。
- `serializeLayoutConfig(c)` — 稳定输出，便于 diff。
- `slugLabel(label)` — 归一化（去空白、小写，保留中文）。
- `deriveKey(originSlot, label)`、`resolveSlot(entry, config)` — 纯函数，全部单测。

### `sidebar-layout-dom.ts`

- `discoverEntries(root: HTMLElement): LayoutEntry[]`
  - 扫 `_topStrip`、`_logoRow`、`_panelList`、新建夹层容器、`_footerActions`。
  - 只收「可点节点」：`button`、`[role="button"]`、带 `tabindex="0"` 的 `a`/`div`。
  - `label = aria-label || title || textContent.trim()`，取不到则跳过该节点（不猜测）。
- `applyLayout(root, entries, config)` — 幂等：
  - 对每个 `resolveSlot !== originSlot` 且已成功渲染镜像的条目：隐藏原生。
  - 每次重算都先还原上一个状态再应用，避免 MutationObserver 抖动导致叠加。
- `readNativeState(el)` — 读 `aria-current`、`aria-pressed`、`class*="active"` 判定，以及 `[class*="badge"], [class*="count"]` 的文本，供镜像同步。

### `sidebar-layout-section.tsx`

- 挂在现有 `settings.section`（`id: 'dsh-team-mode'`）内的新分节「侧栏布局」。
- 每个条目一行：`label` + 下拉（默认（原位置）/ 顶部工具栏 / 上菜单 / 下菜单 / 底部工具栏 / 隐藏）。
- 底部两个动作：**恢复默认**、**刷新条目列表**。
- 只读展示不可移动条目（灰显 + 一行说明），不隐藏它们——用户要知道为什么某个东西配不了。

### 集成点

现有 `src/client/sidebar.tsx` 的 `ensure()` 已经在搬 `newSession / panelList / regionArea` 并挂了 `MutationObserver`。布局应用复用同一个 `ensure()` 与同一个 observer，不新增第二套监听。

新建夹层：在 `root` 里插一个 `div[data-dsh-sidebar-submenu]`，位于 `_regionArea` 之后、`_footArea` 之前。**空时 `display:none`**，不占高度。

### 镜像宿主（每个插槽一个）

镜像不直接塞进原生容器（会和原生行抢位置、被原生布局规则影响）。每个插槽有自己的宿主节点，由插件创建并插入：

| 插槽 | 镜像宿主位置 |
|---|---|
| `top` | `_topStrip` 之后、`_logoRow` 之前，`div[data-dsh-sidebar-mirror="top"]` |
| `panels` | `_panelList` 的**末尾**，`div[data-dsh-sidebar-mirror="panels"]` |
| `submenu` | 新建夹层容器本身 |
| `footer` | `_footerActions` 的末尾，`div[data-dsh-sidebar-mirror="footer"]` |

规则：

- 宿主为空时不渲染、不占空间（`display:none`）。
- 宿主内镜像按 `order` 升序排列，保持条目在原生容器里的相对顺序。
- 宿主是插件的节点，原生节点永不进入宿主；两者只在同一条视觉流里相邻。

## 排除规则（什么不收进配置列表）

以下不算导航级条目，`movable: false`：

- 隶属于某个列表的工具按钮：搜索、筛选、排序、新建、折叠/展开、视图切换。判据：`aria-label` 命中工具词表，或位于 `_regionArea` 内。
- 窗口控制（红黄绿、Windows titlebar 按钮）与 `_topStrip` 里的平台控件。
- 账户行本身（头像 + 用户名）。
- 团队模式自己注入的 `原生/团队` 切换（它有独立的显隐语义）。

词表集中放在 `sidebar-layout-data.ts`，不散落在各处。

## 状态同步与已知上限

镜像需要跟着原生变：是否选中（`aria-current` / active 类）、是否禁用、角标数字。
同步方式：`ensure()` 每轮 + MutationObserver 回调里重读一次并写入镜像。

**明确不保证**：hover/focus 的视觉细节、原生节点的过渡动画、某些第三方自定义状态。
这些不同步时，表现为"按钮能点、状态不准"，不会影响功能。spec 评审通过后这一段要原样进 README 的已知限制。

## 持久化

- `localStorage['dsh-team-mode:sidebar-layout']`，值 = `serializeLayoutConfig()`。
- 选择 `localStorage` 而不是 Host 存储：这是纯客户端显示偏好，无需跨设备，也不值得为它加迁移。
- 读取失败（受限 WebView）→ 空配置，功能降级为不可配置但侧栏正常。

## 降级矩阵

| 情况 | 行为 |
|---|---|
| 容器找不到（DSH 改结构） | 该插槽条目不发现，界面显示空列表，侧栏原样 |
| 条目某轮消失（第三方卸载） | 配置项保留（不删），应用时跳过 |
| 镜像渲染失败 | 原生节点**保持可见**，不隐藏 |
| 配置里指向已不存在的 key | 忽略，不报错 |
| localStorage 不可用 | 空配置，只读提示 |

## 测试计划

- `tests/client-sidebar-layout-data.spec.ts`：key 推导、`resolveSlot`、配置解析（非法/旧版本/未知 key）、排除词表命中。
- `tests/client-sidebar-layout-apply.spec.ts`：给定条目 + 配置，断言"隐藏哪个、镜像放哪个槽、空夹层不占位"——用 `applyLayout` 的纯规划输出（`planLayout()`）测试，不依赖真实 DOM。
- 不引入 jsdom 依赖；DOM 胶水层用 `planLayout()` 的纯函数做逻辑覆盖，真实 DOM 行为在浏览器里人工验证一次。
- `npm run check` 必须通过。

## 风险

1. **DSH 升级换 class 或层级** → 现有代码用 `[class*="_footArea"]` 这类子串匹配，加 MutationObserver 自愈；本次沿用同一套，不新增更脆的假设。
2. **图标克隆**：镜像的图标从原生节点克隆 SVG 标记。若第三方用 canvas/img，降级为文字按钮。
3. **key 用无障碍名**：切换界面语言后 key 会变，之前的分配失效（回落到原位置）。可接受，写进已知限制。

## 交付顺序

1. `sidebar-layout-data.ts` + 单测（纯函数先立起来）
2. `sidebar-layout-dom.ts` 的 `planLayout()` + 应用逻辑，接入 `ensure()`
3. 新建下菜单夹层 + 空态不占位
4. `sidebar-layout-section.tsx` 配置界面
5. 浏览器里人工验证四个插槽 + 真机截图
6. `npm run check`
