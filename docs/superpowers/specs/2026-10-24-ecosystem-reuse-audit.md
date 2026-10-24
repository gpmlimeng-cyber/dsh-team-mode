# DSH Ecosystem Reuse：能力发现与策略接缝 — 审计与设计

> 2026-10-24 · Task 1（审计 + 契约 + 测试清单）· 上游：`docs/superpowers/plans/2026-10-24-ecosystem-reuse.md`、`docs/COMPETITIVE-GAPS.md` P1
> 范围：只读能力清单、capability groups 编译为现有 allowlist、fail-closed 规则、host-trusted 边界、测试。**本文件不改代码**，Task 2 才实现。
> 锚点：DSH `0.2.1-rc.2`（`/usr/local/lib/node_modules/@deepseek-ai/dsh/`，本仓 `node_modules/@deepseek-ai/*` 同版本）。结论全部来自已安装包的 `.d.ts` / 实现与仓库现状，没有引用未安装源码。

## Status

审计完成，四条结论：

1. **不需要新工具**：现有 24 个团队工具不动；能力清单走 Web RPC（只读），不是模型工具。
2. **不需要新权限系统**：成员工具策略（`toolPolicies`）已经是正确接缝，缺的只是「分组」这一层配置糖；
3. **不做插件沙箱**：DSH `0.2.1-rc.2` 没有暴露插件级权限。工具面可以治理，插件代码与 MCP 进程是 host-trusted，只能文档化。
4. **真正缺口有三个**：只读能力清单（谁提供了什么、哪些受治理）、可复用分组、三方边界的显式声明。

对照计划 Review Focus：

- 清单只读且来源归属 → §4 的 `origin` / `source` / `provider` + FC-8；
- 分组不能放大基线 → §5 全交集 + FC-5；
- 未知 group/policy 失败关闭 → FC-1 / FC-2；
- host-trusted 副作用显式 → §7 HT-1..HT-6，不藏在实现里；
- 不新增工具 → §9，清单只走 Web RPC。

## 1. 能力发现：插件能读到的 Host API

| 表面 | API（`.d.ts` 位置） | 能读到 | 归属信息 | 限制 |
|---|---|---|---|---|
| Tools | `ctx.tools.schemas(scope?)` / `get(name, scope?)`（`dsh-tools/lib/types/index.d.ts:712`、`:691`） | 可见工具名、description、parameters | **无来源字段**。只能靠 scope 视图差集推断 Host / 预设 | `schemas()` 只给模型面字段；`visible` 里含 `run_code`（PTC 模式） |
| Tools 分层 | `view(scope)` 语义（`dsh-tools/lib/index.js:3055-3085`） | 全局层 + scope 链祖先层 + **本层**注册 | 本层注册不受 `restrict` 约束（关键事实，见 §2.1） | 没有「列出所有层」的 API，只有按 scope 求视图 |
| Skills | `ctx.skills.list({scope?, cwd?})` / `snapshot` / `get`（`dsh-skill/lib/types/index.d.ts:266`、`:284`） | name/description/`source`/`provider`/`invocation`/`path` | **有** `source`（project/runtime/user…）与 `provider` | 读 `get()` 会加载正文；清单不得读正文（§4 不泄密规则） |
| MCP | 无服务。只能枚举 `ctx.tools` 里 `mcp__<server>__<tool>` 的工具名（`dsh-mcp-client/README.md` 命名契约；本仓解析器 `src/domain/mcp.ts:2`） | server 名 + 每 server 工具名/描述 | 只有 server 名；**无 transport / url / command / env / 连接状态** | MCP 服务端元数据不对插件暴露（`dsh-mcp-client` 只往 `ctx.tools` 注册） |
| Agent Presets | `ctx.agentPresets.list()` / `resolve()` / `acquireScope()` / `inspectCompositions()`（`dsh-agent-preset-registry/lib/types/index.d.ts:68`、`:91`、`:129`、`:63`） | id/name/description/broken、保留修订、模块引用 | 预设 = 一个 layer（`acquireScope().key` 可用于 tools/skills 视图） | `inspectCompositions` 只给模块引用与隔离诊断，不给「该模块提供哪些工具」 |
| Permission Presets | `ctx.permissionPresets.names` / `optionOf` / `catalog` / `current(session)`（`dsh-permission-presets/lib/types/index.d.ts:126-174`） | 预设名、sandbox mode、approval policy、显示名 | 预设 = (sandbox, approval) 二元组 | 只读名字与 bundle；**每个 Session 可被用户随时切换**（§7 HT-4） |
| 插件包 | `ctx.loader.entries()`（`cordis-plugin-loader/lib/types/config/tree.d.ts:15`；`Entry` 见 `entry.d.ts:21`） | 插件 entry id、包名、`disabled`、`fiber` 状态 | entry id 即归属 | entry `config` 可能含密钥（MCP env/headers）；**清单不得读 config** |
| 模型 / 工作区 | `ctx.llm.listProviders/listModels`、`ctx.workspaceRegistry.list` | 已有 `catalog()` 在用（`src/service/dsh-team-mode-service.ts:314-349`） | 无 | 与能力治理无关，仅清单上下文 |
| UI Slots | `@deepseek-ai/dsh-client-ui-slots`（client-only） | 槽位是客户端渲染注册 | 无 | Host 插件读不到、也不该治理（§7 HT-6） |
| 审批 / 沙箱 | `ctx.approval`、`ctx.sandboxPolicy`（`dsh-sandbox-policy/lib/types/index.d.ts:80`） | 审批与 sandbox 由 Session 的权限预设驱动 | 无 | 团队策略不能自动批准；也不应自动批准 |

**DSH 没有 capability 服务/注册表**：`Context` 上可用的只有 tools / skills / agentPresets / permissionPresets / loader / llm / workspaceRegistry 等具体注册表，没有统一的 capability 目录，也没有「某工具属于哪个能力组」的元数据。因此下文 `capabilityGroups` 是**本插件部署配置**的概念，不冒充 Host API；清单里的 `governable` 字段是审计结论，不是 Host 提供的保证。

已存在、可复用的只读发现实现：

- `skillCatalog(agentPresetId)`：`src/service/dsh-team-mode-service.ts:385-419`（租预设 scope，过滤 `isModelInvocable || isUserInvocable`）。
- `mcpCatalog(agentPresetId)`：`:421-454`（从工具名反解 server）。
- `catalog()`：`:314`（providers/models/presets/permissions/workspaces）。

**这三个已经是「能力发现」的实现，能力清单不该另造一套读取逻辑，只补归属、策略视图和边界声明。**

### 1.1 归属算法（tools，唯一可用手段）

在预设 scope 与全局 scope 各取一次视图，做名字差集：

```text
host    = names( tools.schemas() )                     // 全局层
scoped  = names( tools.schemas(presetScope.key) )      // 全局 + 祖先 + 预设层
preset  = scoped − host
shadow  = host ∩ scoped，且 get(name) 与 get(name, presetScope.key) 的
          description/parameters 不同 → 'preset-shadowing-host'（歧义，如实标注）
mcp     = 名字匹配 ^mcp__([A-Za-z0-9_-]{1,32})__ → 'mcp:<server>'
team    = TEAM_TOOL_NAMES（不在上面两个视图里：它注册在成员自己那层）
unknown = 其余
```

限制（必须写进清单的 `limitations`）：同名遮蔽只能启发式判定；`run_code` 是保留传输层，单列不参与归属；成员运行时的本层注册（团队工具）无法通过无 Agent 的视图读到。

## 2. 现有 `toolPolicies` 解析与成员激活

| 环节 | 位置 | 现状 |
|---|---|---|
| 配置 | `src/config.ts:8-13` `MemberToolPolicyConfig`；`:61` 字段；`:86-89` schema | `toolPolicies: { [id]: { description?, allow: string[] } }`，默认 `{}` |
| 成员字段 | `src/domain/schemas.ts:365`（`toolPolicy` optional）、`:738`（创建输入） | 只存策略 id；模型/传输层不能传 allow/deny（测试 `tests/agent-team-service.spec.ts:1059-1087`） |
| 创建/添加校验 | `src/service/dsh-team-mode-service.ts:2324`、`:2509`；`createMemberSlot` `:3942` | `resolveMemberToolPolicy` 提前失败（未知 id → `TOOL_POLICY_INVALID`） |
| Leader 豁免 | `src/runtime/team-tools.ts:242-248` | Leader 永远拿完整面；旧 id 不会拖垮 Leader 启动 |
| 激活时解析 | `src/runtime/team-runtime.ts:1693-1701` | Agent 创建前解析，配置里已删除的策略 → 激活失败（不回退基线） |
| 团队工具过滤 | `src/runtime/team-tools.ts:191-196`；注册入口 `:250-257`；调用 `src/runtime/team-runtime.ts:1808` | 基线 ∩ allow，注册前丢弃；**不能**用 `restrict`（团队工具在本层，`restrict` 豁免本层） |
| 继承工具过滤 | `src/runtime/team-tools.ts:205-215`；调用 `src/runtime/team-runtime.ts:1901-1910` | 可见继承面 ∩ allow，排除 `run_code` 与团队工具，再 `tools.restrict({allow})` |
| Prompt | `src/runtime/team-tools.ts:160-181` | 「Available team tools」行按实际注册结果重写；别名不入提示 |
| MCP | `src/runtime/team-runtime.ts:1809-1833` | 三重门：选中 server 缺失 → 失败；未选中的工具 `restrict({deny})`；guard 按 server 拒绝 |
| Skills | `:1834-1899` | 选中 skill 缺失 → 失败；未选中的 skill 由影子 provider 标成不可调用（`src/runtime/scoped-skills.ts:5`）；`skill` 工具 guard 只放行选中项 |
| 权限预设 | `:1911-1914` | 激活时按成员 `permissionPresetId` 写入 Session；用户后续可通过 `team.member.setPermissionPreset`（`src/transport/contracts.ts:558`）改 |

### 2.1 必须知道的五个注册表事实（决定设计能怎么做）

1. `restrict` **只作用于继承层**（全局 + scope 链祖先），**本层注册豁免**（`dsh-tools/lib/index.js:3055-3085`）。因此团队工具只能在注册前过滤；`run_code` 也在豁免面里，且 `restrict` 显式拒绝命名它（`:3001`）。
2. `restrict({allow: []})` 合法（只有 `restrict({})` 是 no-op 报错，`:2996`）：空 allow = 关掉全部继承工具。未知名字会抛错（`:3004`），所以必须传「实际可见名」。
3. `restrict` 是活的：之后全局新注册的工具（例如 MCP 重新同步）同样被过滤，不需要重新挂载。
4. 策略是**整面白名单**：策略一旦存在，没被列出的继承工具全部关闭（现有行为，`docs/tools.md` 成员工具策略节）。这是 fail-closed 的代价，不是 bug。
5. `guard` 是单调 deny，注册在可扩展 `tools/pre-execute` waterfall 之后（`dsh-tools/lib/types/index.d.ts:656`）；第三方 listener 无法把 deny 翻回 allow，但能改参数/结果（§7 HT-2）。

## 3. 可治理 / 不可治理矩阵

| 表面 | 治理手段 | 是否已治理 | 备注 |
|---|---|---|---|
| 团队工具（24） | 注册前过滤（本层） | ✅ | Leader 豁免 |
| Host / 预设工具 | `restrict({allow})`（继承层） | ✅ | 活过滤；新工具自动纳入 |
| MCP 工具 | 选中校验 + `restrict({deny})` + server guard | ✅ | 只治理「能不能调」，不治理服务端行为 |
| Skills | 目录校验 + 影子 provider + `skill` guard | ✅（影子法偏 hack） | 用户显式调用路径依赖 invocation=false |
| `run_code`（PTC 传输） | 不可命名、不可 restrict | ⚠️ 不可治理 | 可见工具集合已被 restrict；`run_code` 自身始终可见 |
| 模型 / provider | 助手快照固定 | ✅（非权限意义） | 每成员独立路由 |
| 权限预设（sandbox/approval） | 激活时写入 Session | ⚠️ 用户可改 | 不是团队硬边界 |
| 第三方插件副作用 | 无 | ❌ | 无插件权限 API（`0.2.1-rc.2` 安装包未发现插件级 trust/permission 服务） |
| MCP 服务端 | 无 | ❌ | 独立进程/HTTP，被配置信任 |
| Skill 正文指令 | 无 | ❌ | 指令内容可诱导模型调用已允许工具 |
| UI Slots | client-only | ❌（不适用） | 复用，不治理 |

## 4. 设计 A：只读能力清单 `capability.inventory`

一个 Web RPC（**不是模型工具**，不进 24 个工具基线），复用 §1 的三个 catalog 方法 + 归属差集。落点：

- 契约：`src/transport/contracts.ts` 增加 `'capability.inventory'` 到 method 联合与 `RequestMap`，payload `{ agentPresetId?: string; workspaceId?: string }`（都可选：缺省 = 当前默认预设 + 首个工作区）。
- 分发：`src/transport/web.ts:209` 附近加一个 `case`，只调 `service.capabilityInventory(...)`。
- 服务：`AgentTeamService.capabilityInventory()`，只读，**不写聚合、不 bump revision、不触发事件**。

```ts
interface CapabilityInventoryView {
  observedAt: string                 // ISO，纯观察信息
  workspace: { id: string; path: string } | null
  agentPreset: { id: string; name: string; broken?: string } | null
  tools: Array<{
    name: string
    description: string
    origin: 'team' | 'host' | 'preset' | 'preset-shadowing-host' | 'mcp' | 'unknown'
    mcpServer?: string
    governable: 'registration-filter' | 'restrict-allow' | 'deny-only' | 'not-governable'
  }>
  skills: Array<{
    name: string; description: string
    source: string; provider: string
    modelInvocable: boolean; userInvocable: boolean
    governable: 'selection-shadow'
  }>
  mcpServers: Array<{ name: string; tools: string[]; governable: 'selection-intersect' }>
  policies: Array<{
    id: string; description?: string
    allow: string[]; groups: string[]
    compiled: {
      tools: string[]                                   // 团队工具 ∩(allow ∪ groups)
      inherited: string[]                               // 当前可见继承面 ∩ …
      skills: string[] | null                           // null = 未约束
      mcpServers: string[] | null
    }
    invalid?: string                                    // 未知 group / run_code / 空 group
  }>
  groups: Array<{
    id: string; description?: string
    tools: string[]; skills: string[] | null; mcpServers: string[] | null
    unresolved: { tools: string[]; skills: string[]; mcpServers: string[] }
  }>
  pluginPackages: Array<{ name: string; version?: string }>   // 仅 name/version，绝不读 entry.config
  limitations: string[]
  errors: Array<{ section: 'tools' | 'skills' | 'mcp' | 'plugins' | 'preset'; message: string }>
}
```

规则：

- **不泄密**：不读 `entry.options.config`（MCP env/headers、凭据）、不读 skill 正文（`skills.get()`）、不读 MCP transport/url。`pluginPackages` 只来自 entry 包名与 `package.json` name/version（同 `dsh-plugin-package-inventory-deepseek` 的口径）。
- **分区降级**：某段读失败（预设 broken、skills provider 抛错）→ 该段空数组 + `errors` 一条，其余段照常返回；`capabilityInventory` 本身不抛业务错误以外的东西。
- **只读证明**：调用前后 `store` 聚合 revision 不变；不注册工具、不写 Session、不发 `team/change`。
- 与现有 `skill.catalog` / `mcp.catalog` 的关系：它们保留（客户端已用）；新 RPC 是「超集视图」，内部复用同一实现，不复制读取逻辑。

## 5. 设计 B：capability groups 编译到现有 allowlist

原则：分组是**配置糖**，编译结果就是现有 `MemberToolPolicyConfig.allow`；成员、schema、传输层都不需要新字段。

### 5.1 配置形状（config only，无 schemaVersion 变化）

```yaml
capabilityGroups:
  fs-read:
    description: Read-only 文件工具
    tools: [read, grep, glob]
  web:
    description: 只读网络
    tools: [web_search, web_fetch]
    skills: [dsh-plugin-guide]        # 可选：交集到助手 skillAllowlist
    mcpServers: [web]                 # 可选：交集到助手 mcpServers
toolPolicies:
  researcher:
    description: 调研成员
    groups: [fs-read, web]
    allow: [team_members]             # 可选：显式追加（仍是基线内）
```

语义（全部是「收窄」）：

```text
policy.allow 有效值   = allow ∪ ⋃(group.tools for group in groups)
成员工具面           = TEAM_TOOL_NAMES ∩ 有效值
成员继承面           = visibleInherited ∩ 有效值（排除 run_code / 团队工具，沿用现有实现）
成员 Skill 面         = 任一 group 声明 skills ? assistant.skillAllowlist ∩ ⋃(声明的 skills) : assistant.skillAllowlist
成员 MCP 面           = 任一 group 声明 mcpServers ? assistant.mcpServers ∩ ⋃(声明的 mcpServers) : assistant.mcpServers
```

- group 的 `skills` / `mcpServers` **省略 = 不约束**；**给空数组 = 关闭该面**（与 `allow: []` 同款 fail-closed，避免「materialized empty config」变成放行）。
- 策略与成员绑定方式不变：成员仍只存 `toolPolicy` id；Leader 仍豁免；不新增运行时改策略入口（唯一入口仍是部署配置 + 重载/重连）。
- 没有 `groups` 的旧策略行为完全不变；没有策略 = 完整基线。

### 5.2 编译时机与失效

- `apply()` 时编译一次：`compileCapabilityGroups(config)`（新纯函数，建议 `src/runtime/capability-groups.ts`）产出 `compiledPolicies`，Service/Runtime 用编译后的 map（`this.config.toolPolicies` 仍是原始配置，仅作诊断）。
- 单条策略编译失败（未知 group、group 含 `run_code`、group 为空对象）→ 该策略标 `invalid` 并带原因；**不 disable 整插件**（否则一条坏配置拖垮所有团队）。
- 绑定/激活到 invalid 策略 → 沿用现有 `TOOL_POLICY_INVALID` 失败关闭（`resolveMemberToolPolicy` 抛错），绝不回退基线。
- 组内未知工具名（Host 尚未加载、拼写错误）：编译时保留、生效时被基线/可见面交集自然丢弃；清单里进 `unresolved`，不 panic。这是可观测性，不是放宽。

### 5.3 代码落点（Task 2，最小步）

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/config.ts` | 新增可选 `capabilityGroups` schema；`MemberToolPolicyConfig` 加可选 `groups` | 小 |
| `src/runtime/capability-groups.ts`（新） | 纯函数：解析 group、交集、`invalid` 诊断、`run_code` 拒绝 | 中 |
| `src/service/dsh-team-mode-service.ts` | 服务接收 `compiledPolicies`（替换 3 处 `this.config.toolPolicies` 读取）+ `capabilityInventory()` | 中 |
| `src/runtime/team-runtime.ts` | `memberToolPolicyFor(role, compiledPolicies, id)`；Skill/MCP 面改成「助手快照 ∩ 策略组」后再走现有三重门/影子 provider（`:1809-1899` 只改变量来源） | 小 |
| `src/transport/contracts.ts` / `web.ts` | 新增只读 RPC 与视图类型（`src/client/api.ts` 是泛型转发，无需改） | 小 |

## 6. Fail-closed 规则

| 编号 | 规则 | 可测断言 |
|---|---|---|
| FC-1 | 未知策略 id：创建/添加/克隆绑定/激活都抛 `TOOL_POLICY_INVALID`，不回退基线 | 现有测试保持绿；激活路径新增断言 |
| FC-2 | 未知 group id 让引用它的策略 `invalid`，绑定即失败 | `compileCapabilityGroups({p:{groups:['nope']}})` → `invalid`；create 抛错 |
| FC-3 | group 显式 `skills: []` / `mcpServers: []` 关闭该面 | 激活时 `skill` guard 拒绝一切；未选中 MCP 全部被 deny |
| FC-4 | `run_code` 永不进任何编译后的 allow | 编译后 allow 不含 `run_code`；`restrict` 不会收到它 |
| FC-5 | 编译只做交集：`team ∩ (allow ∪ groups)`、`visibleInherited ∩ …`、助手快照 ∩ group 面 | 给 group 塞基线外名字 → 结果不含它 |
| FC-6 | 激活时策略从配置消失 → 失败（现有 `memberToolPolicyFor` 语义），Leader 例外照旧 | 现有单测 |
| FC-7 | 清单分区失败不伪装成空能力：该段 `errors` 必填，且不抛给客户端 | fake provider 抛错 → 200 + `errors` |
| FC-8 | 清单只读：不写聚合、不改 revision、不注册工具 | 调用前后 `getTeam().revision` 不变、`tools.register` 未被调用 |

## 7. Host-trusted 边界（明示，不隐藏）

| 编号 | 边界 | 事实 | 团队策略能做什么 |
|---|---|---|---|
| HT-1 | 第三方插件代码 | Cordis 插件在 Host 进程内运行，可读写文件/网络/进程、注册工具、挂事件与定时器；`0.2.1-rc.2` 未暴露插件级权限/信任 API，准入只有 profile bundle 组合 + 人工启用 | 只能治理它**注册出来**的工具是否对模型可见/可调；不能限制插件自身行为 |
| HT-2 | 工具执行管线 hook | 第三方可挂 `tools/pre-execute`/`post-execute`/`execute`，可改参数与结果；`guard` 单调 deny 不可被翻回 allow，但 hook 仍能改语义 | 策略不是安全边界，只是模型面治理；清单标注 `not-governable` |
| HT-3 | MCP 服务端 | 独立进程/HTTP，凭据在其配置 `env`/`headers`；工具名契约 `mcp__server__tool`。插件只能看到注册出来的工具名 | 可选/可 deny/可 guard；无法验证端行为、无法看 transport |
| HT-4 | Skill 正文 | skill 是**指令文本**，可诱导模型使用已允许的工具；用户显式调用路径由 `userInvocable` 决定 | 只能控制「哪些 skill 可被加载/可调用」；不能约束指令后果 |
| HT-5 | 权限预设 | `permissionPresets` 是每 Session 的 sandbox+approval bundle，且用户可通过 `team.member.setPermissionPreset` 随时改 | 团队策略不承诺 sandbox 边界；成员「不得越权」只在工具面成立 |
| HT-6 | UI Slots | client slot 注册属渲染层，Host 插件不可见 | 复用原生 slot；不治理、不替换 |

清单 `limitations` 至少固定三条：`tool origin 为差集推断，host/preset 同名遮蔽不可完全判定`；`MCP 服务端元数据不可见`；`pluginPackages 仅 name/version，且不覆盖程序化挂载的插件`。

## 8. 测试清单

| 文件 | 用例 | 断言 |
|---|---|---|
| `tests/capability-groups.spec.ts`（新） | 组编译：union、去重、顺序稳定、空组 invalid、未知组 invalid、`run_code` 拒绝 | 纯函数输入输出；不触碰 Host |
| 同上 | 交集不放大：组内基线外名字 / 未加载 host 工具名 | 结果 ⊆ 基线；`unresolved` 记录 |
| `tests/team-tools.spec.ts`（扩） | 编译后的 allow 走 `allowedTeamToolNames` / `allowedInheritedToolNames` | 基线顺序、`allow:[]`、空白归一、`run_code` 排除 |
| `tests/agent-team-service.spec.ts`（扩） | 绑定 invalid 策略 / 引用未知 group | `TOOL_POLICY_INVALID`；克隆保留 id 但重解析 |
| `tests/capability-inventory.spec.ts`（新） | 归属差集：host-only / preset-only / shadow / mcp / team / unknown | fake `tools.schemas()` 两个 scope 返回不同集合 |
| 同上 | 分区降级、无密钥、只读 | skills provider 抛错 → `errors`；fake `ctx.loader.entries()` 的 `config` 含 secret 时输出不含该值；revision 不变 |
| `tests/team-activation-policy.spec.ts`（新） | 激活接线：register 只含允许的团队工具；`restrict({allow})` 收到继承面交集；Leader 无 restrict | fake 成员 agentCtx 记录 register/restrict/guard 调用（现有 runtime harness 的 `tools` 只有 `get/schemas`，`:74`，需扩 fake） |
| 同上 | 组 skills/mcp 面与助手快照求交后，现有三重门/影子 provider 行为不变 | 未选中 MCP 全 deny；未选中 skill 不可调用 |
| 回归 | 无 `capabilityGroups` 时提示词与 24 工具不变 | `teamToolListLine` 输出逐字相等 |

## 9. 明确不做

- 不做插件沙箱、不做「插件权限清单」的假承诺；不新增 connector/cloud/mobile。
- 不新增模型工具，不加 `allow/deny` 原始列表入参；不做运行时改策略 RPC。
- 不改 `schemaVersion`、不迁移存储；能力清单不落库。
- 不用 `run_code` 做策略执行或绕过；不提供自动批准。
- 不把「成员权限继承」写成超过工具面的强声明（见 HT-4/HT-5）。

## 10. Task 2 落地顺序（每步 `npm run check`）

1. **分组编译**：`capability-groups.ts` + config + 单测（FC-2/3/4/5）。
2. **接线**：`compiledPolicies` 贯穿 service/runtime；Skill/MCP 面求交；激活接线测试（FC-1/6）。
3. **清单**：`capabilityInventory()` + RPC + 契约测试（FC-7/8）+ `docs/tools.md` / `docs/team-management.md` 补一节边界说明。
