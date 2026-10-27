# DeepSeek-Bot 群聊行头像实测（几何 / 状态 / 数据）

> 2026-10-27 · 只读调查，未改任何业务代码 · 任务：`dsbot-avatar` t1
> 参考实现：`Fei2411/DeepSeek-Bot` @ `de55888`（本机 `/Users/limeng/DSH/_ext/DeepSeek-Bot`，只读）
> 本仓库：`/Users/limeng/DSH/团队/dsh-team-mode` @ `1cb0ed2`
> 方法：从 `sidebar.js` 的群聊行入口追到 `mark.js` 的 `RoomAvatar`，再对 `styles.js` 的规则与行内样式做公式换算；所有 px 值都是按 `size = 36`（侧栏行实际传值）算出的精确值，并用仓库自带截图 `docs/images/group.png` / `team.png` 做视觉复核。视觉观感、主题 token 的最终匹配标「待实测」。

---

## 0. 先纠一个前提：群聊行不是横向堆叠

参考实现里**侧栏群聊行**（`sidebar.js` 的 `RoomRow`）画的是 **36px 的 cluster（绝对定位座位）**，不是横向叠头像：

- 2 人：两张脸**左上 → 右下对角**，各 24px；
- 3 人：**1 上 2 下**的正三角，各 20px；
- 4 人：规整 **2×2**，各 18px；
- 超过 4 人：**前 3 张脸 + 第 4 格 `+N`**，`+N` 是 16.56px 的圆盘。

DeepSeek-Bot 里唯一的「横向重叠头像」是群详情抽屉的 `MemberPile`（44px、`-10px`、3px 底色环），它是抽屉标题，不是群聊行。见 §1.4。

所以本任务给出的现状（最多 2 个 / 20px / `-8px` / 2px 环 / 18px 胶囊）**不能靠调几个数值对齐**：布局形态要换。若产品坚持横向堆叠，那对齐目标只能是抽屉的 `MemberPile`，而它放不进 36px 行首槽位。

### 0.1 截图校准（用户截图 + 仓库自带截图）

参考仓库自带的截图就是同一套群聊行，可直接当一手视觉证据：

- `docs/images/team.png`、`docs/images/group.png`（本机 `/Users/limeng/DSH/_ext/DeepSeek-Bot/docs/images/`）：3 人群 "Content & Code" 的行首是 **蓝鲸在顶部居中、橙猫在左下、青星在右下**，三张脸各 20px、无白边、缝隙约 2px；**脸本身没有方形底板**。
- 用户截图里看到的「圆角方形磁贴」其实是**整行的选中/hover 背景**：`.bt-row` 是 `border-radius:10px` 的圆角块（`styles.js:137-139`），选中时 `[aria-current=page]` 填 `--bt-active`（`styles.js:139`）；头像本身是透明背景的吉祥物，不是磁贴。
- 3 人「1 上 2 下」与源码坐标一致（`mark.js:129-133`），2 人「左上→右下」也与源码一致（`mark.js:128`）；仓库截图直接可见 3 人构图。
- 仓库截图里没有 5 人以上的例子；`+N` 的规则以源码为准（见 §1.3）。

> 结论：除「每格是圆角方形磁贴」这一句外，截图与源码一致；该句已由**行选中背景**解释。真实的 2/3 人构图是绝对定位的对角/三角，不是 CSS grid 自动流；头像是透明底的吉祥物/圆形照片，不是方块磁贴。

---

## 1. 群聊行头像的实测值（`size = 36`）

数据链：`room.members` → `roster.byId` → `BotMark`（上传图或吉祥物）→ `RoomAvatar` 的 cluster。

### 1.1 绘制函数与调用点

| 环节 | 位置 |
|---|---|
| 群聊行调用 | `ds-bot/src/client/sidebar.js:118` — `h(RoomAvatar, { room, roster, size: 36 })` |
| 群聊行布局 | `ds-bot/src/client/styles.js:137` — `.bt-row{display:flex;align-items:center;gap:8px;min-height:54px;padding:8px;…}` |
| 头像组件 | `ds-bot/src/client/mark.js:138-170` — `RoomAvatar` |
| 座位公式 | `ds-bot/src/client/mark.js:126-136` — `clusterSeats(count, frame)` |
| 容器/座位 CSS | `ds-bot/src/client/styles.js:115-118` — `.bt-cluster` / `.bt-cluster-more` |
| 照片内描边 | `ds-bot/src/client/styles.js:29` — `.bt-mark-img{…box-shadow:inset 0 0 0 1px var(--bt-line)}` |
| 行末未读点 | `ds-bot/src/client/styles.js:145-146` — `.bt-unread` / `.bt-unread-wait` |

### 1.2 七个问题的回答

| # | 问题 | 实测结论 | 证据 |
|---|---|---|---|
| 1 | 最多几个？尺寸？重叠（负 margin）？ | **4 个座位**：正好 4 人时 4 张脸；>4 人时 **3 张脸 + `+N`**（不再画第 5 张）。`size=36` 时脸径：2 人 **24px**、3 人 **20px**、4 人/溢出 **18px**。**没有负 margin**，座位用 `position:absolute` + `left/top`；相邻处由**透明遮罩缺口**分开：遮罩半径 padding = `size/14 = 2.571px`，实际可见缝 ≈ **2.09–2.21px**（`2.571 - 0.02×脸径`）。 | `mark.js:126-136,152-163`；CSS `styles.js:115-116` |
| 2 | 描边 / 白边？宽度？颜色 token？ | **头像之间没有描边**。分隔靠 `mask-image` 在后画的脸上切出透明环（`r = 脸径×0.48 + 2.571`），透出的是**行/页面自己的背景**，所以 hover/active 变色也不会露白圈。实际缝宽 = `r - 脸径/2`：24px 脸 **2.09px**、20px 脸 **2.17px**、18px 脸 **2.21px**。上传照片自身有 `inset 0 0 0 1px var(--bt-line)`（`rgba(20,20,20,.08)` / 暗色 `rgba(255,255,255,.08)`）的极淡内边，仅收图片边缘。 | `mark.js:154-163`；`styles.js:21,24,29` |
| 3 | 超出有 `+N` 吗？尺寸/字号/底色/边框？ | 有。**圆形**，不是胶囊：`width = height = s×0.92 = 16.56px`，`margin = s×0.04 = 0.72px`，`font-size = max(8, round(s×0.36)) = 8px`，`font-weight:500`，`border-radius:50%`，`background: var(--bt-active)`，`color: var(--bt-ink-3)`，**无边框/无外环**。亮色 `--bt-active = rgba(119,119,119,.17)`、`--bt-ink-3 = rgba(20,20,20,.36)`；暗色 `rgba(160,160,160,.2)` / `rgba(242,242,242,.36)`。它**占据第 4 个座位**；相邻的前几张脸会被它切出缺口。 | `mark.js:153,164-165`；`styles.js:117` |
| 4 | 单人画什么？零人画什么？ | 单人（房间里只剩 1 个 Bot）：**24px 的 Bot + 22.08px 的“你”圆盘**（`seatSize×0.92`，`margin: 0.96px`），圆盘底色 `color-mix(in srgb, var(--bt-ink) 12%, transparent)`，**没有字/图标**。零人：`BotMark` 无 bot，回退 **36px 黑色 gumdrop**（`FALLBACK_SHAPE='gumdrop'`）；这是防御分支，正常群至少 2 个 Bot，store 也会删掉失效成员。 | `mark.js:140-145`；`characters.js:37,68-75`；`roster.js:367-369,198-202` |
| 5 | 排序 & 头像来源 | **排序 = `room.members` 数组顺序**，客户端不排序、不按活跃、不把管理员提前。创建时按入参去重顺序写入，加人时 append 到末尾。头像来源：**上传图（始终 data URL）优先**，否则用**按 bot id 派生的吉祥物**（形状 `defaultShape(id)`、颜色取存储 color 或 id 派生）；**不用首字**。 | `mark.js:139`；`roster.js:376-402,431-433,516`；`characters.js:37,68-75`；`host/avatar.js:2,37` |
| 6 | 状态叠加？ | **头像内部没有任何状态叠加**：cluster 里的 `BotMark` 用默认 `state='idle'`、`live=false`，没有 working 点、没有忙碌环、没有未读点。未读/待确认点在**行的最右端**：8px 圆，`--bt-accent`（`#4d6bfe`）/待审批用 `--bt-star`（`#ff9800`），`margin-right:2px`。行 hover 只换背景；头像上的 `::before`（`inset:-20%`）是**透明的抚摸命中区**，不是可见环。 | `mark.js:142-143`；`styles.js:52,145-146,137-139` |
| 7 | 容器总宽 / 文字起点 | 容器 **36×36**（`flex:none`），行 `padding:8px` + `gap:8px`，所以**文字从行左边缘 52px 开始**；两行内容总高 38px（`min-height:54px - 2×8px`），36px 头像上下各留 1px。 | `mark.js:157`；`styles.js:137`；CSS `styles.js:115` |

### 1.3 座位坐标（`size=36`，精确值）

| 成员数 | 座位数 | 脸径 `s` | 位置 `(left, top)` | 备注 |
|---|---|---|---|---|
| 1（仅函数支持） | 1 | 36 | (0, 0) | 实际房间不会走到：1 个 Bot 会变成 `[bot, you]` |
| 2 | 2 | 24 | (0, 0)、(12, 12) | 斜对角；后画的“你”/第二人切前一张 |
| 3 | 3 | 20 | (8, 0)、(0, 16)、(16, 16) | 1 上 2 下：顶部居中 + 左下 + 右下；`rest = 36-20 = 16` |
| 4 | 4 | 18 | (0, 0)、(18, 0)、(0, 18)、(18, 18) | 田字格；`half = 18` |
| ≥5 | 4 | 18 | 同上，第 4 格换成 `+N` | 显示前 3 人 + `+(n-3)` |

**源码原样坐标（`mark.js:126-136`，`frame = size`）**，t2 直接照抄，不要重新发明：

```js
function clusterSeats(count, frame) {
  if (count === 1) return [[0, 0, frame]]
  if (count === 2) return [[0, 0, frame * 2 / 3], [frame / 3, frame / 3, frame * 2 / 3]]
  if (count === 3) {
    const size = frame * 5 / 9
    const rest = frame - size
    return [[rest / 2, 0, size], [0, rest, size], [rest, rest, size]]
  }
  const half = frame / 2
  return [[0, 0, half], [half, 0, half], [0, half, half], [half, half, half]]
}
```

`transform: translate(...)` 不是源码的做法；源码是 `position:absolute` + `left/top`（`mark.js:162`），容器 `position:relative`（`styles.js:115`）。`size=36` 的换算结果就是上表。

**填充顺序不是行优先**：

- 2 人：先左上 `(0,0)`，再右下 `(12,12)` —— **左上 → 右下**；
- 3 人：先顶部居中 `(8,0)`，再左下 `(0,16)`，最后右下 `(16,16)` —— **1 上 2 下**，不是上二下一；
- 4/5+：左上 → 右上 → 左下 → 右下（这时才等价于行优先）；
- `+N` 只出现在 **≥5 人**，位置固定是 `(18,18)`（右下第 4 格），不会去填 3 人构图的空位。`N = 总人数 - 3`（源码 `overflow = people.length > 4 ? people.length - 3 : 0`，`mark.js:153`；`people.length` 已把「1 个 Bot + 你」算成 2）。5 人 = `+2`、6 人 = `+3`、12 人（群上限）= `+9`。

缺口公式（`mark.js:155-163`）：`gap = 36/14 = 2.5714px`；后画的座位中心为圆心，`r = s×0.48 + gap`，遮罩从 `transparent r` 到 `#000 r+0.5`，只作用于**先画**的座位；`mask-composite: intersect`（WebKit 用 `source-in`）。可见缝是 `r - s/2`，即 **2.09–2.21px**，不是 2.571px。

```
2 人 (24px)                3 人 (20px)              4 人 / 溢出 (18px)
┌──────────────┐           ┌──────────────┐         ┌──────────────┐
│ ●●●●         │           │    ●●●●      │         │ ●●●●  ●●●●   │
│ ●●●●         │           │    ●●●●      │         │ ●●●●  ●●●●   │
│      ●●●●    │           │ ●●●●  ●●●●   │         │ ●●●●  ●●●●   │
│      ●●●●    │           │ ●●●●  ●●●●   │         │ ●●●●  ●●●●   │
└──────────────┘           └──────────────┘         └──────────────┘
  0,0 + 12,12                8,0 / 0,16 / 16,16      0/18 网格；>4 人时右下格是 +N
```

> 截图校准：`docs/images/group.png` 的 3 人群正是「顶部居中 + 左下 + 右下」，与上表逐格吻合；行首外圈那层圆角灰底是 `.bt-row[aria-current=page]` 的选中背景，不是每个头像的磁贴。

### 1.4 横向堆叠只存在于这两处（容易混淆）

| 位置 | 用途 | 值 |
|---|---|---|
| `details-drawer.js:123-130` 的 `MemberPile` | 群详情抽屉的大头像 | 脸 **44px**，相邻 `margin-left:-10px`（步进 34px，重叠 22.7%），**3px** `--bt-main` 外环；最多 4 格，>4 人显示前 3 + `+N`；`+N` 也是 44px 圆盘、`font-size:13px`、底色 `--bt-hover`、字色 `--bt-ink-2`（`styles.js:367-370`） |
| `mark.js:147-151` 的 `bt-stack` | 仅在 `size ≤ 20` 的内联场景（如消息内提及、日程） | 脸 = `size`，相邻 `margin-left: size × -0.3`；>3 人时 `+N` 只是**文字**（11px/16px 行高、`--bt-ink-3`、左移 3px），没有圆底（`styles.js:119-121`） |

侧栏群聊行 `size=36`，走的是 cluster，不走上面两条。

### 1.5 行标题 / 副标题（会影响 t2 的行结构）

| 项 | 规则 | 证据 |
|---|---|---|
| 标题 | `room.name`。未自定义名称的群，`autoRoomName = ['You', ...成员名].join(', ')`，分隔符是**英文逗号 + 空格**；成员改名后自动跟随。自定义名优先（`named: true` 时不再跟随）。 | `roster.js:338,342,360-365,387-402`；`sidebar.js:121` |
| 名字截断 | **源码没有「最多 N 个名字」的规则**。Bot 名上限 40 字符（`roster.js:133,268`），自定义群名上限 60（`ROOM_NAME_MAX`），群上限 12 个 Bot；整串名字交给 CSS `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` 截断。所以「You, Chief, 架构师, 后端, 前…」是**行宽截断**，不是数据层截断。 | `roster.js:133,268`；`constants.js:56`；`styles.js:142` |
| 副标题 | 优先取「正在工作」的行（`workingLine`）；否则取 `room.preview`；二者都没有才为空。`preview` 由 Host 取 `log` 里最后一条 `kind === undefined` 的记录：最后发言人是用户就只放原文，是 Bot 就 `${who}：${text}`（**中文全角冒号**）。客户端再把连续空白压成单个空格。 | `sidebar.js:101-102,107-109,121-122`；`channel.js:52-53` |
| 副标题兜底 | Host 没有 `preview` 时，`RoomRow` 用 session 列表的 `previewOf` 兜底。 | `sidebar.js:101,122` |
| 用户是否入图 | **不入图**。`room.members` 只存 Bot id；「You」只出现在自动标题里，只有「群里只剩 1 个 Bot」时头像才补一个“你”的圆盘。 | `mark.js:139-141`；`roster.js:338` |

> 对我们：当前团队行标题是 `team.name`，副标题是 `teamSidebarStatusText(summary)`；要对齐参考实现的行结构，t2 需要把标题改成「`You` + 成员名」的自动拼接（自定义名优先），副标题改成「最后一条消息的 `发言人：内容`」，并保留「有人工作时显示工作行」的优先级。这属于**行结构改动**，不在「头像几何」的最小改动里，需单独定契约。

---

## 2. 与我们的现状逐项对比

我们的代码：`src/client/team-avatar.ts:53-88`（`teamAvatarStack`）、`src/client/sidebar.tsx:597-610`、`src/client/AgentTeam.module.css:11735-11767`。基线 `1cb0ed2`。

| 项目 | DeepSeek-Bot 群聊行（36px） | 我们（`1cb0ed2`） | 差异 |
|---|---|---|---|
| 布局 | **cluster**，绝对定位：2 人对角（0,0→12,12）、3 人 1 上 2 下（8,0 / 0,16 / 16,16）、4 人 2×2（18px 网格） | **横向堆叠**（`inline-flex`） | 形态不同，调数值无法对齐 |
| 可见脸数 | 4 人内最多 4 张；>4 人 = 3 张 + `+N`（第 4 格） | 固定 2 张 + `+N` | 我们少一张脸 |
| 脸径 | 24 / 20 / 18（随人数） | 20（固定） | 2 人时我们小 4px |
| 重叠 / 间距 | 无负 margin；遮罩可见缝 **2.09–2.21px** | `margin-left:-8px`；每张脸 `2px` 底色外环 | 步进 12px；环色写死 `bg-layer-1` |
| 描边 | 无；照片仅 1px `inset` `--bt-line` | **2px** `box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1)` | hover/active 时环色不跟随行背景，会露浅圈 |
| `+N` | 16.56px 圆，8px 字，`--bt-active` 底，`--bt-ink-3` 字，无边框 | 18px **胶囊**，9px 字，`bg-module-platform` 底，`label-secondary` 字，2px 外环 | 形状/尺寸/配色都不同 |
| 单人 | Bot 24px + “你” 22.08px 圆盘 | 单张 20px，无“你” | 少一个占位 |
| 零人 | 36px 默认 gumdrop | 空容器（无脸、无回退） | 退化态不同 |
| 排序 | `room.members` 插入顺序，管理员不前置 | 队长优先，再按 id | 严格对齐需去掉排序；若保留则是产品决策 |
| 头像来源 | 上传 data URL → 吉祥物 | data: 上传图 → 首字 | 吉祥物回退需要 `assistantSnapshot` 带 mascot（当前 schema 没有，见 §4） |
| 状态 | 头像内无状态；行末 8px 未读/待审批点 | 头像内无状态；行末有状态点/待确认 badge | 大体一致 |
| 容器 / 文字起点 | 36×36；行 `8+36+8` → 文字 **52px** | 容器 `width:36px`；`row gap 8` + 展开箭头，文字在 **66px** | 容器同宽，但内容按 border-box 实际 44px，溢出容器 8px（20+12+12），胶囊末端恰好顶到文字起点 |

我们当前的具体算术（便于改后回归）：

- 两张脸：`20 + (20-8) = 32px`；再加 `+N`：`32 + (18-6) = 44px` > 容器 36px（DSH 全局 `*{box-sizing:border-box}`）；
- 视觉外径因 2px 环变成 24 / 22，但环不占布局；
- 团队行：外层 `padding: 3px 8px`、箭头 `14px`（`margin-left:-4px; margin-right:-2px`）、外层 `gap:6px`、行内 `gap:8px` → 头像左边缘 22px、文字 66px（`AgentTeam.module.css:9372-9374,9479-9498,3569-3572`）。

---

## 3. 可直接执行的最小改动清单（对齐群聊行）

> 目标：侧栏团队行在 36×36 槽位内复刻 `RoomAvatar` 的 cluster。**本任务只出文档，不改代码**；下面是施工单。

### 决策点（先定，再改）

| 编号 | 决策 | 建议 |
|---|---|---|
| D1 | cluster 还是继续横向堆叠？ | **cluster**。参考实现侧栏群聊行的真实形态（源码 + `docs/images/group.png` 截图一致），也唯一能塞进 36px；横向堆叠的对齐目标 `MemberPile` 是 44px 抽屉头像。 |
| D2 | 是否保留“队长优先”？ | 严格对齐 = **去掉**，用 `Object.values(members)` 的插入顺序（ds-bot 不排序）。若产品坚持队长优先，保留并在评审里标为有意差异。 |
| D3 | 无上传图时画什么？ | ds-bot 是吉祥物，我们是首字。**本轮不扩 schema**（`assistantSnapshot` 只有 `avatar`，`schemas.ts:28-43`），继续首字；标「待实测/后续」。 |
| D4 | 行标题/副标题是否一起改？ | **拆开**。头像几何用本清单；标题「`You`, 成员名」与副标题「`发言人：内容`」是行结构变更，按 §1.5 另立契约（t2 若只做头像，不要顺手改行文本）。 |

### 改动 1：`src/client/team-avatar.ts`

| 位置 | 现在 | 改成 |
|---|---|---|
| `:61-66` | `Object.values(members).sort(队长优先, id)` | `const ordered = Object.values(members)`（D2 选严格对齐时） |
| `:76` | `faces.slice(0, 2)`，`extra = n-2` | `const extra = Math.max(0, faces.length - 3)`；`const shown = extra > 0 ? faces.slice(0, 3) : faces.slice(0, 4)`；返回 `{ faces: shown, extra }` |
| 新增导出 | — | `clusterSeats(count, frame)`，直接照抄 `mark.js:126-136` 的 4 组坐标（见 §1.3），避免把布局常量散进 JSX |

> 注意：`faces` 的字段名可以保留，调用方只关心数量；单人时组件需要知道「只有 1 张脸」来补“你”座位，可用 `faces.length === 1` 判断。

### 改动 2：`src/client/sidebar.tsx:597-610`

| 位置 | 现在 | 改成 |
|---|---|---|
| `:597` | `span.sidebarTeamAvatarStack` 内 `inline-flex` 顺序排 | 容器不变；内部改为按 `clusterSeats(...)` 输出**绝对定位座位**：每个座位 `style={{ left, top, width: s, height: s }}` |
| `:599-605` | `MemberAvatar size={20}` | `size={s}`（24 / 20 / 18），外层包一个 `span.sidebarTeamAvatarSeat` 承载 `left/top` |
| `:607-608` | `avatarStack.extra > 0` 时追加胶囊 | `extra > 0` 时把 **第 4 个座位 `(18,18)`** 渲染成 `+N` 圆盘（16.56px / 0.72px margin / 8px 字），不再追加到行尾 |
| 单人 | 一张 20px 脸 | `faces.length === 1` 时补一个“你”座位：`22.08px`，`margin: 0.96px`，`background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)`，无字 |
| 精确座位 | — | 2 人：`[{0,0,24},{12,12,24}]`；3 人：`[{8,0,20},{0,16,20},{16,16,20}]`；4 人：`[{0,0,18},{18,0,18},{0,18,18},{18,18,18}]`；5+：同 4 人，但第 4 个换成 `+N`（`16.56`，`margin 0.72`） |
| 缺口 | — | 对每个被后续座位压到的先画座位设置 `mask-image`（照抄 `mark.js:155-163` 的 `radial-gradient` + `mask-composite: intersect` / `-webkit-mask-composite: source-in`） |

### 改动 3：`src/client/AgentTeam.module.css:11735-11767`

| 选择器 | 现在 | 改成 |
|---|---|---|
| `.sidebarTeamAvatarStack` | `display:inline-flex; width:36px` | `position:relative; display:block; width:36px; height:36px; flex:none` |
| `.sidebarTeamAvatarFace` | `position:relative; box-shadow: 0 0 0 2px bg-layer-1` | `position:relative; box-shadow:none`（缺口交给 mask；照片内边可用 `inset 0 0 0 1px var(--dsw-alias-line-…)` 对应 `--bt-line`） |
| `.sidebarTeamAvatarFace + .sidebarTeamAvatarFace` | `margin-left:-8px` | **删除**（绝对定位，无流式 margin） |
| `.sidebarTeamAvatarSeat`（新增） | — | `position:absolute; line-height:0` |
| `.sidebarTeamAvatarChip` | `18px` 胶囊、`margin-left:-6px`、`padding:0 4px`、`999px`、`bg-module-platform`、2px 环、9px 字 | `position:absolute; width:16.56px; height:16.56px; margin:0.72px; padding:0; border-radius:50%; border:0; box-shadow:none; background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-tertiary); font-size:8px; font-weight:500; line-height:1; font-variant-numeric: tabular-nums` |

> 颜色映射：ds-bot `--bt-active` 亮色 `rgba(119,119,119,.17)`；DSH `--dsw-alias-interactive-bg-active` 亮色 `#2631481a`（约 10%），偏浅。**待实测**：在亮/暗两套主题下对比，必要时用 `color-mix(in srgb, var(--dsw-alias-label-primary) 17%, transparent)` 精确到 17%。字色 `--dsw-alias-label-tertiary` 与 `--bt-ink-3` 的 36% 对齐。

### 改动 4：默认尺寸 / 退化态

- 容器保持 36px，**不要**为了 cluster 改成 44px：44px 会撑破两行团队行（内容高 38px）。
- 零成员：至少渲染一个 36px 的团队身份占位，不要留空；用现有 32px `.sidebarTeamAvatar` 放大到 36 或在 `MemberAvatar` 里用 `team.name` 首字，**待实测**哪种更接近参考的 gumdrop。
- 单人：按 §1.2 第 4 条补“你”圆盘；这是 ds-bot 的明确行为，不是装饰。

### 改动 5（可选，行结构；不属于头像最小改动）

如果 t2 的契约包含行结构，按 §1.5 落地：

| 项 | 参考值 | 我们现在 |
|---|---|---|
| 标题 | 未自定义 = `['You', ...成员名].join(', ')`；自定义名优先；不按名字个数截断，CSS ellipsis | `team.name` |
| 副标题 | 有人工作 → 工作行；否则最后一条消息，Bot 用 `who：text`、用户用原文；空白压缩 | `teamSidebarStatusText(summary)` |

这项会改 `sidebar.tsx` 的 `renderTeamRow` 与数据派生，和头像不在同一个最小 diff 里；建议单独任务。

### 验证清单（实现后）

1. 成员数 1 / 2 / 3 / 4 / 5 / 12 各截一张亮色图；确认 2 人 `24px` 左上→右下、3 人 `20px` 顶部居中 + 左下 + 右下、4 人 `18px` 2×2、5+ 人 3 脸 + 右下 `+N`。
2. 行 hover / 选中时看缺口是否仍透出当前背景（mask 方案应无浅圈；ring 方案会露 `bg-layer-1`）。
3. 文字起点仍为 66px（我们含箭头）且 `+N` 不再溢出容器（容器内最右 = 36px）。
4. 上传头像与首字回退都试；照片内边在亮/暗主题下不抢眼。
5. `git diff` 只含上述 3 个文件；本轮文档任务的提交只含本笔记。

---

## 4. 不确定 / 待实测

| 项 | 为什么不能现在定 |
|---|---|
| `+N` 底色的最终 token | ds-bot 是 17% 灰；DSH 没找到同名值，`interactive-bg-active` 约 10%，需在真实主题下目测或取色。 |
| 缺口用 mask 还是环 | mask 与背景无关、hover 正确，但代码多约 10 行；环更短但会在 hover/active 露底色。建议 mask，已按此写施工单。 |
| 零成员 / 单人 | 正常群至少 2 个 Bot（`roster.js:367-369`），这两个是退化分支；是否需要产品级兜底待定。 |
| 吉祥物回退 | `AssistantSnapshot` 目前只带 `avatar`（`schemas.ts:28-43`），要画吉祥物得扩 schema；本轮不做。 |
| “清晰可读”字号 | 8px 是参考实现的计算值（`round(18×0.36)`），在 macOS 上能否看清要截图确认；若太小，8px 已是下限（`Math.max(8, …)`），不要自行加粗。 |
| 队长优先 | 参考实现没有这个规则；去掉会改变现有侧栏观感，需产品确认（D2）。 |
| 截图里的“圆角方形磁贴” | 源码与仓库自带截图（`docs/images/group.png`）都显示**头像本身没有底板**，圆角方块是**整行的选中/hover 背景**（`.bt-row[aria-current=page]`）。若用户看到的是每格独立方形底板，说明截图来自另一个版本/产品，需拿到版本号再核对；当前源码无此实现。 |
| 3 人构图方向 | 源码明确是 **1 上（顶部居中）+ 2 下（左下、右下）**（`mark.js:129-133`）；如果用户截图是 2 上 1 下，同样属于版本差异，需以实际版本源码复核。 |
