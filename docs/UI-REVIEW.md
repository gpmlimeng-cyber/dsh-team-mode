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

---

## 十二、添加成员改为锚定下拉面板

参考 AionUI 团队页：点击标题栏「+」不再弹模态，而是在按钮下方展开下拉面板。

实现：

- 面板右对齐锚点，间距 6px，宽 300px，最大高 440px；标题「添加成员」+ 副标题，搜索框自动聚焦，列表可滚动。
- 列表只展示「已启用且允许加入团队」的助手：头像/图标 + 名称 + 加号；支持重复添加，添加成功后通过团队事件刷新，面板保持打开便于连续添加。
- 底部提示「没有合适的？也可以直接让 Leader 帮你安排。」+「告诉 Leader →」，点击后切到 Leader 的对话页签。
- 点击面板外关闭；`Esc` 关闭并把焦点还给「+」按钮。
- 管理弹窗内的「添加助手」仍使用原模态（弹窗内再弹浮层容易裁剪，保留上下文差异）。

验证（Harness）：触发器 `right=857, bottom=39`；面板 `right=857, top=45`（6px 间距）；默认 2 个助手行；搜索后行数收敛；`Esc` 关闭。

截图：`docs/assets/ui-review/add-member-panel.png`。

---

## 十三、成员选择器与添加面板的形状对齐

- 成员选择器靠右：团队会话标题栏里让原生 `headerActions`（包含成员选择器）占满标题簇，选择器 `margin-left:auto`，最终停在宿主右侧图标组左边（实测选择器右缘 `1135`，右侧工具组从约 `1200` 开始）。
- 选择器圆角沿用 DSH token `--dsw-radius-md`（12px），与原生 trigger 一致；「+」与选择器共用外圆角。
- 添加成员面板收窄到 272px（实测含边框 274px），最大高 420px；面板圆角改用原生菜单的 `--dsw-radius-lg`（16px）。
- 搜索框改成 AionUI 风格：36px 高、无边框、`--dsw-alias-bg-module-platform` 填充（实测 `rgb(245,246,247)`）、圆角 10px、图标 16px；聚焦时仅有 1px 内描边。

截图更新：`docs/assets/ui-review/add-member-panel.png`（含选择器靠右与面板最终形态）。

---

## 十四、添加成员面板再收窄

相对成员选择器（155px 宽）面板偏大，继续压缩：

- 宽度 272 → **220px**（含边框实测 222px），最大高 360px。
- 标题 13px / 副标题 10px，内边距 12px；搜索框 36 → **32px**、图标 14px；列表行高从 48 收到约 40，头像 32 → 28；底部提示 10px/11px。
- 底部文案缩短为「没有合适的？让 Leader 帮你安排。」+「告诉 Leader →」，避免窄面板里折成三行。
- 面板圆角保持原生菜单的 `--dsw-radius-lg`（16px）。

验证：面板 `222×228`，右缘与选择器组对齐（1135）；选择器组宽 155；搜索框高 32。

截图更新：`docs/assets/ui-review/add-member-panel.png`。

---

## 十五、添加成员头像底色

问题：面板行头像用的是 `--dsw-alias-bg-layer-2`，浅色主题下三层背景都是纯白，头像看起来没有底。

处理：改用与成员卡片一致的 `--dsw-alias-bg-module-platform`（浅色实测 `rgb(245,246,247)`），文字色 `label-secondary`，圆角 7px。这样头像、搜索框、成员卡片使用同一层灰，不再出现白块。

截图更新：`docs/assets/ui-review/add-member-panel.png`。

---

## 十六、并行初始化消息界面

恢复并行 pane 的原生 hero 初始化界面（品牌标识、工作区、输入框），不再显示空白。为保持底部对齐：

- hero pane 的 `composerHero` 撑满 pane，compose 插槽 `margin-top:auto` 把输入框钉到底部。
- 空白 pane 与有消息 pane 的输入框底边对齐（实测底边 `788` / `790`）；hero 输入框因占位文案换行会高约 16px，顶部略高，属于原生 hero 形态。
- 「对话」页签不受影响；成员提示卡继续在并行视图隐藏（原设计），避免与品牌 hero 重复。

截图：`docs/assets/ui-review/parallel-hero-init.png`。

---

## 十七、并行初始化界面改为成员身份（参考 AionUI）

空白成员 pane 不再显示 DSH 品牌 hero，而是由每位成员“报身份”：

- 隐藏原生 `composerHero` 里的品牌块与工作区行，只保留输入框。
- 复用 `conversation.hero.options` 的成员提示卡并改成居中竖排：46px 圆形头像、成员名 + Leader/成员角色、成员问候语；有配置提示词时显示建议卡片（Leader 默认三条）。
- 身份区在 pane 内垂直居中，composer 仍钉在底部。
- 统一输入区高度：`[data-composer-card] [class*="scroll"] { min-height: 52px }`，三列输入框实测顶部 `676 / 674 / 676`、底部 `790 / 788 / 790`，视觉对齐。

截图更新：`docs/assets/ui-review/parallel-hero-init.png`。

---

## 十八、成员身份排版对齐原生 hero

在十七的基础上继续按反馈调整：

- 复用原生 hero 的排版结构：头像 + 大标题（成员名）+ 角色标签（`Leader` / `成员`，浅蓝胶囊）同一行居中；下面是逐字统一的备注：
  - Leader：「你好，我是 Leader，负责理解你的目标并协调团队。描述你想做的事，我来安排。」
  - 成员：「你好，我是团队成员，我听 Leader 和你的指挥。」
- Leader 备注下方展示快捷问题（有配置提示词时用配置，否则使用默认三条），成员不展示。
- 头像优先使用助手自定义头像，没有则用成员名首字母；原生品牌块与工作区行继续隐藏。
- 输入框高度统一后仍保持对齐：顶部 `676 / 674 / 676`，底部 `790 / 788 / 790`。

截图更新：`docs/assets/ui-review/parallel-hero-init.png`。

---

## 十九、模型选择器上移 + 成员渐变

- 并行 pane 输入框里的官方模型选择器整体搬到标题栏右侧（最大化按钮左边），复用原生组件，因此模型/推理菜单与选择行为不变。
- 选择器在标题栏内压缩到 132px：隐藏推理后缀、模型名省略号截断；输入框底部不再重复显示模型。
- pane 背景由纯色改为“从标题到底部渐白”的成员色渐变：
  `linear-gradient(180deg, color-mix(member 6%, base), base 64%)`，三个成员分别是蓝/绿/橙的淡色。
- 标题栏保持透明，渐变从顶部透出；输入区落在白色段，保证文字对比度。

验证：标题栏模型按钮宽 106px、`aria-label=选择模型，当前 DeepSeek-V4.1-Flash，推理等级 High`；三个 composer 的 model 槽已空（子节点 0）；pane `background-image` 为渐变。

---

## 二十、并行成员名加粗

- 标题栏成员名：`font-size 13→14px`，`font-weight 500→600`，加 `letter-spacing: 0.01em`，颜色继续用成员色。
- 实测计算样式：`600 / 14px / rgb(77,147,248)`（Leader 列）。
- 其余标题栏元素（状态点、模型、最大化）不变。

---

## 二十一、模型选择器随宽度自适应

- 标题栏成员身份改为 `flex: 0 1 auto`，右侧操作区 `flex: 1 1 auto`，模型选择器 `flex: 1 1 auto`：宽度完全由 pane 宽度决定，没有固定像素上限。
- 模型名 `flex: 1; min-width: 0; white-space: nowrap; text-overflow: ellipsis`，只截断不换行；推理后缀隐藏。
- 容器查询按选择器自身宽度降级：≤88px 隐藏文字，≤56px 只留模型图标（连箭头也隐藏）。
- 实测：pane 标题栏 333px 时选择器 162px；标题栏 440px（窗口 1600）时 269px，模型名完整展开；窗口 1000 时仍为 333/162，三列最小宽度不变。
- 同时把 pane 渐变延伸到引导区：`0% 6% → 72% 2% → 94% 底色`，初始化界面使用聊天背景，不再出现白色断层。

截图：`docs/assets/ui-review/parallel-hero-init.png`（更新中）。

---

## 二十二、渐变最终形态

- 找到白底真正来源：原生 `composerSeat` 给顶部 36px 铺了 `linear-gradient(transparent, #fff)` 的白色渐隐，把成员色盖掉了。并行 pane 内已强制 `background-image: none`。
- 去掉白盖后渐变才真正透出；按反馈把浓度降到非常浅：
  `0% 成员色 4% → 68% 成员色 2% → 94% 底色`。
- 实测像素（最大化绿色成员 pane）：10% `(247,252,249)`、50% `(249,253,251)`、90% `(255,255,255)`，肉眼隐约可见，底部收白。
- 标题栏模型选择器：宽度随 pane 自适应（333px 标题栏 → 162px；440px → 269px），文字只省略不换行；≤88px 隐藏文字、≤56px 只留图标。

截图更新：`docs/assets/ui-review/parallel-hero-init.png`。

---

## 二十三、改为 AionUI 的中性浅色

背景不再使用成员身份色的高饱和混合，而是按成员序号取 AionUI 实测的近白中性色：

| 序号 | 顶部颜色 | RGB |
| --- | --- | --- |
| 1 | `#F9F9F8` | (249,249,248) |
| 2 | `#F9FBFB` | (249,251,251) |
| 3 | `#FCFAF9` | (252,250,249) |
| 4 | `#FAF9FC` | (250,249,252) |

渐变：顶部原色 → 70% 处与白混合 55% → 94% 收白。最大化 pane 采样：10% `(249,249,248)`、50% `(251,251,250)`、90% `(255,255,255)`；背景只剩极轻的冷暖差，成员身份色仅用于头像/姓名。

---

## 二十四、成员名称改用 AionUI 色

按 AionUI 团队页标题栏实测取色，替换原来的高饱和身份色：

| 角色/成员 | Light | 实测 RGB |
| --- | --- | --- |
| Leader | `#5F5E5A` | (95,94,90) |
| 成员 2 | `#689BA3` | (104,155,163) |
| 成员 3 | `#AF8D63` | (175,141,99) |
| 后续成员 | 灰紫/橄榄/豆沙/石板蓝/灰棕 | — |

- 使用 `light-dark(light, dark)` 定义，暗色主题自动切到对应的浅色变体（如 `#B9B7B0`、`#9FC6CC`）。
- 名称仍保留 14px / 600；颜色只作用于头像、姓名和状态点，画布保持中性近白。
- 实测三列名称计算色分别为 `rgb(95,94,90)`、`rgb(104,155,163)`、`rgb(175,141,99)`。

---

## 二十五、标题头像改为 AionUI 圆形

- pane 标题栏头像：`border-radius: 50%`、22px 圆形，深色底（`label-primary`）+ 白色首字母，与 AionUI 的黑色圆形标识一致。
- 若成员助手配置了自定义头像，直接渲染为圆形图片（`object-fit: cover`）；没有头像时回退首字母。
- 实测计算样式：`radius=50%`、`22×22`、`background rgb(15,17,21)`、`color rgb(255,255,255)`。

---

## 二十六、标题头像复用 DSH 账号头像组件样式

之前用深色底 + 自定义圆角，视觉上仍像圆角方块；现改为与左栏底部账号头像一致的实现：

- 新增共享 `MemberAvatar`：`border-radius: 50% !important`、`overflow: hidden`，图片 `object-fit: cover`，字母回退。
- 底色使用账号头像的 `color-mix(label-primary 4%, transparent)`（实测 `rgba(15,17,21,0.04)`），不再是深色块。
- 标题栏 24px，初始化 hero 44px；有自定义头像时直接显示圆形图片，否则显示成员首字母。
- 实测：24/44px、`radius=50%`、`overflow=hidden`、背景 `rgba(15,17,21,0.04)`。

---

## 二十七、头像不是圆形的根因

DSH 全局设置了 `corner-shape: superellipse(1.5)`，所以即使 `border-radius: 50%`，浏览器也会把角渲染成“圆角方块”（squircle），单独调圆角当然无效。

左栏账号头像之所以是正圆，是因为它的组件显式设置了 `corner-shape: superellipse(1)`。现已照抄：

```css
.memberAvatar {
  corner-shape: superellipse(1);
  border-radius: 50% !important;
  overflow: hidden;
}
```

标题栏 24px、hero 44px 均为正圆；截图放大验证为圆形而非 squircle。团队会话顶部的成员切换头像也同步加上。

---

## 二十八、内置 AionUI 助手头像

助手编辑器新增「内置头像」选择：

- 从 AionUI 的 assistant 资源中内置 6 张头像：学术论文、AionUI 助手、数据看板、Excel、PPT、Word。
- 以 data URL 打包（约 49KB），无需额外静态资源路由；选中后直接写入 `avatar`，与上传头像走同一字段。
- 图标为 40px 正圆（同样设置 `corner-shape: superellipse(1)`），选中态 `aria-pressed=true` + 2px 描边；点击后头像预览立即出现。
- 仍保留原有上传/移除头像逻辑。

截图：`docs/assets/ui-review/assistant-builtin-avatars.png`（待补）。

---

## 二十九、内置全部 20 个 AionUI 助手头像，并移除重复的 emoji 图标

- 助手编辑器的「图标（emoji）」与「头像（图片）」功能重复（头像优先），已删除图标字段、保存参数与卡片标题里的 emoji 前缀；老数据里残留的 icon 不再展示，schema 保留以兼容旧记录。
- 名称字段改为占满整行，头像与说明并排。
- 内置头像从 6 个扩展到 AionUI 官方 21 个助手中的人像 20 个（排除表单型 OpenClaw 助手）：
  学术论文、AionUi 管家、Beautiful Mermaid、Cowork、数据仪表盘、Excel、财务建模、3D 游戏、HUMAN 3.0 教练、moltbook、3D Morph PPT、Morph PPT、OpenClaw 部署专家、路演 PPT、文件规划、PPT 演示、社交招聘、故事角色、UI/UX、Word。
- 头像从 aioncore 内置资源提取，缩到 160px/JPEG 后以 data URL 打包（模块约 144KB）；选择后写入 `avatar`，与上传共用保存逻辑。
- 验证：编辑器内 20 个「使用…头像」按钮，标签与官方助手名对应，40px 正圆网格。

截图更新：`docs/assets/ui-review/assistant-builtin-avatars.png`。

---

## 三十、DiceBear 自动生成头像

助手编辑器头像行新增「自动生成」：

- 使用 DiceBear 9.x 的 `adventurer` 人像风格，seed 由「助手名 + 随机串」组成，每次点击得到不同头像。
- 浏览器 `fetch` 取回 SVG 后转成 `data:image/svg+xml` 写入 `avatar`，不依赖运行时外链，离线也能显示；失败时在表单错误区提示。
- 生成中按钮显示「生成中…」并禁用；生成后头像预览立即出现。
- 与「上传图片 / 移除头像 / 20 个内置头像」并存。

验证：点击后预览 `src=data:image/svg+xml;charset=utf-8,…`，`naturalWidth=150`。
截图：`docs/assets/ui-review/assistant-dicebear.png`。

---

## 三十一、DiceBear 风格可选

「自动生成」旁增加风格选择：

冒险家 / 卡通 / 笑脸 / 手绘 / 极简 / 线稿 / 简笔 / 人物 / 像素 / 点赞（adventurer、avataaars、big-smile、lorelei、micah、notionists、open-peeps、personas、pixel-art、thumbs）。

- 默认「冒险家」；切换后下一次生成使用对应风格。
- 仍取回 SVG 并转 data URL 保存；实测切到「手绘」生成后预览为 9.4KB SVG、`naturalWidth=150`。
- 风格选择只影响自动生成，不改变已选头像。

---

## 三十二、头像选择改为弹窗

- 编辑器头像行只保留「选择头像 / 移除头像」，点击打开「选择头像」弹窗。
- 弹窗内容：
  - AionUI 内置 20 个头像；
  - DiceBear 7 个风格（机器人 Bottts、浮雕 Cameo、黏土 Clay、小动物 Critters、凝视 Gaze、情绪 Moods、点赞 Thumbs），每个风格一行、每行 8 个 Preview；
  - 底部「随机一个」按钮，随机风格 + 随机 seed；
  - 顶部「本地上传」，沿用 PNG/JPEG/WebP ≤256KB 限制。
- 点击 Preview 时取回 SVG 并以 data URL 写入头像，随后关闭弹窗；随机按钮同样处理。
- 实测：7 行、每行 8 个、共 56 个 Preview；20 个内置头像；随机/上传按钮存在；点选后预览为 data SVG（150×150）。

截图：`docs/assets/ui-review/assistant-avatar-picker.png`。

---

## 三十三、桌面端启动失败修复（dsh-auth Cookie 累积）

- 现象：`DeepSeek Harness` 启动时报 `desktop welcome: Web authentication failed`，窗口停在欢迎页。
- 原因：每次重启宿主都会写入一个新的 `dsh-auth-*` Cookie（以 token 命名），反复重启后 `127.0.0.1` 下累积了大量过期 Cookie；欢迎请求携带多个同名前缀 Cookie，宿主无法匹配当前 token，返回非 2xx。
- 修复：退出应用后清理该 profile 的 `dsh-auth-*` Cookie，再启动生成唯一的新 Cookie：

```bash
sqlite3 "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies" \
  "delete from cookies where host_key='127.0.0.1' and name like 'dsh-auth-%';"
```

- 验证：清理后应用正常进入工作区，CDP 页面可访问，未再新增 crash-host 日志。

---

## 三十四、头像分类合并为「职业」

- 「AionUI 内置」改名为「职业」，与 DiceBear 各风格并列为同一级分类。
- 去掉「AionUI 内置」「DiceBear 风格」两个分组标题，弹窗内只剩一行一个分类：
  `职业`（20 个）、`机器人`、`浮雕`、`黏土`、`小动物`、`凝视`、`情绪`、`点赞`（各 8 个）。
- 职业行是 8 列网格，20 个头像自然换成 3 行；标签与首行顶部对齐。
- 打开弹窗时滚动位置重置到顶部，不会停在上一类中间。

实测：8 行分类，数量 `[20,8,8,8,8,8,8,8]`，无分组标题。
截图更新：`docs/assets/ui-review/assistant-avatar-picker.png`。

---

## 三十五、头像弹窗的预览框与并排操作

- 弹窗顶部「本地上传」「随机一个」并排；底部只保留「使用这个头像」。
- 新增 64px 圆形预览框，随点击职业头像、DiceBear Preview、随机、上传实时更新；无头像时显示「未选择」。
- 选择改为草稿态：点选只更新预览，不立即关闭；点「使用这个头像」才写回编辑器，关闭弹窗则放弃。
- 实测：点 Preview 后预览框出现 data SVG（150×150），弹窗保持打开；确认后编辑器头像更新、弹窗关闭。

截图更新：`docs/assets/ui-review/assistant-avatar-picker.png`。
