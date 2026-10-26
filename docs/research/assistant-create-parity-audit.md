# Assistant Create Parity Audit — MausBot NewBotDialog → 我们的 AssistantCreateDialog

> Task 1 of `docs/superpowers/plans/2026-10-26-assistant-create-parity.md`。只读审计，未改任何源码。
> 参考实现：OpenMausBot `src/components/NewBotDialog.tsx`（431 行）+ `src/components/bot-settings/*`（本机 `/root/openmausbot`，不在本仓库）。
> 对象：`src/client/assistant-dialogs.tsx`、`src/domain/schemas.ts`、`src/service/dsh-team-mode-service.ts`、`src/transport/contracts.ts`、`src/client/AssistantCreateDialog` 相关 CSS。
> 兄弟格式：`docs/research/quality-gates-audit.md`、`docs/research/team-epoch-audit.md`。

---

## 1. MausBot 的创建体验（读了什么）

| 层 | 事实 |
|---|---|
| 壳 | `LocalNewBotDialog`（`NewBotDialog.tsx:84`）：`max-w-[900px]`、`h-[min(760px,94dvh)]`；header（标题+关闭）、可选 `SharedInTeam` / 可见性 banner、左导航 `sm:w-40`（mobile 横向滚动）、右侧独立滚动内容、固定 footer（取消左、主按钮右）。 |
| 分区 | `SECTIONS = Identity/Soul/Skills/Memory/Routines/Access/Model/Permissions/Voice & alerts`（`:44`）；非高级模式隐藏 Model。 |
| 起始角色 | `StartingRole`（`:329`）：`/api/bot-presets` + 内置 `BOT_ROLES`；选中后 `roleProfilePatch(role)` 写 `name/title/description/soul`，preset 还会写模型/头像（`presetDraftPatch`）。 |
| 身份 | `IdentitySection`：头像卡、name、title、blurb（=instructions 预览入口）、`section`（部门）Select、`reportsTo`。 |
| Soul | `SoulSection`：独立 soul 文本 + reply style（不属本插件，见 `2026-10-26-mausbot-alignment-plan.md` §四「不搬 soul」）。 |
| Access | `AccessSection`（884 行）：工作目录、浏览器、电脑、连接器/App 授权、云后端、工具选择。 |
| Permissions | 总协调（chiefOfStaff）、peers、审批模式、命令白名单、外发策略。 |
| Skills/Memory/Routines/Voice | 各自独立数据（模板 skills、MEMORY.md 草稿、routine 草稿、voice/notification）。 |
| 创建 | 一次确认 → `createConfiguredBot` → `botAdded` → `openBot`（`:171-196`）。 |

## 2. 我们现在的创建对话框（问题清单）

`AssistantCreateDialog`（`src/client/assistant-dialogs.tsx:38`）当前是「440px 单列表单 + 头像/DiceBear + 模型菜单」：

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **Persona 完全无法填写**：`instructions` 有 state、也进了 payload，但 JSX 里没有任何输入控件。 | `:58` 声明，`:298` 组装，全文无 textarea |
| G2 | Workspace / 权限预设 / Agent Preset 是**隐藏的必填项**：只从 catalog 取默认值，没有可改 UI。 | `:99-100`、`:168-174` |
| G3 | 无分区壳：单列、`width: min(440px)`，无左导航/独立滚动。 | `AgentTeam.module.css:4083` |
| G4 | 权限默认取 `permissionPresets[0]`，与服务的 `workspace-write` 优先默认不一致。 | `assistant-dialogs.tsx:99` vs `dsh-team-mode-service.ts:556-558` |
| G5 | 无起始角色、无分组。 | 无 `assistant.list` / `groups` 调用 |
| G6 | Identity 是居中 hero（头像上、名字下），不是头像+名字同行。 | `:4107` |
| G7 | catalog 读取失败只能重开关闭对话框，无「重试」。 | `:118-120` |
| G8 | 身份无 title/description 字段（实例快照里也没有），MausBot 的 title/blurb 不可搬。 | `assistantSnapshotSchema`（`schemas.ts:28-43`） |
| G9 | 创建→ensure→open 的重试语义是对的（`createdId` 锁 + 「重试打开」），必须保留。 | `:64-66`、`:259-276` |

## 3. 逐分区映射表（MausBot → 我们的真实字段）

| MausBot 分区 | 我们的等价物 | 判定 | 说明 |
|---|---|---|---|
| Identity · StartingRole | 助手模板列表（`assistant.list`）→ 填 `name/instructions/avatar/provider/model/reasoningEffort/agentPresetId/permissionPresetId` | ✅ 进 Identity | 只读引用模板，不写模板行；见 §7 |
| Identity · avatar/name | `avatar`（data URL，≤400,000 字符）、`name` | ✅ | 复用现有上传 + `AvatarGrid` |
| Identity · section（部门） | `group`（sidebar group） | ✅ 进 Identity | 语义最接近；见 §8 |
| Identity · title / blurb | 无字段 | ❌ | 实例快照只有 `name/avatar/instructions`；blurb 的等价物是 Persona 的 instructions |
| Identity · reportsTo / 团队 banner | 无字段（团队是「招募模板」，助手不挂在团队下） | ❌ | 只在 note 说明 |
| Soul | `instructions`（Persona） | ⚠️ 降级 | 无独立 soul 文件、无 reply style；对齐 spec 明确不搬 |
| Model | `provider`/`model`/`reasoningEffort` + `agentPresetId`（工具/策略包）+ `workspaceId`（会话落点） | ✅ | 合并为「模型与环境」；fallback chain / cacheKeepWarm 是 MausBot bot 级字段，我们没有 |
| Permissions | `permissionPresetId` | ✅ | 审批模式、命令白名单、外发策略、peers 无对应字段 |
| — | `coordinator`（工作区总协调） | ⚠️ 只读说明 | 真实字段，但工作区唯一、只由 `assistant.coordinator.set` 写、入口在行菜单（`assistant-sidebar.tsx:442`），不进创建 |
| Skills | `skillAllowlist`/`mcpServers`（快照字段） | ❌ | 直接创建恒为 `[]`（`dsh-team-mode-service.ts:3951`）；`updateAssistantInstanceInputSchema` 不开放（`schemas.ts:804-818`）；模板可配，但实例不继承 UI 创建 |
| Memory | 持久记忆（`assistant.memory.*`）+ 设置面板 | ❌ 创建时 | 没有创建期草稿；创建后可用（`assistant-settings-dialog.tsx:902+`） |
| Routines | 无按助手的定时/例程 | ❌ | 团队任务/提醒是另一套流程 |
| Access | `workspaceId` | ⚠️ 部分 | 仅工作区；浏览器/电脑/连接器/工具/云后端无字段 |
| Voice & alerts | 无字段 | ❌ | 通知/语音都不可按助手配置 |

## 4. 字段能力矩阵（决定「能放什么控件」）

| 字段 | create（直建） | create（模板） | update | 运行期生效 |
|---|---|---|---|---|
| `name` / `avatar` / `instructions` | ✅ | ✅ override | ✅ | 下一次新建/恢复会话 |
| `provider`+`model`+`reasoningEffort` | ✅（成对校验，effort 校验 capabilities） | ✅ override | ✅（provider/model 必须成对） | 同上 |
| `agentPresetId` | ✅ | ✅ | ❌（update schema 无此字段） | 创建时定死 |
| `permissionPresetId` | ✅ | ✅ | ✅ | 之后创建/恢复的会话 |
| `workspaceId` | ✅ 必填 | ✅ 必填 | ❌（不可改） | 创建时定死 |
| `group` | ❌ **strict 拒收**（`assistantInstanceOverrides` 无 group，`schemas.ts:762-796`） | ❌ 同上 | ✅（必须已存在，`dsh-team-mode-service.ts:953-956`） | 侧栏分区 |
| `mascot` | ❌ | ❌ | ✅ | 外观 |
| `pinned` | ✅ | ✅ | ✅ | 侧栏 |
| `skillAllowlist`/`mcpServers`/`prompts` | ❌（直建写死 `[]`） | 继承模板 | ❌ | 实例主会话不消费（仅团队运行期读成员快照） |

**结论：不需要新 transport。** 角色用 `assistant.list`，分组用已有 `assistant.instance.update`，模型/权限/工作区用 `catalog.get`；创建仍走 `assistant.instance.create` + `assistant.instance.ensure`。唯一考虑过的 schema 改动（create 增加 `group`）见 §8 的取舍。

## 5. 支持的分区（4 个，顺序固定）

| key | 按钮文案 | 内容（全部真实字段） |
|---|---|---|
| `identity` | 身份 | 起始角色 Select（§7）→ 头像(72px 预览+本地上传)+名称 同一行 → `AvatarGrid` 形象卡 → 分组 Select（§8，无分组时隐藏并给提示） |
| `persona` | 人设 | `instructions` textarea（`aria-label="人设"`、min-h 200px、`maxLength` 不设——schema 无上限；底部 hint「会写入助手的系统提示；留空则使用 Agent Preset 默认」） |
| `model` | 模型与环境 | Workspace Select（仅 `status==='ok'`）、Provider+Model Menu（现状）、思考模式 Menu（有 efforts 时）、Agent Preset Select（仅非 broken） |
| `permissions` | 权限 | `permissionPresetId` Select（`PERMISSION_LABELS` 兜底）+ hint「只影响之后创建或恢复的会话」+ 只读说明「总协调在侧栏行菜单里设置，创建时不设」 |

**为什么 Workspace 放「模型与环境」**：它是「会话在哪里跑」的运行参数；单开第五个 tab 只为一个下拉，且与 MausBot 的 Access（工作目录）语义一致。备选（独立「工作区」tab）已否决。

分区导航只渲染这 4 项；未支持项不能渲染成可点 tab（§9）。

## 6. 壳布局规格（用 DSH 原语与 `--dsw-*` token，不搬 Tailwind）

`Modal`（`@deepseek-ai/dsh-client-ui-primitives`，实现见其 `lib/index.js:5060`）已提供 overlay/标题/关闭/Escape/焦点圈，结构为
`dialog > content(class=contentClassName) > [header, description?, body(children)] + footer`。
因此**不新增 headless 壳**，只扩展 `contentClassName` 与既有 CSS：

```
AnimatedModal(open, title="创建助手", closeLabel="关闭",
  className=assistantCreateDialog,
  contentClassName=assistantCreateDialogContent,
  footer=<AssistantCreateFooter .../>)
└─ body
   └─ div.assistantCreateLayout            // flex column, min-height:0, flex:1
      ├─ {banner?} div.assistantCreateBanner
      └─ div.assistantCreateSplit          // flex row, min-height:0, flex:1, gap:20px
         ├─ nav.assistantCreateNav[aria-label="创建助手的区块"]
         │   ├─ button.assistantCreateNavItem[aria-current="page"] × 4
         │   └─ details.assistantCreateUnavailable（§9）
         └─ section.assistantCreatePane     // flex:1, min-width:0, overflow-y:auto
            └─ fieldset[disabled] > 当前分区字段
```

CSS（新增/替换 `AgentTeam.module.css:4083-4104` 一带，语义 token 只用 `--dsw-*`）：

```css
.assistantCreateDialog {
  width: min(900px, calc(100vw - 32px));
  height: min(760px, 94dvh);
  max-height: 100%;
}
.assistantCreateDialogContent { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.assistantCreateDialogContent [class*="body"] {
  display: flex; flex: 1 1 auto; min-height: 0;
  margin-top: 0; padding: 0 24px 12px; overflow: hidden;
}
.assistantCreateLayout { display: flex; flex: 1; flex-direction: column; min-height: 0; width: 100%; }
.assistantCreateSplit { display: flex; flex: 1; gap: 20px; min-height: 0; }
.assistantCreateNav {
  display: flex; flex: 0 0 160px; flex-direction: column; gap: 2px;
  min-width: 0; padding: 2px 0 8px; overflow-y: auto;
}
.assistantCreateNavItem {
  flex: none; padding: 7px 10px; border: 0; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 13px; text-align: left; cursor: pointer;
}
.assistantCreateNavItem[aria-current='page'] {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.assistantCreatePane {
  display: flex; flex: 1 1 auto; flex-direction: column; gap: 14px;
  min-width: 0; padding-right: 4px; overflow-y: auto; overscroll-behavior: contain;
}
.assistantCreateFooter { display: flex; width: 100%; justify-content: flex-end; gap: 8px; }
@media (max-width: 760px) {
  .assistantCreateSplit { flex-direction: column; gap: 10px; }
  .assistantCreateNav {
    flex: none; flex-direction: row; overflow-x: auto; overflow-y: hidden;
    padding: 0 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  }
  .assistantCreateNavItem { flex: none; white-space: nowrap; }
}
```

- 760px 断点沿用本文件既有约定（`:2799`、`:8670`）。
- footer 由 Modal 渲染在 content 外，天然固定在卡片底部；取消与创建都右对齐（现状 `:4305` 已是 `justify-content:flex-end`）。
- banner：**可选**，规则唯一：catalog 加载完成且 `workspaces.length > 1` 时渲染一行纯文本 `将在「{title}」中创建 · 可在「模型与环境」切换`；不写任何状态、不上报事件；只有 1 个 workspace 时不渲染。
- Identity 头像+名字同行：`.assistantCreateHero` 由 column 改 row（72px 头像 + 1fr 名称输入 + 底部提示），`AvatarGrid` 卡片保留在 Identity 内。

### 可访问性 / 状态

| 关注点 | 规格 |
|---|---|
| 导航 | `nav[aria-label="创建助手的区块"]`；分区按钮 `type=button`，当前项 `aria-current="page"`（恰好 1 个）；分区内容用 `<section aria-label="身份">` 等 |
| 键盘 | Modal 已有 Escape/焦点圈；名称输入 `data-modal-autofocus`；导航按钮原生可 Tab |
| 加载 | `div[role="status"]` 文案「正在读取配置…」；导航可见但 `aria-disabled="true"` 且 `tabIndex=-1`；footer 主按钮 disabled |
| catalog 错误 | `div[role="alert"]` + 「重试」按钮（重跑同一 catalog 加载） |
| 字段禁用 | 当前分区整体 `fieldset disabled`（busy 或 loading 时）；footer 取消 `disabled={saving}` |
| 创建中 | 主按钮「创建中…」且 disabled；所有分区字段禁用 |
| 已创建/ensure 失败 | `createdId` 锁：字段禁用、主按钮「重试打开」、alert 保留原错误 |
| 角色列表失败 | 角色 Select 隐藏（`roleError` 提示一行），其余照常创建——角色是便利项，不是前置条件 |
| 动效 | 交给 `AnimatedModal`（已尊重 `prefers-reduced-motion`，`shared.tsx:22`） |

## 7. 起始角色规格（真实 instructions，不造假模板）

**来源**：`assistant.list`（`PageView<AssistantTemplate>`，`service:517` 排序 = sortOrder/createdAt/id）。内置 Chief 由 `ensureBuiltinAssistants`（`:531`）种下，`source==='builtin'`；用户模板 `source==='user'|'generated'`。
**过滤**：只要 `enabled === true`（禁用模板不进 picker，`assistantTemplateSchema:61-62`）。
**分组展示**：`optgroup`「内置角色」= builtin，`optgroup`「我的模板」= 其余；首项 `value=""`「自定义配置」。

**选中即一次性填充**（之后再改字段不会被覆盖，除非再次选角色）：新增纯函数
`applyStartingRole(draft, template, catalog) → draft`

| 字段 | 规则 |
|---|---|
| `name` | `template.name`（MausBot 同语义：选角色 = 用这个角色） |
| `instructions` | `template.instructions`（为空也照写，允许空人设） |
| `avatar` | `template.avatar ?? ''`（随后仍可本地上传/换形象） |
| `provider`+`model` | 仅当 catalog 里**精确存在该 pair** 才写；否则保留当前选择（模板可能过期，避免必然失败的创建） |
| `reasoningEffort` | 写 `template.reasoningEffort`（若无则清空）；模型能力 effect 会把不支持的值 prune 掉（沿用 `assistant-dialogs.tsx:138-149`） |
| `agentPresetId` | 仅当 catalog 存在且非 broken 才写 |
| `permissionPresetId` | 仅当 catalog 存在才写 |
| `group` / `pinned` | 不动 |

**角色摘要行**（选中后显示，全部真实数据）：`template.description`、`模板模型 · 权限名`；不显示 skills/MCP，避免暗示可配。

**payload 仍是直建**（不发 `templateId`）：`name/provider/model/agentPresetId/permissionPresetId/workspaceId/instructions(+avatar、reasoningEffort)`，形状不变（`schemas.ts:787-795`）。
已知限制（写入实现 PR 说明）：模板的 `prompts`/`skillAllowlist`/`mcpServers` **不会**带入实例；实例快照这些字段仍是 `[]`，与今天的直建行为一致。

**为什么不硬编码角色常量**：MausBot 的 `BOT_ROLES` 来自 ready-bots 的固定文案；我们没有这层产品数据，硬写「工程师/写手」人设等于发明内容。模板是用户已确认的真实快照，零新数据、零新 transport，且天然可扩展（用户自己建模板即新增角色）。

## 8. 分组持久化（复用已有 update 传输）

**数据**：`AssistantInstance.group?: sidebarGroupName`；已存在（`schemas.ts:126-132`）；写语义 = 空串清除、新名必须已在 `sidebar_groups`（`assertKnownGroup`，`service:3253`），实现与测试都有（`tests/sidebar-groups.spec.ts:264-280`）。

**create 不支持 group**（strict 拒收，§4）。两种选择：

| 方案 | 改动 | 评价 |
|---|---|---|
| **A（推荐）复用一个 update** | 仅客户端：create 成功后、ensure 之前，若选了分组则 `assistant.instance.update { id, value: { group } }` | 零 schema/服务改动，复用已测路径；plan 明确「reuse existing create/update transports」；代价：两次写、UI 需定义失败语义 |
| B create 接受 group | `assistantInstanceOverrides`+两个 union 分支+`createAssistantInstance` 落库与 `assertKnownGroup`（约 8 行） | 原子、一次 publish；但扩了对外 schema，超出本次「不加后端能力」的边界 |
| C 创建后由用户去行菜单移动 | 无 | 不满足「分组在选择时就持久化」的体验要求 |

**A 的精确行为**：
1. `create → (group !== '' ? update(group) : skip) → onCreated()（侧栏 load，分组立即出现在对应分区）→ ensure → open`。
2. `group` 写入失败：**不阻断**创建结果。设 `groupWarning`（非 alert 的 inline warning）「助手已创建，但分组未写入：…」，继续 ensure→open；用户可稍后在行菜单「移动到分组」（`assistant-sidebar.tsx:876`）。
3. 重试打开（`createdId` 已存在）**不再**写分组，避免二次写；用 `groupApplied` 布尔防重复。
4. 分组下拉只列 `sidebar.groups.list`（侧栏已通过 `useSidebarGroups()` 拿到，`assistant-sidebar.tsx:259`，作为 `groups` prop 传入；不新增请求）。无分组时不渲染 Select，显示提示「还没有分组；先在侧栏新建分组」。
5. 首项「不分组」= `''`（不写 update）。

**测试映射**：分组读取 → `sidebarPartitions`（已有纯函数，`tests/client-sidebar-group-partition.spec.ts`）；写入 → 服务已覆盖；新客户端测试只需断言「create payload 不含 group」+「选中分组时调用 update 且只在首次创建后调用」。

## 9. 未支持分区（明确说明，不做假 tab）

导航底部一个原生 `<details class=assistantCreateUnavailable>`，`<summary>还有 5 项创建时不提供</summary>`，逐条一句话（`aria-label="未提供的区块"`）：

| 项 | 文案 |
|---|---|
| 记忆 | 记忆：创建后在助手设置/记忆面板维护（持久记忆条目），创建时没有草稿。 |
| 技能 | 技能/MCP：实例快照不开放这两个字段；只有「助手模板库」能配置，实例创建不继承。 |
| 例程 | 例程：本插件没有按助手的定时任务；团队任务与提醒走团队流程。 |
| 访问 | 访问：只保留 Workspace（在「模型与环境」）；浏览器、电脑、连接器、工具授权没有对应字段。 |
| 语音 | 语音与通知：不可按助手配置，通知沿用 DSH 全局行为。 |

并在 Permissions 分区底部加一行只读说明：「总协调（Coordinator）在侧栏行菜单设置，创建时不设。」

## 10. 创建流程与失败矩阵（create → group → ensure → open 不变）

| 步骤 | 失败表现 | 用户可做什么 |
|---|---|---|
| 读 catalog | alert + 「重试」；footer 禁用 | 重试/取消 |
| 读模板（角色） | 角色 Select 隐藏 + 一行提示；其余可继续 | 直接自定义创建 |
| `instance.create` | alert 原文；`createdId` 不设置；字段解锁 | 改字段再创建（不会重复建） |
| `instance.update(group)` | 非阻断 warning（§8） | 行菜单移动分组 |
| `onCreated()`（侧栏刷新） | 现有 load 错误处理 | — |
| `instance.ensure` | `createdId` 锁定、alert、主按钮「重试打开」 | 只重试 ensure，绝不重复 create |
| 打开会话 | `openSession(sessionId)` | — |

`canCreate` = name 非空 && provider/model/workspace/permissionPreset/agentPreset 均已选（保持现状 `:168`）。**一次确认**：主按钮只提交一次 create；第二次提交必然是「重试打开」。

## 11. 测试定义（无 DOM 依赖，沿用仓库风格）

仓库 vitest 是 node 环境（无 jsdom/testing-library），所以交互逻辑抽纯函数、结构用 `react-dom/server`，布局用既有的「源码契约」测试（先例：`tests/client-assistant-sidebar.spec.ts:129-145`）+ 手工浏览器检查。

### T1 `tests/client-assistant-create-form.spec.ts`（新，纯函数）

| 用例 | 断言 |
|---|---|
| 分区集合 | `assistantCreateSections()` 恰为 `['identity','persona','model','permissions']`；**不含** `memory/skills/routines/access/voice`（防假 tab 回归） |
| 初始默认值 | 有 catalog 时：workspace=首个 ok、permission=`workspace-write`（存在时）否则首个预设、agentPreset=`standard` 否则首个非 broken、provider/model=首个有模型者；`agentPresets` 全 broken 时 agentPreset 为空 |
| 角色填充 | 命中 catalog 的模板 → name/instructions/avatar/provider/model/effort/preset 全填；过期模型的模板 → provider/model 保持原值；未知 agentPreset/permissionPreset 不写；`group` 不变 |
| create payload | 直建形状；空 avatar/instructions/effort 省略；`instructions=''` 时仍发 `instructions: ''`（现状 `:298`）；**不含 `group`、不含 `templateId`**（用 `createAssistantInstanceInputSchema.safeParse` 断言通过，且 `{...payload, group}` 失败） |
| 分组选项 | `groups=[]` → `{visible:false}`；有分组 → 首项 `{value:'',label:'不分组'}` + 原顺序；不 trim/去重（服务端已保证） |
| 提交意图 | `{createdId:undefined,saving:false}` → `create`；`createdId` 存在 → `ensure`；`saving` → `ignore`（一次确认，不重复创建） |
| 未支持清单 | 5 项 key 固定，每项 reason 非空 |

### T2 `tests/client-assistant-create-dialog.spec.ts`（新，`renderToStaticMarkup` 抽出的展示组件）

抽 `AssistantCreateBody`（导航+分区+fieldset）与 `AssistantCreateFooter`（按钮），入参是纯 view-model（catalog/draft/view state），SSR 直接渲染断言：

| 用例 | 断言 |
|---|---|
| 壳结构 | 含 `assistantCreateSplit`/`assistantCreateNav`/`assistantCreatePane`；`nav[aria-label="创建助手的区块"]`；4 个导航按钮且**只有一个** `aria-current="page"`；无「访问/语音/例程/技能/记忆」按钮 |
| 未支持说明 | `<summary>` 文案 + 5 条原因文本存在 |
| loading | `role="status"` + 「正在读取配置…」；footer 主按钮 `disabled` |
| catalog error | `role="alert"` + 「重试」按钮存在 |
| busy/saving | 字段 `fieldset disabled`；主按钮文案「创建中…」且 disabled；取消 disabled |
| ensure 锁定 | 主按钮文案「重试打开」、`aria-busy`；字段 disabled |
| 分组 | 无分组时无 `select`、有提示；有分组时含「不分组」选项 |
| 角色失败 | 无 `role=combobox`（角色隐藏）但表单其余字段仍在 |

### T3 `tests/client-assistant-create-layout.spec.ts`（新，源码契约，替代无法断言的 CSS）

读 `AgentTeam.module.css` 与 `assistant-dialogs.tsx`，断言：`width: min(900px`、`height: min(760px, 94dvh)`、`@media (max-width: 760px)` 块内 `flex-direction: row` 的导航、`overscroll-behavior: contain`、footer `justify-content: flex-end`、dialog 源码含 4 个分区 key 且不含 unsupported key、`aria-current`/`role="status"`/`role="alert"` 字面量存在。

### T4 既有测试保持

`tests/client-assistant-form.spec.ts`、`tests/client-assistant-sidebar.spec.ts`、`tests/sidebar-groups.spec.ts`（实例 group 写）、`tests/assistant-instances.spec.ts`（create 直建/模板/校验）、`tests/transport-contracts.spec.ts` 不改动即通过；`npm run check`。

### T5 手工检查（Task 3，无法自动化）

浏览器 1440×900 / 900×700 / 420×800：卡片宽 ≤900、高 ≤94dvh、footer 常驻可见；760px 以下导航横滚、内容独立滚动不带动导航；Tab 顺序 header→nav→字段→footer；Escape 关闭且焦点回到「新建助手」；创建后侧栏出现于所选分组。

## 12. 风险 / 限制 / 取舍（给实现与评审）

1. **两次写（create+group）**：极端失败会留下「已创建但未分组」的助手，用 warning 明确告知并可后补；若评审要求原子性 -> 采用 §8 方案 B（需改 domain+schema+service，不在本任务范围）。
2. **模板过期**：模板里存的是创建时的 provider/model/preset；角色填充必须按 §7 的 catalog 校验规则降级，否则必然触发 `MODEL_*`/`PRESET_REFERENCE_INVALID`。
3. **Persona 无长度上限**：schema 是 `z.string()`；不发明上限，UI 不显示假计数。
4. **instructions 的生效时机**：只影响之后创建/恢复的会话；新建实例的 ensure 在创建之后，因此 Persona 立即生效——这一点与 `permissionPresetId` 的语义一致，hint 里说明。
5. **分区切换不丢草稿**：所有字段 state 留在父组件（现有写法），切分区只切渲染，不卸载状态（不要用 key 强制重建）。
6. **不做**：MausBot 的 visibility/共享 banner、reportsTo、soul 文件、reply style、审批模式、命令白名单、外发策略、voice、routine、memory 草稿、skills/MCP 编辑、模板写操作、coordinator 创建期设置。
7. **不新增**：transport、schema 字段、持久化字段、i18n 体系（沿用中文硬编码文案）。

## 13. 验收映射（对 plan）

| plan 要求 | 本审计落点 |
|---|---|
| Identity/Persona/Model/Permissions 四区 | §5（含字段清单） |
| 起始角色填真实 instructions/模型默认 | §7（含降级规则，不硬编码人设） |
| 分组持久化并出现在侧栏 | §8（复用 update；失败语义；侧栏 partitions 已有测试） |
| 不造假 tab，未支持项说明 | §9（details 清单，导航只有 4 项） |
| create→ensure→open 不变、一次确认 | §10（失败矩阵 + 提交意图测试） |
| 分区壳 ~900 / 94dvh、nav+mobile、footer | §6（DOM/CSS/响应式/a11y） |
| 测试与 `npm run check` | §11（T1-T5） |
