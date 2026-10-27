# UI 适配优化 — 原生优先的混合方案

> 2026-10-27 · 目标：保持现在的 UI 与交互，同时优先使用 DSH 原生元素与布局上下文。
> 原则：原生元素优先；原生 Slot 只有在不丢失现有 UI/交互时才用；不再用 body 浮层抢全局层级。

## 现状盘点（17 处）

```text
src/client/sidebar.tsx
  body fixed 模式行 host
  body fixed 总协调 host
  body append 锚点
  createPortal 模式行 / 团队列表
src/client/assistant-sidebar.tsx
  coordinator createPortal
src/client/team-parallel.tsx
  createPortal 浮层
src/client/new-chat-panel.tsx
  createPortal
```

问题根因：

```text
插件自建 body 层
自己算坐标
自己调 z-index
自己监听滚动/尺寸
```

DSH 的弹窗、抽屉、主题、滚动都由宿主管理；插件抢走布局权就会反复出现遮挡、空白、移动端错位。

## 目标状态

### 保留

```text
DeepBot + 搜索 + 筛选 + 新建 + 折叠 同一行
团队群聊/默认分组/助手行的视觉
Chief 卡片位于团队列表顶部
线程行视觉
现有弹窗内容与操作
```

### 改变

```text
模式行：body fixed → 侧栏局部 sticky
总协调：body fixed → 团队列表正常流
团队/助手列表：body portal → 侧栏容器内渲染
弹窗/菜单：统一 DSH AnimatedModal / Menu / Button
层级：不再出现 >1000 的全局 z-index
```

### 原生优先的边界

```text
能保真：
  settings.section
  settings.general.item
  conversation.chat.node
  conversation.input.*
  shell.overlay（仅全局提醒）

不能保真、保留自定义组合：
  模式行整行（同排三个动作）
  团队/助手列表
  分组标题
  线程行
  总协调卡片

自定义部分必须：
  使用 --dsw-* token
  使用 DSH 控件行为（Modal focus/Escape、Menu 定位、Button 状态）
  在侧栏局部 stacking context 内
  不 append document.body
  不全局 fixed
```

## 任务拆分

### T1 · 基线审计与视觉快照

- 记录桌面/移动端截图：模式行、团队行、助手行、Chief、线程行、弹窗。
- 标出每处 fixed/portal/z-index 的用途与依赖。
- 明确哪些元素必须同排、哪些可以移动。
- 不改代码。

### T2 · 模式行局部化（核心）

- 把模式行从 body fixed 移到侧栏根内的 sticky header。
- 保留 DeepBot + 搜索 + 筛选 + 新建 + 折叠 同排与间距。
- 删除背景带、全局 z-index、coordinate 计算。
- 总协调行回到团队列表正常流，不再 fixed。
- 验收：
  - 打开新建助手弹窗，模式行不盖弹窗。
  - 移动端打开抽屉，模式行与折叠按钮同一行。
  - 滚动时模式行固定在侧栏内，不出现空白条。
  - 无 body append / 无 global fixed。

### T3 · 弹窗/菜单原生统一

- 所有自定义弹窗改用 DSH `AnimatedModal`/`Modal` 行为：focus trap、Escape、backdrop。
- 菜单统一 DSH `Menu` 定位与键盘行为。
- 删除自定义 overlay 与 z-index。
- 验收：键盘 Tab/Escape、点击外部、移动端滚动锁、无重复遮罩。

### T4 · 原生 Slot 接入（不牺牲 UI）

- 记忆/设置：`settings.section` / `settings.general.item`。
- 对话内团队事件：`conversation.chat.node`。
- 输入触发：`conversation.input.*`。
- 会话行装饰：`sidebar.session.row.leading/hover/menu.item`。
- 不做：替换 `sidebar.workspaces` 整块，除非 T2 证明必须。

### T5 · 视觉回归与验收

- 桌面/移动端截图对比 T1 基线。
- 弹窗、抽屉、滚动、深浅色、断线重连。
- `npm run check`。
- 任何视觉差异逐项列出，默认不允许无关差异。

## 非目标

```text
不改原生聊天/输入框
不重写团队/助手业务逻辑
不替换 sidebar.workspaces
不新增第二套行组件
不为了“纯原生”牺牲现有交互
```

## 交付顺序

```text
T1 审计
T2 模式行局部化
T3 弹窗/菜单统一
T4 Slot 接入
T5 视觉回归
```

T2 是必须先做的一步：它同时解决模式行、弹窗遮挡、移动端抽屉、滚动层级四类问题。
