# M1 生命周期现状盘点（创建 / 编辑 / 归档 / 恢复 · 独立工作区 · 团队关联）

> 2026-10-29 · 只读盘点，不改代码 · 基线 HEAD `c2f5413`
> 依据：`docs/superpowers/plans/2026-10-29-module-roadmap.md`（M1 定义与 Exit）
> 所有结论都带 `文件:行号`；没有「应该可以」。

## 一、总表

| # | 链路 | 现状 | 证据 | 缺口 | 工作量 |
|---|---|---|---|---|---|
| 1 | 创建 | 已通 | `assistant-dialogs.tsx:1069-1091`（create→分组补写→ensure→openSession）、`assistant-dialogs.tsx:1027-1035`（ensureAndOpen）、`dsh-team-mode-service.ts:1087-1147`（落库）、`assistant-runtime.ts:1883-1943`（ensure 绑定主会话） | 创建成功但开会话失败时只能「重试打开」，不能回退；改名后目录名不跟随（`workspacePath` 创建时定死，改名路径 `schemas.ts:995` 不含 workspace 字段） | 小 |
| 2 | 编辑 | 半通 | 可改：显示名称/职能/介绍/头像/吉祥物/模型/推理强度/权限预设/Skills/MCP/分组/置顶/记忆开关 —— `assistant-settings-pane.tsx:579-663`（save 组包）、`schemas.ts:975-1000`（update schema） | ① workspace 与 agentPreset 不可改，UI 已明示（`assistant-dialogs.tsx:470`、`:527`）——这是边界不是缺口；② **模型/推理强度对已打开主会话不生效**，且面板模型行没有提示（`assistant-runtime.ts:1893-1894` 命中 owned 直接返回，`agentOptionsFor` `:2319-2327`）；只有权限预设那行写了提示（`assistant-settings-pane.tsx:1246`） | 小 |
| 3 | 归档 | 半通 | `assistant-settings-pane.tsx:665-683`（两步确认）→ `dsh-team-mode-service.ts:1321-1332` → `assistant-runtime.ts:1290-1339` | ① **只停 worker、不停主会话**：`owned` 里主会话 handle 在归档时未清理（`owned` 只在 dispose 的 `:308-309` 与 handoff 的 `:1013-1015` 被清理，归档路径不碰它），已归档同事的原生主会话仍可继续对话到进程重启；② **对团队关联零提示**（见第四节）；③ 归档把在飞任务写成 `cancelled`（`:1303`），恢复也不回来 | 中 |
| 4 | 恢复 | 已通（入口齐） | 两个入口：`assistant-sidebar.tsx:1209-1219`（侧栏「已归档」折叠逐行恢复）、`assistant-settings-pane.tsx:703-716` + `:1406-1416`（设置面板）；service `dsh-team-mode-service.ts:1367-1389` | 恢复只回行：任务仍是 `cancelled`（`restoreAssistantTask` 只认 `archivedAt`，`dsh-team-mode-service.ts:1543-1553`）、暂停标记保留（`dsh-team-mode-service.ts:1363-1366` docblock）、团队关联不动；**三处文案与代码相反**（见第五节） | 小（文案）/中（补任务语义） |
| 5 | 独立 workspace | 已通 | 见第二节 | 默认隔离与「可入团队」互斥（`assistant-form.ts:134` vs `dsh-team-mode-service.ts:5207-5220`）；会话级 cwd 不受限、宿主行为未证实（`thread-session.ts:43-48`、`tests/assistant-runtime.spec.ts:865-874`） | 小~中 |
| 6 | 团队关联冲突 | 半通（有语义、无入口、无归档提示） | 见第四节 | 归档/恢复不检查关联；UI 无关联入口；关联后归档静默降级 | 中 |

## 二、独立 workspace 现状

**新建时怎么选**：创建对话框的 Workspace 下拉 + 「独立工作区」开关。

- 下拉默认取目录里第一个可用（非隔离）workspace：`assistant-form.ts:165-182`（`assistantCreateDefaults` + `workspaceSelectable`，`:154-158` 排除 `isolated` / 非 `ok`）。
- 「独立工作区」默认 **开**：`assistant-form.ts:134`（`workspaceIsolated: true`）、文案 `assistant-dialogs.tsx:496-511`；payload 只在为真时携带 `assistant-form.ts:264`。

**会不会串到别的同事**：不会（默认路径下），目录名 = 名字 slug + 实例 id 前 8 位，且以真实注册绑定。

- 路径生成：`dsh-team-mode-service.ts:243-251`（`assistantWorkspacePath` = `<base>/.dsh-team-mode/assistants/<slug>-<id8>`），`slug` 见 `:230-237`（非拉丁名统一退化为 `assistant`，靠 id8 保唯一）。
- 建目录 + 注册 + 写 `.gitignore`：`dsh-team-mode-service.ts:258-277`（幂等；用户已有 `.gitignore` 不覆盖 `:270-275`）。
- 落库写的是**独立注册的 workspaceId/Path**，不是 base：`dsh-team-mode-service.ts:1106-1137`。
- 私有注册被标记 `isolated: true`，选择器不再把它当 base（防嵌套）：`dsh-team-mode-service.ts:531-543`、`assistant-form.ts:154-158`；原生侧栏也不画它的行：`assistant-instances.ts:196-202`。
- 关掉开关 = 与所选 Workspace 共用（旧同事同样没有标记，读作共享）：`schemas.ts:169-175`、`assistant-form.ts:100-108`、`tests/assistant-instances.spec.ts:1823-1840`。

**归档时会不会删**：不会。仓库里没有任何删目录/删 workspace 的调用（`src` 内无 `rmSync`/`rmdir`/`fs.rm`/`unlink`），`deleteAssistantInstance` 只在 `store.ts:119` 声明、`store.ts:236` 实现，**service/transport/UI 全无调用**；归档只写 `status`/`archivedAt`（`dsh-team-mode-service.ts:1342-1361`）；恢复也不动 workspace（`:1367-1389` docblock 明写）。测试直接断言了「两个同学不共目录」：`tests/assistant-instances.spec.ts:1813-1815`（幂等复用见 `:1781-1816`）。

**这一块唯一的真缺口：会话级 cwd 不受实例 workspace 约束。**「在工作目录中新建…」把用户挑的任意目录当作该会话 cwd，而实例 workspace 不变：`assistant-sidebar.tsx:500-515` → `dsh-team-mode-service.ts:2202-2208` → `assistant-runtime.ts:476-486` → `thread-session.ts:35-48`（只校验 workspaceId 可用，cwd 原样写进 Session header，测试直接断言任意目录被接受：`tests/assistant-runtime.spec.ts:865-874`）。

宿主 `attachSession` 是否拿 `workspace.path` 校验 header cwd，本仓库**无法证实**（`dsh-team-mode-service.ts:254-259` 的注释说会校验）。两种结果都不算「不串」的正向保证：要么真的跑在别的同事目录里，要么在宿主层失败、而 UI 只会显示「新建会话失败」（`assistant-sidebar.tsx:490-494`）。插件侧加一层校验即可收口，不必赌宿主行为。

## 三、编辑现状明细（改哪些、哪些改了没用）

改得到（`assistant-settings-pane.tsx:579-663`）：显示名称、职能、一句话介绍、头像、吉祥物、provider+model（成对校验 `dsh-team-mode-service.ts:1168-1171`）、推理强度、权限预设、Skills、MCP、分组、置顶、记忆自动捕获。

改不到（服务端 schema 无字段，`schemas.ts:975-1000`）：**workspaceId / workspaceIsolated / agentPresetId / templateId**。UI 已明示前两者不可改（`assistant-dialogs.tsx:470`）与 agentPreset 定死（`:527`）。

改了「当场不生效」的：

- 模型 / 推理强度：`assistant-runtime.ts:1893-1894`——主会话已被本 runtime 持有就直接返回，不再读快照；只有重建或重新 resume（`:1935-1939` 传新 `agentOptions`）才生效。面板这一行**没有任何提示**（`assistant-settings-pane.tsx:1217-1240`）。
- 权限预设：`assistant-runtime.ts:2014` 在 setup 时写一次；对比团队侧改权限是实时下发（`team-runtime.ts:637`）。面板这行有提示（`assistant-settings-pane.tsx:1246`）。
- 身份/persona 反而实时：提示词每回合重读实例（`assistant-runtime.ts:1996-2002`）。

## 四、团队关联冲突现状

**能明确报错的部分（服务层做得很好）**：

| 场景 | 行为 | 证据 |
|---|---|---|
| 关联一个「独立工作区」的同事 | 明确报错，带补救话术（关掉独立工作区） | `dsh-team-mode-service.ts:5199-5221` |
| 关联一个属于别的 workspace 的同事 | 明确报错 | `dsh-team-mode-service.ts:5222-5230` |
| 同事已被本队另一个成员关联 | `ASSISTANT_IN_USE` | `dsh-team-mode-service.ts:5231-5243` |
| 同事已被别的团队关联 | `ASSISTANT_IN_USE` | `dsh-team-mode-service.ts:5244-5255` |
| 关联一个已归档的同事 / 归档当前总协调 | 明确报错 | `dsh-team-mode-service.ts:5196-5206`、`1327`（`assertNotCoordinator`，提示先 `assistant.coordinator.set`） |

**但用户碰不到这些冲突**：`team.member.setAssistantInstance`（`transport/contracts.ts:760-763`）在 `src/client` 里**没有任何调用方**；团队创建/加成员走的是模板 assistantId（`teams/TeamPanel.tsx:2172-2182`），从不带 `assistantInstanceId`。文档也承认这是 API-only：`docs/team-management.md:75`「（API，本期无界面）」。

**归档 / 恢复 / 换 workspace 三个动作的现状**：

- **归档**：不检查团队关联。`archiveAssistantInstance` 只做 `assertNotCoordinator`（`dsh-team-mode-service.ts:1321-1332`），团队成员的 `assistantInstanceId` 原样留着；测试就是「先关联再归档」的顺序（`tests/agent-team-service.spec.ts:2419-2431`）。归档后团队侧**没有任何提示**：记忆注入静默降级成空（`dsh-team-mode-service.ts:1794`、`tests/agent-team-service.spec.ts:2426-2431`），团队 UI 里 `archived` 一次都没出现（`team-pane.tsx` / `team-manage.tsx` / `teams/TeamPanel.tsx` / `team-board.tsx` / `member-avatar.tsx` 全无匹配）。归档确认文案也只讲「从单聊移除、停后台任务」（`assistant-settings-pane.tsx:1398-1399`），一个字没提团队。
- **恢复**：不看关联，直接回 `active`/`idle`（`dsh-team-mode-service.ts:1371-1381`）；团队链接本来就没断，所以「恢复即恢复关联」，也不提示。
- **换 workspace**：**没有这条路径**。更新 schema 无 workspace 字段（`schemas.ts:975-1000`），`createAssistantInstance` 是唯一写 `workspacePath` 的地方（`:1087-1147`）。所以「同事换 workspace」= 新建同事 + 重配团队，当前无提示也无向导。
- 结构性矛盾：独立工作区**默认开**（`assistant-form.ts:134`），而入团队**必须关**（`dsh-team-mode-service.ts:5207-5220`）——默认创建出来的同事天生进不了团队。
- 团队侧的归档也不是同事侧那套：活团队不能归档，必须先解散（`dsh-team-mode-service.ts:4902-4906`），UI 也是这么灰的（`sidebar.tsx:749-753`）；而归档团队**没有恢复 UI**，今日页写「仅查看，暂不支持恢复」（`today-surface.tsx:624-631`、`today-model.ts:109`），transport 其实有 `team.archive { archived: false }`（`contracts.ts:704`）。

## 五、Exit 判定

| Exit 判据 | 结论 | 差什么 |
|---|---|---|
| 一个同事从创建到归档到恢复，全流程可用 | **差一点（半满足）** | 链路本身能走通（创建 `assistant-dialogs.tsx:1069-1091` → 归档 `:665-683` → 恢复 `:1209-1219`）；但归档后主会话仍活着（`assistant-runtime.ts:1290-1339` 不动 `owned`），归档时在飞任务被打成 `cancelled` 且恢复不回（`:1303`、`dsh-team-mode-service.ts:1543-1553`），另有 3 处文案说「没有恢复入口」（`docs/assistant.md:90`、`:128`、`today-surface.tsx:630`）与实现相反 |
| 工作区不串、不删 | **已满足（默认路径）** | 不删：全仓无删除调用、归档/恢复只写行（第二节）。不串：默认隔离 + 路径含 id8 + 私有注册被选择器排除。唯一例外是会话级 cwd 不受实例 workspace 约束（`thread-session.ts:43-48`，宿主侧是否拒绝未证实），以及用户主动关开关的共享模式（明示） |
| 团队关联冲突明确 | **未满足** | 服务层四类冲突都有明确错误码和话术（第四节表），但**归档/恢复不检查关联**、**团队侧无任何标识**、**UI 无关联入口**（`docs/team-management.md:75` 承认 API-only）。用户看不到冲突，也就谈不上「明确」 |

## 六、按「挡 Exit 程度」排的建议顺序

1. **归档与团队关联对齐**（挡 Exit 3，也挡 Exit 1）——中
   归档前查一次 `assistantInstanceId` 引用：要么像 `assertNotCoordinator` 那样带补救话术阻断，要么在确认文案里点名「正在 N 个团队里使用」。复用现成的 `ASSISTANT_IN_USE` / `ASSISTANT_INSTANCE_COORDINATOR` 写法（`dsh-team-mode-service.ts:1327`、`:5231-5255`），不新造错误码。依赖：无。
2. **文案三处对齐**（挡 Exit 1 的验收，最便宜）——小
   `docs/assistant.md:90`、`:128`、`today-surface.tsx:630` 改成「团队暂不支持恢复；助手可恢复」（backlog 已点名，`2026-10-29-backlog.md:53-54`）。依赖：无。
3. **归档真正停住主会话**（挡 Exit 1）——中
   归档时把 `owned` 里的主会话 handle 停掉（`assistant-runtime.ts:308-315` 已有现成的 dispose 循环可复用），恢复时按 `mainSessionId` 重新 resume（`:1935-1939` 已支持）。依赖：无，但要补「归档后原生会话不可再发」的回归。
4. **会话级 cwd 收口**（挡 Exit 2 的例外）——小
   `createAssistantThread` 的 `cwd` 限定在实例 workspace 之内，或在 UI 明示「这会离开该同事的工作区」。证据链：`assistant-sidebar.tsx:500-515` → `assistant-runtime.ts:476-486` → `thread-session.ts:43-48`。依赖：无。
5. **模型/权限改动生效范围提示**（挡 Exit 1 的「编辑」验收）——小
   模型行补一句和权限预设同样的提示（`assistant-settings-pane.tsx:1217-1246`），或让 save 后主动 resume 主会话。依赖：3 做完后更自然（同一处 handle 管理）。
6. **团队关联入口 + 关联状态标识**（挡 Exit 3 的根）——大
   给成员行一个「关联同事」入口（`contracts.ts:760-763` 已有 transport），并在同事行显示「在 N 个团队」。这是唯一需要新 UI 的一项，建议放最后；前 5 项做完，Exit 1/2 已经能判定，Exit 3 至少从「静默」变成「明确拒绝」。

## 七、没做的

- 没跑 `npm run check`：本次只加一份 docs 笔记，未触 `src`/`tests`。
- 没盘 M2 的团队任务归档/恢复、队列控制面（不在 M1 Exit 里），只在第四节末尾记了团队归档「无恢复 UI」这一条与同事归档对照。
