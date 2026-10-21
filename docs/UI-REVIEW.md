# UI 审查与精修报告

依据 `ui-new`（UI Design System）的 UI Audit & Optimization Protocol，以 DeepSeek Harness 官方界面为唯一视觉基准（语义色 token、400/500 字重、8px 圆角、克制的边框与阴影），对插件全部可见界面做了一轮审查与改造。

## 一、核心问题（改造前）

1. **团队管理弹窗层级混乱**
   - 弹窗标题是团队名，内部又重复一次团队名；标题、描述、tab、团队名四层堆叠。
   - 成员卡片操作全部挤在一行文字按钮里，「移出」被挤成两行，按钮高度/字号/圆角不统一。
   - 复制/清空/解散是三张带边框的卡片，套在已经带边框的弹窗里，形成“框套框”。
2. **助手头像使用浏览器原生 file input**
   - “Choose File / No file chosen” 直接出现在界面里，与整体设计语言断裂。
3. **助手卡片信息密度失控**
   - 7 行 11–12px 小字（Provider、Preset、权限、思考、Skills、MCP、提示词）没有层级，用户无法扫读。
4. **助手库弹窗比例失衡**
   - 1240px 宽、接近全屏，内容只占左侧 2/3；搜索框与「手动新建」错位换行。
5. **主题与字重违规**
   - 一处硬编码 `#F7F8FA`（暗色模式会变成亮块）、一处品牌色徽标配白字；出现 600/700 字重，超出 DSH 的 400/500 体系。

## 二、改造内容

| 区域 | 改造 |
| --- | --- |
| 团队管理 | 标题统一为「团队管理」，团队身份只在内部出现一次；成员操作拆为“常驻操作（重连/清空/设为 Leader/移出）+ 悬停工具（重命名/上移/下移）”；按钮统一 24px 高、6px 圆角、11px 字号；风险操作改为无边框分隔行 |
| 助手头像 | 原生 file input 改为「上传图片 / 更换图片」按钮（隐藏 input、保留键盘焦点环） |
| 助手卡片 | 元信息压缩为 3 行：模型、Preset/权限/思考、Skills/MCP/提示词计数；状态与来源改为描边徽标；卡片在 2 列时自动铺满 |
| 助手库 | 弹窗收窄到 1040px、高度收到 560px；搜索框固定 260px，与「手动新建」同一行；上移/下移改为 28px 图标按钮，操作不再换行 |
| 组件一致性 | 插件按钮圆角 16px → 8px、高度 32 → 30px；输入框 36 → 34px；补全成员操作、图标按钮、上传控件的 `:focus-visible` 焦点环 |
| 主题 | 移除硬编码浅色背景与白字徽标；阴影改用 `--dsw-alias-shadow-l1`；字重全部收敛到 400/500 |

## 三、验证

- `npm run check`：通过（typecheck + 159 项测试 + build）。
- DeepSeek Harness 实例逐屏截图：团队管理（成员/活动）、助手库、助手编辑器、暗色模式助手库；见 `docs/assets/ui-review/`。
- 暗色模式确认：弹窗、卡片、输入框、徽标均随语义 token 切换，无亮块残留。

## 四、保留项（未在本轮处理）

1. 弹窗仍可三层堆叠（添加助手 → 助手配置 → 新建助手）；原生应用更常用“同一弹窗内换页”，需要一次结构性重构。
2. 完整看板与简版活动看板仍是两个组件（筛选语义已对齐）。
3. 团队工作台（全屏 overlay）与原生会话 tab 两套入口并存，未做入口收敛。

---

## 五、第二轮：二级弹窗

逐屏审查并截图了添加成员、复制团队、清空确认、解散文确认、新建团队五个弹窗。

### 发现与处理

| 弹窗 | 问题 | 处理 |
| --- | --- | --- |
| 新建团队 | 左右两栏没有分隔，视觉上连成一片；54vh 固定高度在只有 2 个助手时显得空旷 | 右栏加 1px 分隔线；高度收敛到 52vh/420px，最小 340px |
| 清空任务与上下文 | 弹窗描述与内部确认面板重复表达同一件事（“换用全新上下文”） | 删除弹窗层描述，只保留确认面板的一次完整说明 |
| 复制团队 | 结构清晰；Leader 描边偏橙 | 保留（角色识别需要），未改 |
| 解散团队 | “此操作无法撤销”与确认面板互补，不重复 | 保留 |
| 添加助手 | 列表行、计数与“助手配置”入口层级清楚 | 保留 |

### 验证

- `npm run check`：通过。
- 截图：`docs/assets/ui-review/dlg-add-member.png`、`dlg-clone.png`、`dlg-reset.png`、`dlg-dissolve.png`、`dlg-create-team.png`。
- 暗色模式沿用同一套语义 token，无新增硬编码色。

---

## 六、并行模式贴边修正

按反馈移除并行视图的外层留白：`.teamParallelRoot` 的 `padding` 由 `10px 12px 12px` 改为 `0`，列间距保持 0；移除 grid 的上下边框，避免与宿主 tab 分隔线形成双线。对话页签沿用宿主自带的成员切换器；并行页签的聊天区贴边。

验证（Harness，1280×820）：
- pane 左边界 = 内容区左边界（281），宽度 1000 = 内容区全宽；
- pane 顶部 = 76（紧贴 tab 栏底），底部 = 视口底；
- root/grid/pane 计算样式 `padding` 均为 `0px`；状态栏未被裁切（bottom 1002 / pane bottom 1006）。

截图：`docs/assets/ui-review/parallel-flush.png`。

---

## 七、页签收敛

「对话」与「单聊」功能重复（都是单成员会话），按反馈移除自定义「单聊」视图：

- 删除 `conversation.view` 的 `team-single` 注册与 `TeamSingleView` 组件；
- 移除并行 host 的单聊分支、成员胶囊、按团队记忆的 `single:<teamId>` 状态及相关样式；
- 保留宿主原生「对话」页签（顶部成员切换器可换人）。

验证：团队会话页签为 **对话 / 并行 / 看板 / 团队管理 / 轨迹**，无「单聊」；并行贴边布局不受影响。截图：`docs/assets/ui-review/tabs-no-single.png`。


---

## 八、并行成员标题栏：最大化与去背景

- 每个成员 pane 标题栏右侧新增最大化按钮（四角图标），点击后只保留该成员并铺满会话区；按钮变为还原图标，`aria-pressed` 同步，按 `Esc` 或再次点击还原。
- 标题栏去掉成员身份色的 7% 背景，活动态也不再叠加 hover 背景，只保留 1px 底部分隔线；身份仍由姓名颜色、头像和状态点表达。
- 验证（Harness）：pane 数 `3 → 1 → 3`；三列标题栏计算背景均为 `rgba(0, 0, 0, 0)`；还原按钮 `aria-pressed=true`。
- 截图：`docs/assets/ui-review/parallel-maximized.png`、`parallel-transparent-header.png`。

---

## 九、并行底部控制栏横向对齐

问题：无消息的成员 pane 使用原生 hero 布局，composer 被 hero 内容包裹而整体上移；有消息的 pane 则把 composer 钉在底部，且带一条 token/步数状态行，导致同一行三个输入框高低不一。

处理：

1. 团队并行 pane 强制使用 active shell（关闭 hero 变体），让 composer 始终钉在 pane 底部；「对话」页签仍保留原生 hero 与成员提示词。
2. 在 pane 内为状态行预留空间：`[data-team-pane] [data-composer-seat] { min-height: 128px; }`，使有/无状态行的 pane 共用同一基线。
3. 对齐验证（Harness）：三个 pane 的 `seatTop=692、seatH=128、cardTop=692、cardBottom=790`，完全一致。

截图：`docs/assets/ui-review/parallel-composer-aligned.png`。


---

## 十、标题成员选择器常驻

此前成员切换器只在「对话」页签显示（`conversationView !== undefined` 时直接返回 `null`），切到并行/看板/团队管理就消失。现已移除该条件，四个页签下都显示同一个选择器：

- 按钮文案：`切换团队成员，当前 <成员>`，带 Leader 皇冠与下拉箭头；
- 菜单仍可切换成员会话或进入「管理团队」；
- 实测四个页签 `aria-label` 与可见性一致：`visible=true`。

截图：`docs/assets/ui-review/switcher-always-visible.png`。

---

## 十一、成员下拉框贴住选择器

问题：成员选择器使用 `portal` 渲染菜单，弹层被桌面顶栏安全区钳制，菜单顶部比选择器底部低 29px，横向也向左偏 17px。

处理：移除该菜单的 `portal`，改为在锚点内就地绝对定位（`align="end"`）。原生 Menu 的就地模式会在触发器下方保留 4px 间距，并让右边缘与选择器对齐。

验证（Harness）：
- 选择器：`x=702, right=829, bottom=39`；
- 菜单：`x=685, right=829, top=43`；
- 右边缘一致，垂直间距 4px，菜单不再被顶栏安全区推远。

截图：`docs/assets/ui-review/member-menu-attached.png`。
