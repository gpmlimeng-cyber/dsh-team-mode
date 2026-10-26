# 原生右侧面板契约（sidebarRight / sidebarRightTabs / sidebar.right.pane.tab）

> 2026-10-26 · 契约验证笔记 · 不写业务代码
> 验证宿主：**DSH NEXT 2.0.19-next**（正在运行的 GUI）
> 宿主包：`@deepseek-ai/dsh-client-ui-sidebar-right` **0.2.1-rc.2**（`app.asar` 内 `node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/package.json`）
> 判断依据：逐条对照该版本 `lib/client.js` 实现 + 随包 README；官方公开文档见 `dsh-plugin-guide/references/official-docs/docs/subsystems/sidebar-right.md`
> 既有先例：`@nanmicoder/dsh-agent-teams` 0.1.26（`~/.dsh/profiles/desktop/node_modules/.../lib/client.js`）

结论先说：**它是公开的扩展契约**（官方子系统文档 + 包 README 都在讲“extension seats”），不是内部 API。照 AgentTeams 的做法写即可，唯一要自己盯的是版本。

## 1. `ctx.sidebarRightTabs.register(definition)`

`definition` 全是静态字段，无运行时钩子；返回 disposer，**必须放在自己的 `ctx.effect` 里**（注册生命期 = 插件生命期）。

| 字段 | 类型 / 约束 |
|---|---|
| `id` | 必填，全局唯一（重复注册抛错）。建议包名，如 `@limeng/dsh-team-mode/detail`。它同时是 body / title 槽注册的 `key`。 |
| `kind` | 必填，任意字符串（不是枚举）。`openTab(kind)` 就按它找实现。同一个 kind 最多一个 `builtin` + 一个 `extension` 并存（extension 生效、builtin 让位）；`fallback` 不与任何 band 共享 kind；再撞就抛错。 |
| `title(address)` | 必填，返回 chip 文案。**打开 tab 时调用一次并写进 layout 记录**，之后不再刷新；要跟随语言变化就再注册 `sidebar.right.pane.tab.title` 槽。 |
| `patterns` | 可选，资源地址 glob（picomatch，大小写不敏感）。页面型 tab 不写。含 `:` 匹配整个地址，不含则匹配 URL path。 |
| `priority` | 可选，`extension`（默认，最高）/ `builtin` / `fallback`。第三方插件不写就是 extension，天然压过内置类型。 |
| `canOpen(address)` | 可选，同步否决匹配。 |
| `keepMounted` | 可选，访问过的 body 在隐藏/切 Session/dock 时保留挂载。 |
| `multiple` | 可选（实现里有、官方字段表没列）：`true` 时每次 open 生成独立地址 `sidebar://<kind>/<uuid>`，可多实例。 |
| `guide` | 可选，往 guide 页放入口胶囊：`{ id, title(), description?(), icon? }`；放 uid 后新面板默认页会变成你的页。 |

同族只读方法：`get(kind)` / `active()` / `entries()` / `candidates(address)` / `claim(address, kind?)` / `guide()` / `subscribe(listener)`。

`locale` **不在**这里——它是 `ctx.slots.register` 的选项。

## 2. 打开 / 关闭 / 切 tab

真正干活的都在 `ctx.sidebarRight`（`sidebarRightTabs` 只是类型注册表）。AgentTeams 里 `bridge.set(native.sidebarRight)` 只是把服务引用交给面板组件，**打开动作是组件里调 `sidebar.openTab(TEAM_TAB_KIND)`**（`WorkspaceActivity.js:51,66`），前置守卫是 `sidebar.mounted.getSnapshot() === current`。

| 动作 | API |
|---|---|
| 打开页面 tab | `openTab(kind, opts?)` — 目标 pane 内已有同 kind 页就 focus 它而不是再开一个（跨 pane 不去重）；顺带把栏展开（折叠时也展开）。 |
| 打开资源 tab | `openResource('dsh-resource://…', opts?)` — 必需 `dsh-resource://` 前缀，无人认领即抛错。 |
| 切 tab | `focus(tabId)`；或再 `openTab(kind)`（页面 tab 天然去重）。 |
| 关 tab | `close(tabId)`（唯一 docked guide 关不掉；关掉最后一个 docked tab 会连栏一起收）。 |
| 展开 / 收起 | **只有** `isExpanded()` / `toggleExpanded()`，没有 open/close/setExpanded。收起 = 判断后 toggle。 |
| 改全屏 | `toggleFullscreen(target)`（target 来自 `commandTarget()`）。 |
| 布局编排 | `split(paneId?)` / `float(tabId, rect?)` / `dock(paneId)`。 |
| 定位 | `focusedTarget()` / `commandTarget()` / `isTargetCurrent(target)`。 |

`opts`：`paneId` / `replaceTab` / `revealIfOpened`（默认 true）/ `preferNewPane` / `kind`（仅 openResource）/ `params`（body 里读 `tab.navigation.params`）。

**没有 `onOpenChange`，也没有面板开合订阅**——官方文档明说 “service exposes operations only”，布局快照/序列是 internal。能观测的只有三样：

- `ctx.sidebarRight.mounted`（snapshot store，`getSnapshot()/subscribe`）：当前“前台 Session”，hero 屏/被全局面板顶掉时是 `undefined`；
- `ctx.sidebarRight.openTabs`（snapshot store）：跨 Session 的已开 tab 元数据 `{ sessionId, tabId, kind, contentId }[]`；
- tab body 内 `useTabInfo().sidebar.expanded / .fullscreen`：在面板内部做响应式。

`mounted === undefined` 时所有写操作抛 `sidebarRight: no session surface is mounted`——所以 open 之前一定要拿 `mounted` 守卫。

## 3. `sidebar.right.pane.tab` 的 owner props

注册形状必须两段对齐同一个 id：

```ts
export const inject = ['sidebarRightTabs', 'slots']

ctx.effect(() => ctx.sidebarRightTabs.register({ id: TYPE_ID, kind: KIND, title: () => t('detail.title') }), 'detail type')
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: NS }, DetailBody,
))
```

- `key` **必须等于** `sidebarRightTabs.register` 里的 `id`（不是 `kind`）；不对齐就渲染 owner 的“nothing can view this”提示。
- owner props 本身是 `{}`。body 拿到的是框架 shares：`sessionId`、`t`（来自 `locale`）、`inject()` 的返回值，以及 `useTabInfo()`。
- `useTabInfo()` 返回 `{ sidebar, panel, tab }`：
  - `sidebar: { expanded, fullscreen }`
  - `panel: { id }`（pane id）
  - `tab: { id, kind, contentId, title, visible, navigation, signal, actions, refreshShortcut }`
  - `navigation: { address, params, revision }`（响应式；`revision` 每次导航 +1，页 tab 首次为 1，恢复/undo 为 0）
  - `actions: { openResource, openTab, close, bindCommands }`（绑在 tab 自己所属的 Session，切 Session 后仍落对地方）
  - `signal`：记录消失或插件卸载时 abort（隐藏/切 Session 不 abort）
- **能读到“当前 tab”**：body 一实例对应一个 tab，`tab` 就是它；读不到“整个面板当前激活哪个 tab”这种全局视图（只有 `ctx.sidebarRight.active()`，且只答前台 Session 的 active pane）。
- 想要实时 chip 文案：另注册 `{ name: 'sidebar.right.pane.tab.title', key: TYPE_ID, locale: NS }`，props 同 body。

## 4. `kind` 取值与语义

`kind` 是开放字符串，等于“这个 tab 是什么”，也是 `openTab` 的入参；**没有枚举校验**。内置已占用：`guide`、`text`、`files`、`browser`（多实例）、`subagentchat`。不要撞这些。

AgentTeams 的常量（`client/WorkspaceActivity.js:11`）：

```js
export const TEAM_TAB_KIND = 'agent-teams'
export const TEAM_TAB_ID = '@nanmicoder/dsh-agent-teams/activity'
```

我们的取值建议（避开已装的 AgentTeams，kind 撞车时只有一个 in force 会互相顶替）：

```ts
export const DETAIL_TAB_KIND = 'team-mode'
export const DETAIL_TAB_ID = '@limeng/dsh-team-mode/detail'
```

## 5. 公开性判断（一句）

公开：DSH 官方子系统文档 `docs/subsystems/sidebar-right.md`（`dsh-plugin-guide` 随包附带）把 tab 注册、`ctx.sidebarRight`、四个槽都写成对外契约，包 README 明确“extension seats”，且第三方插件正在用。但 `@deepseek-ai/dsh-client-ui-dockkit` 在那份文档里被标为 **internal dependency**——只碰 `sidebarRight` / `sidebarRightTabs` / `slots`，不要 import dockkit。

## 6. 版本要求与依据

AgentTeams 的 `compatibility.json`（包根）声明：

```json
{ "schemaVersion": 1, "recommendedHost": "0.2.1-rc.2", "previewTag": "next",
  "supportedHosts": [ { "version": "0.2.1-rc.2", "track": "recommended" },
                      { "version": "0.2.1-rc.1", "track": "legacy" }, "…共 10 项，最早 0.1.2-alpha.2" ] }
```

它的 `package.json` 把这些版本拼成精确 union 写进每个 `@deepseek-ai/dsh*` peerDependency（`0.2.1-rc.2 || 0.2.1-rc.1 || …`），并在 `dsh.client.inject` 里静态声明 `@deepseek-ai/dsh-client-ui-sidebar-right`。

**但 DSH 不读这个文件。** 三处实证：

1. 整个 `app.asar` 里 `recommendedHost` / `supportedHosts` 各 0 次命中（`grep -a`）。
2. DSH 里叫 `compatibility.json` 的是**另一个东西**：profile 目录 `$DSH_HOME/profiles/<name>/compatibility.json` 的**版本豁免表**——精确 `package-name@version` → 精确 runtime 版本数组，由 Plugin Manager 读写，畸形时只报错不阻断启动、并转为只读等人工修（`dsh-app-boot` README §profiles、`dsh-plugin-manager` README §version-compatibility-and-exemptions）。
3. 宿主真正执行的版本门是 manifest：声明了 `engines.dsh` 就只认它并**忽略** `peerDependencies`；否则所有 `@deepseek-ai/dsh*` 的 peer 范围必须匹配（`dsh-app-boot` README）。本仓库只有 `engines.node`，没有 `engines.dsh` → peer 范围生效，现状 `^0.2.1-rc.2` 与运行中的宿主 0.2.1-rc.2 相符。

结论：照抄的应该是 **`dsh.client.inject` 加包名 + peer 范围**；`compatibility.json` 那份信息当文档写进 README/本文即可，**不要**在包根造一个同名文件——它与 profile 级豁免文件同名，混淆成本高于收益。

判断依据可复查：签名以 `app.asar` 内 0.2.1-rc.2 的 `lib/client.js` 为准（`register` / `openTab` / `tabInfoFactory` / 槽注册），不是凭 README 推断。asar 是未压缩的，`grep -a` 可直接搜；按名取文件用 20 行 node 脚本读 asar header（`base = 8 + headerSize`，文件 offset 相对 `base`）。

## 最小可用示例（本仓库风格）

`package.json`：

```json
{ "dsh": { "client": { "inject": [
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-sidebar-right"
] } } }
```

客户端插件体（可选服务作用域，宿主没有该服务时什么都不贡献）：

```ts
const DETAIL_TAB_KIND = 'team-mode'
const DETAIL_TAB_ID = '@limeng/dsh-team-mode/detail'
const NS = 'team-mode'

export function apply(ctx: Context): void {
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (native) => {
    const t = native.locale.bind(NS)
    native.effect(() => native.sidebarRightTabs.register({
      id: DETAIL_TAB_ID,
      kind: DETAIL_TAB_KIND,
      title: () => t('detail.title'),
    }), 'detail tab type')

    native.slots.inject('sidebar.right.pane.tab', () => native.slots.register(
      { name: 'sidebar.right.pane.tab', key: DETAIL_TAB_ID, locale: NS },
      DetailBody,
    ))
  })
}

// 打开：先确认前台 Session 就是当前会话，再 open（open 会自己展开栏）
function openDetail(sidebar: ISidebarRight, sessionId: string): void {
  if (sidebar.mounted.getSnapshot() !== sessionId) return
  sidebar.openTab(DETAIL_TAB_KIND)
}

// body：只经 useTabInfo 拿数据，不 import dockkit
// 类型：import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
//       import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
function DetailBody({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) {
  const { tab, sidebar, panel } = useTabInfo()
  return <div data-expanded={sidebar.expanded} data-pane={panel.id} data-tab={tab.id}>{tab.kind}</div>
}
```

关闭：`if (sidebar.isExpanded()) sidebar.toggleExpanded()`。`ISidebarRight` / `TabId` / `PaneId` / `TabRecord` / `FloatRect` 由包的 `/client` 入口导出（dockkit 的类型不要碰）。

`@deepseek-ai/dsh-client-ui-sidebar-right` 目前**不在本仓库依赖里**，而 `PropsRuntime<'sidebar.right.pane.tab'>` 靠它声明的 `SlotMap` 增强：落地时要加 devDependency + `dsh.client.inject` + peer 范围，否则 typecheck 不认这个槽名。

## 风险

1. **版本漂移**（唯一实质风险）：0.2.1-rc.2 之外未验证；升级宿主后按第 6 节的方式重跑对照。
2. **kind / id 撞车**：与已装 AgentTeams 同 kind 时只有一个 in force，会互相顶替；用独立 `kind` + 包名 `id`。
3. **`dsh.client.inject` 必须是静态数组**，漏了 sidebar-right 会得到 `cannot get property "sidebarRightTabs" without inject`，且插件自愈机制会禁用整个 bundle（`dsh-plugin-guide` 有前科记录）。服务层面用 `ctx.inject([...])` 可选作用域，别写进顶层 `export const inject`。
4. **无 `onOpenChange`**：要开合状态只能在 tab body 内读 `useTabInfo().sidebar.expanded`，或订阅 `openTabs` 的成员变化；别指望面板开合回调。
5. **`title` 只在打开时捕获**：需要 i18n 实时切换就补 title 槽。
6. **`mounted === undefined` 时写操作抛错**：hero 屏 / 全局面板顶掉会话时先守卫。
7. 面板宽度、位置、折叠按钮由 frame 拥有，插件只能给 tab 内容；不要自绘 overlay 右栏（也正是本任务的前提）。
