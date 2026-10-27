# 能力闸门核对：权限预设覆盖范围 + 技能/MCP 字段形状

> 2026-10-27 · 只读调查（未改业务代码）· 输入任务：`capability-roadmap` t1
> 对象：宿主 `@deepseek-ai/dsh-permission-presets` + `dsh-sandbox*` + `dsh-user-approval`（本机 `node_modules` 与 `/Applications/DSH NEXT.app/Contents/Resources/app.asar` 内的等价物）、本插件 `src/`
> 目的：给 P6（权限细项）一个「做 / 不做」的结论，给 P1（能力装配）一份不返工的施工图

宿主源码引用约定：`asar:<path>:<line>` 表示 `app.asar` 内的文件行号（本机 2.0.19-next）。
MausBot 源码在本机 `/Users/limeng/DSH/_ext/OpenMausBot`，不在本仓库。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 一个权限预设是什么 | **只有两个旋钮**：`sandbox`（read-only / workspace-write / danger-full-access）+ `approval`（ask / never） |
| 本机实际有哪几档 | `read-only`(只读)、`workspace-write`(工作区可写)、`danger-full-access`(完全访问)；`custom` 是派生值，不是可选项；`auto` 本部署未挂载 |
| 预设约束了什么 | **只有文件写**。读、执行、网络全开（macOS `(allow default)`；Linux bwrap 无 `--unshare-net`） |
| 命令级白名单 | **没有**。审批是一次一授权（one-shot），不匹配命令、不记忆 |
| 外发/网络策略 | **没有**。宿主原话：网络与进程可见性「outside this vocabulary / out of scope」 |
| 插件侧 preset 是否已接通 | 已接通（会话创建处 5 处 `permissionPresets.set(...)`），P6 不需要再动 |
| P6 要做的事 | **零**。MausBot 的 4 个细项里，2 个 DSH 已覆盖（审批模式、总协调/peers 属团队概念），2 个（命令白名单、外发策略）我们不做 |
| P1 缺口在哪 | 不是「实例恒为 `[]`」那么简单：**模板建实例其实继承技能**，只有**无模板直建**（创建对话框走的那条）写死 `[]`，且 create/update 两个 schema 都不收这两个字段 |

---

## A. P6：权限预设到底覆盖了什么

### A1. 预设定义

一个预设 = `{ sandbox, approval, name?, description? }`，没有第三个维度：

- 配置形状：`asar:node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js:138-159`
  （`presets: z.dict(z.object({ sandbox: z.union(SANDBOX_MODES).required(), approval: z.union(APPROVAL_POLICIES).required(), name, description }))`）
- 「当前预设」是**由两个旋钮反查**出来的，不是独立状态：`lib/index.js:295-306`（`derive()`：先认记录过的 preset，再按 sandbox+approval 匹配配置表，都不匹配 → `custom`）
- 切换预设 = 写 `permission/preset` 事件 + 分别调 `setSandboxMode` / `setApprovalPolicy`：`lib/index.js:350-361`
- `read-only` / `auto` / `custom` 不能被配置成表项（保留名）：`lib/index.js:175-176`、`50-52`

本机部署（`dsh-base` bundle）实际配置：

```
asar:node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:264-276
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:          { sandbox: read-only,          approval: ask }
      workspace-write:    { sandbox: workspace-write,    approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

配套的部署默认：`sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`（`asar:.../dsh-base/cordis.patch.yml:243-247`）、`approval.policy = DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'`（同文件 `:259-262`）。

`auto`（实验性 auto-review 预设）通过 `registerAuto()` 才会出现在 `names` 里（`lib/index.js:238-240`、`258-268`），本部署的 `cordis.patch.yml` / `dsh-web-app/cordis.patch.yml` 都**没有**插入 `dsh-experimental-auto-review`，所以本机 catalog 只有上面三档。

我们的插件只是把宿主 catalog 原样映射（含中文标签）：`src/service/dsh-team-mode-service.ts:397-403` + `:258-264`（`read-only→只读`、`workspace-write→工作区可写`、`danger-full-access→完全访问`、`standard→标准`）。

### A2. 每一档到底约束了什么（逐条）

| 档位 | `sandbox` | `approval` | 实际效果 |
|---|---|---|---|
| 只读 `read-only` | read-only | ask | **只能写 `/dev/null`**。`writableRoots()` 在 read-only 下返回空（`node_modules/@deepseek-ai/dsh-sandbox/lib/types/roots.d.ts:26-34`：`"read-only allows nothing"`）；macOS SBPL 只剩 `(allow file-write* (literal "/dev/null"))`（`asar:.../dsh-sandbox-local/lib/index.js:65-74`）。越界写 → kernel 拒绝 + 提示模型申请升级（需用户批准） |
| 工作区写 `workspace-write` | workspace-write | ask | 可写 **workspace 根 + `/tmp` + `os.tmpdir()`**，其它仍是 `/dev/null`：`dsh-sandbox-local/lib/index.js:46-51`（bwrap `--tmpfs /tmp` + `--bind workspaceRoot`）、`:65-74`（Seatbelt 的 `writableRoots` 追加 subpath 允许） |
| 完全访问 `danger-full-access` | danger-full-access | never | **不套沙箱**（`dsh-sandbox/lib/types/index.d.ts:15-21`：`danger-full-access bypasses confinement`），且审批策略 `never` 让所有审批问询直接判 `rejected`（`node_modules/@deepseek-ai/dsh-user-approval/lib/types/index.d.ts:41-55`）——即完全不打扰用户 |

三种模式共同的边界（关键，别误读成「有安全隔离」）：

1. **只限制写，不限制读**。Seatbelt profile 第一行是 `(allow default)`（`asar:.../dsh-sandbox-local/lib/index.js:68`），没有任何 `deny file-read*`；`read-only` 档可以读整台机器（包括别的 workspace、`~/.ssh`）。Windows 后端文件里也明写「Read-side confinement and network policy are out of scope」（`asar:node_modules/@deepseek-ai/dsh-sandbox-windows-acl/README.md:188`）。
2. **不限制网络**。Linux bwrap profile 是 `--ro-bind / /`，没有 `--unshare-net`（`dsh-sandbox-local/lib/index.js:22-40`）；类型定义同样声明「Network and process visibility are outside this vocabulary」（`dsh-sandbox/lib/types/index.d.ts:15-21`）。
3. **不限制命令**。`approval` 只有 `ask` / `never` 两态，没有第三态「按命令匹配」。需要更宽权限时是**逐次请求**：`sandbox_permissions` + `justification` 成对出现、经审批通道、fail-closed（`dsh-sandbox/lib/types/escalation.d.ts:1-30`）；授权只对本次动作有效（`dsh-user-approval/lib/types/index.d.ts:1-4`：`grants apply only to the requested action`）。

### A3. 有没有「命令级白名单」/「外发·网络策略」

**逐条核对（没有就是没有，不猜）：**

| MausBot 细项 | DSH 里最接近的东西 | 是否等价 | 证据 |
|---|---|---|---|
| 审批模式 `ask/edits/auto/full/custom` | `approval` = `ask/never` + `sandbox` 三档 | **是（降维等价）**：问与不问 = ask/never；「自动接受编辑」= `workspace-write`（沙箱内写本来就不需要审批）；“full” = `danger-full-access`+`never`；`custom`(codex 专属规则集) 与 `auto`(LLM 审查器) 本部署无 | `asar:.../dsh-permission-presets/lib/index.js:138-159`；`dsh-user-approval/lib/types/index.d.ts:41-55`；MausBot `shared/approval-mode.ts:1-20` |
| 命令白名单（精确 command + cwd + provider 实例，见 MausBot `shared/command-allowlist.ts:1-16`） | 无。只有一次性升级授权 | **否，真缺** | `dsh-sandbox/lib/types/escalation.d.ts:1-30`（一次性）+ `dsh-user-approval/lib/types/index.d.ts:1-4` |
| 外发策略（`ask`/`allow` + 每日额度；MausBot 用它约束「发消息/花钱」这类 outbound 工具，`shared/outbound.ts:1-10`） | 无任何同类概念；DSH 的网络不是被策略约束的，而是根本没设约束 | **否，真缺**（但对我们是**假需求**，见 A4） | `dsh-sandbox/lib/types/index.d.ts:15-21`、`dsh-sandbox-windows-acl/README.md:188` |
| 总协调 `chiefOfStaff` / `peers` | 我们有 `coordinator`（工作区唯一，`assistant.coordinator.set`）+ Team 成员/角色 | **是（换了个更强的载体）** | `src/service/dsh-team-mode-service.ts:751-791`、`docs/superpowers/specs/2026-10-27-capability-roadmap.md:19` |

插件这边**已经**把预设接到每个会话，不需要补任何一层：

- 助手主会话/子线程：`src/runtime/assistant-runtime.ts:1080`、`:1308`
- 团队成员会话：`src/runtime/team-runtime.ts:625`、`:1913`
- Assistant Builder 会话：`src/runtime/assistant-builder-runtime.ts:410`
- 运行期用户还能用宿主 `/permission <preset>` 命令切档（`asar:.../dsh-permission-presets/lib/index.js:206-231`），我们不需要自己做这个入口

### A4. 结论：需要我们做 / 不做

| 项 | 判定 | 理由（一句） |
|---|---|---|
| 审批模式（细粒度） | **不做** | 宿主预设已经是「sandbox 档位 + 是否打扰」的完整表达，再暴露一个 `approvalMode` 字段就是同一件事开两个写入口。 |
| 命令白名单 | **不做** | 它不是「少写个字段」，而是要我们接管命令执行与匹配——执行器在宿主（`dsh-tool-bash` / sandbox runner），我们无法在自己的层里真正拦住命令；假白名单比没有更糟。 |
| 外发/网络策略 | **不做** | 我们没有「发消息/花钱」这类 outgoing 工具（没有 Composio/连接器），也没有网络策略可挂的落点；宿主明确把网络排除在权限词汇之外。 |
| 总协调 / peers | **不做** | 已由 `coordinator` + Team 角色覆盖，且入口在侧栏行菜单/团队面板，不在助手权限里。 |
| 权限预设本身的展示/校验 | **已完成** | `catalog.permissionPresets` 映射 + 三处写入校验（`:904`、`:3392`、`:3696`）都在。 |

**P6 的净结论：本次核对后，P6 从「待办」降级为「已由宿主覆盖，我方零工作量」**，只需把这条结论写进 roadmap 收口（不要在插件里造第二套权限系统）。
唯一值得记一笔的认知修正：这些预设**不提供读隔离、不提供网络安全**——如果有人拿「只读」当安全边界，那是误解。

---

## B. P1 前置：技能与 MCP 的真实形状

### B1. 类型与校验

**类型**：两处都是 `z.array(nonEmpty)`（非空字符串数组，无长度上限、无去重约束）：

- 快照：`src/domain/schemas.ts:39-40`（`skillAllowlist` / `mcpServers`）
- 模板：`src/domain/schemas.ts:59-60`
- 模板创建入参把它们 pick 出来：`src/domain/schemas.ts:735-753`（`:746`、`:747`）
- 领域类型：`src/domain/types.ts:66`（`CreateAssistantInstanceInput` 由 schema 推导）、`src/domain/types.ts:213-229`（`snapshotAssistant()` 逐字段拷贝）

**校验函数**（唯一一处引用校验）：`AgentTeamService.validateAssistantReferences()`，`src/service/dsh-team-mode-service.ts:3676-3713`：

| 行 | 检查 |
|---|---|
| `:3677-3680` | 技能名**只做语法校验** `isSkillName(name)`（来自 `@deepseek-ai/dsh-skill`，导入在 `:4`）；非法 → `SKILL_REFERENCE_INVALID` |
| `:3681-3684` | MCP 名语法 `isMcpServerName()` → `MCP_REFERENCE_INVALID` |
| `:3685` | 模型/推理档位配套校验 |
| `:3686-3695` | agent preset 必须能 `resolve` |
| `:3696-3701` | 权限预设必须在 `ctx.permissionPresets.names` 里 |
| `:3702-3713` | **MCP 必须存在于该 preset 的 catalog**（`mcpCatalog(agentPresetId)` 的 `servers[].name`）→ 否则 `MCP_REFERENCE_INVALID` |

注意不对称：**技能没有 catalog 存在性校验**（只查语法），MCP 有。技能的存在性只在会话激活时查（见 B3）。
去重/裁剪在 `normalizeAssistantInput()`：`src/service/dsh-team-mode-service.ts:4518-4533`（`unique()` 定义在 `:4545-4547`）。

模板路径的入口：`createAssistant()` → `validateAssistantDraft()`（`:630-657`，`:653-656` 调 references）。
实例路径的入口：`createAssistantInstance()` → `validateAssistantInstanceSnapshot()`（`:854`，函数体 `:3659-3674` 把快照塞回 `CreateAssistantInput` 再调同一个 `validateAssistantReferences`）——**这条路已经通了**，这是 P1 的关键好消息。

### B2. 为什么实例创建会写死 `[]`

**精确定位：只有「无模板直建」写死，模板建实例其实继承。**

| 路径 | 代码 | 结果 |
|---|---|---|
| 有 `templateId` | `src/service/dsh-team-mode-service.ts:845-848`：`requireAssistant` → `snapshotAssistant(assistant)` → `applyAssistantSnapshotOverrides(snapshot, input)` | **继承模板的 skillAllowlist / mcpServers**（`applyAssistantSnapshotOverrides` `:3963-3986` 只覆盖 provider/model/preset/instructions/reasoningEffort，其余原样带过） |
| 无 `templateId` | `:843-844` → `directAssistantSnapshot(id, input)`，里面**硬编码** `skillAllowlist: []` / `mcpServers: []` | 恒为空，且函数上方的注释把这个当成设计（`:3933-3936`「starts at revision 1 with no Skills, MCP Servers, or prompts」） |

硬编码行：**`src/service/dsh-team-mode-service.ts:3952-3953`**。

为什么用户体感是「模板配了但实例没有」：创建对话框**从不发 `templateId`**。它选「起始角色」只是把字段抄进 draft（`src/client/assistant-form.ts:149-188`，抄 name/instructions/avatar/provider/model/reasoningEffort/agentPresetId/permissionPresetId，**不抄技能/MCP**），提交走的是直建形状 `assistantCreatePayload()`（`src/client/assistant-form.ts:208-222`，只带 identity + 引擎 + mascot）。对话框注释也明说了这条取舍（`src/client/assistant-dialogs.tsx:530-536`：`omitting templateId is what makes the service build a template-less instance`）。

而且**入参 schema 直接拒绝这两个字段**：

- 建的形状 `assistantInstanceOverrides`：`src/domain/schemas.ts:764-782`（没有 skillAllowlist / mcpServers），被 `createAssistantInstanceInputSchema` 两个分支共用（`:790-804`）
- 改的形状 `updateAssistantInstanceInputSchema`：`src/domain/schemas.ts:812-826`（同样没有）
- 两条都是 `.strict()`，多传一个字段直接 parse 失败 → `ASSISTANT_INSTANCE_*` 错误

**现有测试把这个缺口钉住了**：`tests/assistant-instances.spec.ts:285-286`

```ts
await expect(service.createAssistantInstance({ ...base, skillAllowlist: [] } as never))
  .rejects.toBeInstanceOf(Error)
```

同一文件 `:96-103` 反过来证明模板路径是继承的（`template()` 带 `skillAllowlist: ['code-review']`，从模板建的实例快照里也是 `['code-review']`）。

客户端还把这个缺口写成了「不可用说明」文案：`src/client/assistant-form.ts:56-60`

```
key: 'skills', title: '技能',
detail: '实例快照不开放技能与 MCP 字段；只有「助手模板库」能配置，实例创建不继承。',
```

——这段文字在 P1 落地当天就会变成假话，必须一起删。

### B3. 成员的技能校验走哪条路（P1 要复用同一条）

成员的技能/MCP 最终是**在会话激活时**落到 agent 工具集上的，`src/runtime/team-runtime.ts`：

| 行 | 做什么 |
|---|---|
| `:1811` | `selectedMcpServers = new Set(member.assistantSnapshot.mcpServers)` |
| `:1812-1834` | 未选中的 MCP 工具 `tools.restrict({deny})` + `tools.guard()` 运行期拦截；选中的却不存在 → `MCP_REFERENCE_INVALID` |
| `:1836-1843` | `selectedSkills = new Set(member.assistantSnapshot.skillAllowlist)`；用 `ctx.skills.list({cwd: team.workspacePath, scope: agent})` 取**该工作区 + 该 preset 作用域**下真正可用的技能名集合（`isModelInvocable || isUserInvocable` 过滤） |
| `:1844-1859` | 选中的技能不在可用集合 → `SKILL_REFERENCE_INVALID`；选了技能但 preset 没暴露 `skill` 加载器 → 同样 `SKILL_REFERENCE_INVALID` |
| `:1860-1880` | 用 `registerScopedSkillProvider` 把**未选中**的技能标成不可调用（`modelInvocable:false, userInvocable:false`），实现"白名单"语义 |

所以「技能校验」其实分两层，P1 两层都要靠：

1. **写入期**（我们自己的层）：`validateAssistantReferences()` 的语法校验 + MCP catalog 校验 —— `src/service/dsh-team-mode-service.ts:3676-3713`。**实例创建已经会调它**（`:854`），字段一开口就自动获得校验，不需要新写。
2. **运行期**（宿主 + 我们的 runtime）：真实可用性/白名单 —— `team-runtime.ts:1836-1880`，助手侧同构逻辑在 `src/runtime/assistant-runtime.ts`（同样的 `skillAllowlist` 快照语义）。

UI 侧的 catalog 读取（模板编辑器已经在用，P1 直接复用）：`skill.catalog` / `mcp.catalog`（`src/transport/web.ts:222-229`）→ `skillCatalog()` / `mcpCatalog()`（`src/service/dsh-team-mode-service.ts:442-476`、`:478-511`），都按 `agentPresetId` 取作用域，且在 preset 没暴露 `skill` 工具时返回空列表（`:450-452`）。

### B4. 更新路径（`updateAssistantInstance`）现在怎么处理这两个字段

**完全不处理：既不接受、也不改动。**

- schema 不收：`src/domain/schemas.ts:812-826`（`.strict()`，传了就是 `INVALID_REQUEST`）
- service 重建快照时靠 `...snapshotRest` 把旧值原样带过，随后只显式赋值 `instructions/provider/model/permissionPresetId/reasoningEffort`：`src/service/dsh-team-mode-service.ts:936-950`
- 变更检测列表里也没有这两个字段：`:960-969`（即使未来 schema 放开而忘了加进 `changed`，会导致「改了但 no-op」的静默失败——**P1 必须同时改这两处**）
- 语义同步要考虑的参照：`applyAssistantSnapshotOverrides()`（建，`:3963-3986`）与这段 update 逻辑是两套代码；P1 改一个就得改另一个，否则「建得进、改不进」或反之

模板侧的更新路径是完整的、可照抄：`updateAssistant()` 把 patch 合进整份候选再整体校验（`:659-687`，`:668-672`），字段级差异由 `normalizeAssistantInput()` 去重。

---

## C. P1 最小实现建议

**判断：字段开口 + 复用既有校验，不新增 transport、不新增 service 校验函数、不碰 runtime。**

1. **schema 开两个字段（两处，别漏）**
   - `src/domain/schemas.ts:764-782` `assistantInstanceOverrides` 加 `skillAllowlist: z.array(nonEmpty).optional()` / `mcpServers: z.array(nonEmpty).optional()` → 建实例（模板覆盖与直建）都收。
   - `src/domain/schemas.ts:812-826` `updateAssistantInstanceInputSchema` 同样加。
   - 理由：这两个字段与 `prompts` 不同，**传空数组是有意义的值**（清空能力），所以 `optional` + `[]` 语义即可，不需要额外哨兵。

2. **service：把「保持原值」变成「可覆盖」（两个函数各一处）**
   - 直建：`directAssistantSnapshot()`（`:3938-3956`）把两行硬编码换成 `input.skillAllowlist ?? []` / `input.mcpServers ?? []`，并给 `DirectAssistantSnapshotInput`（`:3922-3931`）加同名字段。
   - 覆盖：`AssistantSnapshotOverrides`（`:3911-3920`）+ `applyAssistantSnapshotOverrides()`（`:3963-3986`）各加同样两项（`undefined` 保持、数组就替换）。
   - update：`updateAssistantInstance()` 里按 `patch.x ?? current.assistantSnapshot.x` 赋值（`:941-950` 那段），**并把两项加进 `changed` 比较**（`:960-969`）。
   - 校验：**不写新函数**。`createAssistantInstance()` 已经在 `:854` 调 `validateAssistantInstanceSnapshot()`；`updateAssistantInstance()` 目前**没有**调它（只单独查权限预设 `:901-910`）——P1 需要在 snapshot 建好后补一句 `await this.validateAssistantInstanceSnapshot(snapshot)`，这样技能语法/MCP catalog/模型配套全复用同一条路，一行代价。

3. **客户端（创建对话框）**
   - `AssistantCreateDraft` 加 `skillAllowlist: string[]` / `mcpServers: string[]`（`src/client/assistant-form.ts:79-116` 两处）；
   - `applyStartingRole()`（`:156-188`）抄模板的这两项（**这是「模板带过来的默认勾选」的实现点**）；注意抄之前要用 catalog 过滤，和现有 `pairInCatalog`/`agentPreset`/`permission` 的写法一致；
   - `assistantCreatePayload()`（`:208-222`）带上两项；
   - 删掉 `ASSISTANT_CREATE_UNSUPPORTED` 里的 skills 条目（`:56-60`）；
   - 面板控件复用模板编辑器已有的「技能/MCP 多选」实现（`src/client/assistants/AssistantPanel.tsx:945-951` 状态 + `:984-1015` catalog 拉取 + `:1273-1285` 多选渲染；数据来自 `skill.catalog` / `mcp.catalog`，按 `agentPresetId` 取），放进「模型与环境」分区。

4. **改一条会被打脸的测试**
   - `tests/assistant-instances.spec.ts:285-286` 现在断言「传 skillAllowlist 就报错」；P1 要把它改成「接受并落库」，并补一条 update 路径的断言（改技能 → 快照变 → revision 增），以及一条「技能名非法 → `SKILL_REFERENCE_INVALID`」的直建用例（证明校验被复用）。

5. **要不要碰 transport：不要。**
   - `assistant.instance.create` / `.update` 的 transport 只做 `payload as never` 转发，真正校验在 service（`src/transport/web.ts:243-249`）；
   - 契约类型由 schema 推导，改 schema 自动跟随（`src/transport/contracts.ts:397-401`，`CreateAssistantInstanceInput` = `src/domain/types.ts:66`）；
   - 宿主工具面（成员调 `team_mode_*`）不涉及实例创建，无需改。

**风险与边界**：`mcpCatalog()` 依赖 `agentPresetId`，而创建对话框允许"先选技能再改 preset"——顺序上必须**以提交时的 `agentPresetId` 为准**做服务端校验（已有 `:3702-3713` 就是这么做的），UI 侧只在 preset 变化时重取 catalog，不要缓存跨 preset 的选择。

---

## D. 本次调查没做的

- 没有跑 `npm run check`（只读调查，未改代码；文档提交不需要构建门禁）。
- MausBot 侧只读了字段语义相关文件（`PermissionsSection.tsx`、`shared/approval-mode.ts`、`shared/outbound.ts`、`shared/command-allowlist.ts`），没有复核它的执行端实现。
- 没有验证 `dsh-experimental-auto-review` 挂载后的行为（本部署未挂，且 P6 结论不需要）。
