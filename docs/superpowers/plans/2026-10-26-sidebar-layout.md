# 可自定义侧栏布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户把 DSH 侧栏的导航级条目自由分配到顶部工具栏 / 上菜单 / 下菜单 / 底部工具栏四个插槽，并提供配置界面。

**Architecture:** 原生节点留在原位只被隐藏，镜像按钮渲染在插件自己的插槽宿主里，点击转发到原生节点。扫描、规划、应用三件事分别放在纯函数模块、DOM 胶水层和现有的 `ensure()` 副作用里。

**Tech Stack:** TypeScript、React 18、CSS Modules、Vitest（纯函数单测，不引入 jsdom）。

**Spec:** `docs/superpowers/specs/2026-10-26-sidebar-layout-design.md`

## Global Constraints

- 插槽固定四个：`top`（顶部工具栏）、`panels`（上菜单）、`submenu`（下菜单）、`footer`（底部工具栏）。工作区 `_regionArea` 内的东西一律不可分配。
- 不搬原生 DOM 节点；只 `visibility:hidden` + `aria-hidden`，点击靠 `.click()` 转发。
- 失败一律开口：镜像没渲染成功就**不得隐藏**原生节点；配置指向不存在的条目就忽略。
- 默认值 = 现状：没配置时一个节点都不动。
- 配置只存 `localStorage['dsh-team-mode:sidebar-layout']`，`version: 1`。
- 新建的下菜单夹层空着时 `display:none`，不占高度。
- 收条目要排除工具按钮（搜索/筛选/排序/新建/折叠/视图切换）与窗口控件、账户行、团队模式自己的 `原生/团队` 切换。
- 样式只用 `--dsw-*` 语义 token，不引入自定义颜色。
- 不 patch `app.asar`，不改 DSH 官方包。
- 每个任务结束前 `npm run check` 必须通过。

## Review Focus

1. 配置里存在指向已消失条目的 key（第三方卸载）→ 不报错、不隐藏任何原生节点。
2. 条目在渲染中途消失（订阅断开/重连）→ 原生节点保持可见，不出现「空了」的插槽。
3. 下菜单没有任何条目时 → 高度 0、无边框、不参与布局。
4. 切换界面语言后 key 失配 → 条目回落原位，不出现凭空消失。
5. 侧栏折叠成 rail 时 → 镜像跟随原生折叠规则，不溢出 36px 行高。

---

### Task 1: 布局数据与规划（纯函数）

**Files:**
- Create: `src/client/sidebar-layout-data.ts`
- Test: `tests/client-sidebar-layout-data.spec.ts`

**Interfaces:**
- Produces: `SlotId`、`SLOT_ORDER`、`SLOT_LABELS`、`LayoutEntry`、`LayoutConfig`、`EMPTY_LAYOUT`、`slugLabel(label: string): string`、`deriveKey(originSlot: SlotId, label: string): EntryKey`、`parseLayoutConfig(raw: string | null): LayoutConfig`、`serializeLayoutConfig(config: LayoutConfig): string`、`resolveSlot(entry: LayoutEntry, config: LayoutConfig): SlotId | 'hidden'`、`isToolLabel(label: string): boolean`、`planLayout(entries: LayoutEntry[], config: LayoutConfig): LayoutPlan`、`LayoutPlan { hide: EntryKey[], mirrors: { key: EntryKey, slot: SlotId, order: number, label: string }[], submenuVisible: boolean }`、`hidesAfterRender(plan: LayoutPlan, rendered: ReadonlySet<EntryKey>): EntryKey[]`

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  EMPTY_LAYOUT, SLOT_LABELS, deriveKey, isToolLabel,
  parseLayoutConfig, planLayout, resolveSlot, serializeLayoutConfig, slugLabel,
  type LayoutEntry,
} from '../src/client/sidebar-layout-data.js'

const entries: LayoutEntry[] = [
  { key: 'panels:插件', label: '插件', originSlot: 'panels', order: 0, movable: true },
  { key: 'panels:自动化任务', label: '自动化任务', originSlot: 'panels', order: 1, movable: true },
  { key: 'footer:插件市场', label: '插件市场', originSlot: 'footer', order: 0, movable: true },
]

describe('sidebar layout data', () => {
  it('derives a stable key from slot and accessible label', () => {
    expect(slugLabel('  Plugins  ')).toBe('plugins')
    expect(deriveKey('panels', '插件')).toBe('panels:插件')
  })

  it('keeps the current layout when nothing is configured', () => {
    expect(parseLayoutConfig(null)).toEqual(EMPTY_LAYOUT)
    expect(resolveSlot(entries[0]!, EMPTY_LAYOUT)).toBe('panels')
  })

  it('falls back to empty config on invalid or foreign json', () => {
    expect(parseLayoutConfig('{oops')).toEqual(EMPTY_LAYOUT)
    expect(parseLayoutConfig(JSON.stringify({ version: 2, assignment: {} }))).toEqual(EMPTY_LAYOUT)
  })

  it('round-trips a config', () => {
    const config = { version: 1 as const, assignment: { 'panels:插件': 'footer' as const } }
    expect(parseLayoutConfig(serializeLayoutConfig(config))).toEqual(config)
  })

  it('ignores assignments that point at unknown entries', () => {
    const config = parseLayoutConfig(JSON.stringify({ version: 1, assignment: { 'panels:gone': 'footer' } }))
    const plan = planLayout(entries, config)
    expect(plan.hide).toEqual([])
    expect(plan.mirrors).toEqual([])
  })

  it('plans a mirror and a hide for a moved entry', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:插件': 'footer' } })
    expect(plan.hide).toEqual(['panels:插件'])
    expect(plan.mirrors).toEqual([{ key: 'panels:插件', slot: 'footer', order: 0, label: '插件' }])
  })

  it('hides an entry without a mirror when it is assigned to hidden', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:自动化任务': 'hidden' } })
    expect(plan.hide).toEqual(['panels:自动化任务'])
    expect(plan.mirrors).toEqual([])
  })

  it('marks the submenu invisible when it holds no mirror', () => {
    expect(planLayout(entries, EMPTY_LAYOUT).submenuVisible).toBe(false)
    expect(planLayout(entries, { version: 1, assignment: { 'panels:插件': 'submenu' } }).submenuVisible).toBe(true)
  })

  it('hides nothing when the mirror did not render', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:插件': 'footer' } })
    expect(hidesAfterRender(plan, new Set())).toEqual([])
    expect(hidesAfterRender(plan, new Set(['panels:插件']))).toEqual(['panels:插件'])
  })

  it('keeps an unconfigured entry at its origin when other keys are configured', () => {
    const config = parseLayoutConfig(JSON.stringify({ version: 1, assignment: { 'panels:自动化任务': 'footer' } }))
    expect(resolveSlot(entries[0]!, config)).toBe('panels')
  })

  it('keeps relative order inside one target slot', () => {
    const plan = planLayout(entries, { version: 1, assignment: { 'panels:插件': 'footer', 'panels:自动化任务': 'footer' } })
    expect(plan.mirrors.map(m => m.key)).toEqual(['panels:插件', 'panels:自动化任务'])
  })

  it('recognizes tool buttons as not movable', () => {
    expect(isToolLabel('搜索')).toBe(true)
    expect(isToolLabel('筛选')).toBe(true)
    expect(isToolLabel('新建团队')).toBe(true)
    expect(isToolLabel('插件')).toBe(false)
    expect(SLOT_LABELS.submenu).toBe('下菜单')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/client-sidebar-layout-data.spec.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/client/sidebar-layout-data.ts`**

导出上面 Interfaces 列出的全部符号。要点：

- `slugLabel` 仅做 `trim().toLowerCase()`，保留中文。
- `parseLayoutConfig` 对 `version !== 1`、非对象、`JSON.parse` 抛错三种情况都返回 `EMPTY_LAYOUT`。
- `resolveSlot` 返回 `config.assignment[entry.key] ?? entry.originSlot`；条目 `movable === false` 时永远返回 `originSlot`（不可移动的条目忽略配置）。
- `planLayout`：目标与 `originSlot` 相同则不产生 hide/mirror；`'hidden'` 只产生 hide；`mirrors` 按 `order` 升序；`submenuVisible = mirrors.some(m => m.slot === 'submenu')`。
- `isToolLabel` 的词表：`['搜索','筛选','排序','新建','折叠','展开','切换','视图','search','filter','sort','new','collapse','expand','view']`，命中任一（小写包含匹配）即视为工具按钮。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/client-sidebar-layout-data.spec.ts`
Expected: PASS，10 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add src/client/sidebar-layout-data.ts tests/client-sidebar-layout-data.spec.ts
git commit -m "feat: add sidebar layout planning data"
```

---

### Task 2: DOM 发现、插槽宿主与应用

**Files:**
- Create: `src/client/sidebar-layout-dom.ts`
- Modify: `src/client/AgentTeam.module.css`（追加镜像行样式与空夹层规则）

**Interfaces:**
- Consumes: Task 1 的 `LayoutEntry`、`SlotId`、`LayoutPlan`、`isToolLabel`
- Produces: `ensureSlotHosts(root: HTMLElement): SlotHosts`、`discoverEntries(hosts: SlotHosts, doc: Document): { entries: LayoutEntry[]; nodes: Map<EntryKey, HTMLElement> }`、`applyLayout(hosts: SlotHosts, entries: LayoutEntry[], plan: LayoutPlan, onActivate: (key: EntryKey) => void): void`、`syncMirrorState(hosts: SlotHosts, nodes: Map<EntryKey, HTMLElement>): void`、`restoreNative(hosts: SlotHosts, doc: Document): void`、`readSidebarEntries(): LayoutEntry[]`（供设置页只读查询）、`SlotHosts { top?: HTMLElement, panels?: HTMLElement, submenu?: HTMLElement, footer?: HTMLElement }`

- [ ] **Step 1: 实现 `ensureSlotHosts`**

在 `root` 内定位并创建四个宿主，缺一个就跳过该槽（返回的 `SlotHosts` 里对应键为 `undefined`）：

- `top`：`root.querySelector(':scope > [class*="_topStrip"]')` 之后的 `div[data-dsh-sidebar-mirror="top"]`。
- `panels`：`:scope > [class*="_panelList"]`（或它在 scroll wrapper 里）的末尾 `div[data-dsh-sidebar-mirror="panels"]`。
- `submenu`：`_regionArea` 与 `_footArea` 之间的 `div[data-dsh-sidebar-submenu]`。
- `footer`：`[class*="_footerActions"]` 末尾的 `div[data-dsh-sidebar-mirror="footer"]`。

每个宿主写入 `hidden = true`（空态）并由 CSS 保证 `display:none`。

- [ ] **Step 2: 实现 `discoverEntries`**

只扫 `_topStrip`、`_logoRow`、`_panelList`、`_footerActions` 四个原生容器（**不含**宿主自己，也不含 `_regionArea`）：

- 候选：`button`、`[role="button"]`、`a[tabindex]`。
- `label = aria-label?.trim() || title?.trim() || textContent?.trim() || ''`；空则跳过。
- `movable = !isToolLabel(label)`；账户行（容器是 `_settingsArea` 或在 `_footerActions` 内且带 `img`/`svg` + 用户名文本）标 `movable: false`。
- `originSlot` 由所在容器决定：`_topStrip`/`_logoRow` → `top`，`_panelList` → `panels`，`_footerActions` → `footer`。
- `order` = 该容器内候选节点的下标。
- 同时返回 `nodes: Map<EntryKey, HTMLElement>`，`applyLayout` 与点击转发都靠它拿原生节点。

- [ ] **Step 3: 实现 `applyLayout`（顺序是关键）**

严格按这个顺序，任何一步抛错都中止且不隐藏：

1. `restoreNative(hosts, doc)` — 把上一轮标记过的原生节点恢复 `visibility`/`aria-hidden`。
2. 清空四个宿主。
3. 为空宿主设 `hidden = true`；`submenu` 依据 `plan.submenuVisible`。
4. 为每个 mirror 建 `<button type="button" class="css.sidebarLayoutMirror" data-dsh-layout-key>`，内部：从原生节点克隆第一个 `svg`（**克隆失败则只放文字**），再加 label 文本；`onclick` 调 `onActivate(key)`。
5. **全部镜像插入成功后**，才把 `hidesAfterRender(plan, renderedKeys)` 里的原生节点隐藏：`el.style.visibility = 'hidden'`、`el.setAttribute('aria-hidden', 'true')`，并把节点引用记进 `WeakSet` 供 `restoreNative` 还原。
6. 隐藏完把宿主 `hidden = false`。

**Step 4: 镜像状态同步 `syncMirrorState(hosts, nodes)`**

每轮 `ensure()` 调用一次。对每个已渲染的镜像，从原生节点抄三个东西，抄不到就跳过（不猜）：

- `aria-current`、`aria-pressed` 原样复制。
- 原生节点 class 里含 `active` 的 → 给镜像加 `css.sidebarLayoutMirrorActive`。
- 原生节点内 `[class*="badge"], [class*="count"]` 的文本 → 写进镜像的 `span[data-dsh-layout-badge]`；没有就移除该 span。

这就是 spec「状态同步与已知上限」的实现边界：只同步这三项，hover 动画与第三方自定义状态不同步。

- [ ] **Step 5: CSS**

在 `src/client/AgentTeam.module.css` 追加 `.sidebarLayoutMirror`（复用 `_panelRow` 的观感：`min-height: 36px`、`border-radius: var(--dsw-radius-md)`、`color: var(--dsw-alias-label-primary)`、hover 用 `var(--dsw-alias-interactive-bg-hover)`）与 `[data-dsh-sidebar-submenu][hidden] { display: none }`。

- [ ] **Step 6: 构建验证**

Run: `npm run typecheck`
Expected: 通过，无 `any` 逃逸新增。

- [ ] **Step 7: 提交**

```bash
git add src/client/sidebar-layout-dom.ts src/client/AgentTeam.module.css
git commit -m "feat: discover and relocate sidebar entries through mirrors"
```

---

### Task 3: 配置界面

**Files:**
- Create: `src/client/sidebar-layout-section.tsx`
- Modify: `src/client/index.tsx:106-109`（在 `dsh-team-mode` 设置节内渲染新分节）
- Test: `tests/client-sidebar-layout-config.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `SLOT_ORDER`/`SLOT_LABELS`/`LayoutEntry`/`LayoutConfig`/`parseLayoutConfig`/`serializeLayoutConfig`
- Produces: `entryOptions(entry: LayoutEntry): { value: string, label: string }[]`、`withAssignment(config: LayoutConfig, key: EntryKey, value: SlotId | 'hidden' | 'origin'): LayoutConfig`

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import { entryOptions, withAssignment } from '../src/client/sidebar-layout-section.js'
import { EMPTY_LAYOUT } from '../src/client/sidebar-layout-data.js'

describe('sidebar layout config ui', () => {
  it('offers origin, four slots and hidden', () => {
    const options = entryOptions({ key: 'panels:插件', label: '插件', originSlot: 'panels', order: 0, movable: true })
    expect(options.map(o => o.value)).toEqual(['origin', 'top', 'panels', 'submenu', 'footer', 'hidden'])
  })

  it('offers only the current slot for a non-movable entry', () => {
    const options = entryOptions({ key: 'panels:搜索', label: '搜索', originSlot: 'panels', order: 0, movable: false })
    expect(options.map(o => o.value)).toEqual(['origin'])
  })

  it('drops the assignment when the value is origin', () => {
    const config = withAssignment({ version: 1, assignment: { 'panels:插件': 'footer' } }, 'panels:插件', 'origin')
    expect(config).toEqual(EMPTY_LAYOUT)
  })

  it('records an assignment otherwise', () => {
    expect(withAssignment(EMPTY_LAYOUT, 'panels:插件', 'submenu'))
      .toEqual({ version: 1, assignment: { 'panels:插件': 'submenu' } })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/client-sidebar-layout-config.spec.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现两个纯函数 + 组件**

- `entryOptions` / `withAssignment` 如上（`withAssignment` 必须返回新对象，不改入参；`origin` 等于删除该 key）。
- 组件 `SidebarLayoutSection`：
  - 挂载时读 `localStorage['dsh-team-mode:sidebar-layout']` → `parseLayoutConfig`，同时用 `useSyncExternalStore` 或一次性 `discoverSidebarEntries()` 拿到条目（条目由 `sidebar-layout-dom.ts` 暴露一个只读查询，读不到就渲染空态文案「当前侧栏没有可分配的条目」）。
  - 每个条目一行：`label` + `<select>`（`entryOptions`），`onChange` → `withAssignment` → `serializeLayoutConfig` 写回 `localStorage`。
  - 底部按钮「恢复默认」：写 `serializeLayoutConfig(EMPTY_LAYOUT)`。
  - 不可移动条目：`disabled` 的 `<select>` + 一行灰字「工具按钮，不参与布局」。
  - 布局变更通过一个 `CustomEvent('dsh-team-mode:sidebar-layout-changed')` 通知 `sidebar.tsx` 重新应用（Task 4 订阅）。

- [ ] **Step 4: 挂进设置**

修改 `src/client/index.tsx` 里 `settings.section` 的注册：在 `AgentTeamSettingsSection` 内部（或并列）渲染 `<SidebarLayoutSection />`，节标题「侧栏布局」。

- [ ] **Step 5: 跑测试与类型检查**

Run: `npx vitest run tests/client-sidebar-layout-config.spec.ts && npm run typecheck`
Expected: 4 个用例 PASS，类型通过。

- [ ] **Step 6: 提交**

```bash
git add src/client/sidebar-layout-section.tsx src/client/index.tsx tests/client-sidebar-layout-config.spec.ts
git commit -m "feat: add sidebar layout settings section"
```

---

### Task 4: 接入现有侧栏副作用并验证

**Files:**
- Modify: `src/client/sidebar.tsx`（`ensure()` 与它的 `useEffect`，约 1206-1296 行）

**Interfaces:**
- Consumes: Task 1 全部、Task 2 的 `ensureSlotHosts`/`discoverEntries`/`applyLayout`/`restoreNative`

- [ ] **Step 1: 在 `ensure()` 末尾接入**

在现有 `for (const child of [newSession, nav, region])` 之后追加：

```ts
const hosts = ensureSlotHosts(nextRoot)
const entries = discoverEntries(hosts, document)
const plan = planLayout(entries, readLayoutConfig())
applyLayout(hosts, entries, plan, key => entryClickHandlers.get(key)?.click())
```

- `readLayoutConfig()`：`parseLayoutConfig(localStorage.getItem('dsh-team-mode:sidebar-layout'))`，`try/catch` 包住（受限 WebView）。
- 原生节点直接从 `discoverEntries` 返回的 `nodes` 取，`onActivate` 里 `nodes.get(key)?.click()`。
- 每轮 `ensure()` 末尾补一次 `syncMirrorState(hosts, nodes)`，让角标/激活态跟上。
- 由于 `ensure()` 已经挂在 `MutationObserver` 上，布局会自动跟随 DOM 变化；额外在 `useEffect` 里监听 `dsh-team-mode:sidebar-layout-changed` 事件并调用 `schedule()`。
- 清理函数里调 `restoreNative(hosts, document)`，避免卸载后原生节点仍被隐藏。

- [ ] **Step 2: 顺序自检（不写代码）**

确认代码里镜像插入在第 4 步、隐藏在第 5 步；若顺序写反，`plan.hide` 会先于镜像生效，出问题就是「条目凭空消失」。在 `sidebar.tsx` 里加一行注释说明这个顺序不能交换。

- [ ] **Step 3: 全量检查**

Run: `npm run check`
Expected: 架构守卫 + typecheck + 全部 Vitest + 构建 全绿。

- [ ] **Step 4: 真机验证**

重启 DSH，在浏览器里逐条确认，并把结果写进 `docs/testing/2026-10-26-sidebar-layout.md`：

1. 设置 → 团队 → 侧栏布局，列表里能看到「插件」「自动化任务」（以及第三方条目，若有）。
2. 把「插件」分到 `footer`：顶部的插件行消失，底部账户行右侧出现可点击的「插件」按钮，点击能打开插件页。
3. 把「自动化任务」分到 `submenu`：工作区下方出现新夹层；再全部移走后夹层消失且不留空白。
4. 选「隐藏」：条目消失，配置里仍保留该项。
5. 切一次界面语言（若可切）：条目回落原位，不出现空白。
6. 折叠侧栏成 rail：镜像不溢出。

- [ ] **Step 5: 记录已知限制**

在 `README_CN.md` 与 `README.md` 的已知限制段落各追加一条（双语成对，AGENTS.md 要求）：自定义侧栏布局只同步激活态与角标，hover 动画与第三方自定义状态不同步；界面语言切换后旧分配失效并回落原位。

- [ ] **Step 6: 提交**

```bash
git add src/client/sidebar.tsx docs/testing/2026-10-26-sidebar-layout.md README.md README_CN.md
git commit -m "feat: apply customizable sidebar layout"
```
