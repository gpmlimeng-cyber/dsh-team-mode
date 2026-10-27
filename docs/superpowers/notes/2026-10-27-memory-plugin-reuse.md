# DSH 记忆插件复用调研（memory-plugin-reuse t6）

> 2026-10-27 · 任务：`t6`（只读调查，不改代码）
> 仓库：`/Users/limeng/DSH/团队/dsh-team-mode`
> 对象：`dsh-plugin-memory@0.10.0`（crazy_tong）、`dsh-memory-core@0.1.9`（venalita）
> 方法：`npm pack` 到 `/tmp/mem-plugin-reuse` 解包读源码；跑插件自带 self-test；在临时目录直接调用 `dsh-memory-core` 的 store；不安装进本仓库、不改 profile。
> 结论：**两个候选都不适合作为依赖复用**。M1 / M2 / M3 自建；M4 借鉴它们的提醒与去重思路，但写入仍走我们自己的 `proposed` 通道。

---

## 0. 结论表

| 缺口 | 复用插件 | 借鉴机制 | 自建（推荐） |
|---|---|---|---|
| **M1** 记忆条数行 + 管理入口 | 否：插件面板读的是自己的 `/api/memory/insights` 与 markdown 库，不是我们的 `assistant.memory`（`dsh-plugin-memory/lib/client.js:18,159`；`dsh-plugin-memory/lib/index.js:488-508`） | 可借：设置页“条数 + 健康度”的信息层级，但两者数据源不同（`dsh-plugin-memory/README.md:144-155`） | **采用**：`assistant.memory.get` 已经返回 `entries`，UI 只需一行 `记忆 · N 条 · 管理 →` 加跳转（`docs/superpowers/specs/2026-10-27-memory-gaps.md:11-18`） |
| **M2** 群聊级记忆 | 否：两者都没有 team/group scope；`dsh-plugin-memory` 是 profile 级全局目录，`dsh-memory-core` 只按 `presetName` + 项目 cwd 分目录（`dsh-plugin-memory/lib/index.js:127,245`；`dsh-memory-core/lib/defaults.js:28-33`） | 可借：core 的 project 轨按 cwd 隔离、key 按热词挑选（`dsh-memory-core/lib/store.js:385-410`；`dsh-memory-core/lib/budgets.js`），但“群”不等于 cwd，也不等于 preset（`dsh-memory-core/README.md:99-108`） | **采用**：`TeamAggregate.memory` 与 `teamMemoryPrompt` 已有数据与注入，缺的是 UI、Leader 写权限与“成员是否注入”的收紧（`src/domain/schemas.ts:275-285`；`src/runtime/team-prompts.ts:63-86`） |
| **M3** 「问 / 改」一句话 | 否：`dsh-plugin-memory` 全包没有注册工具（`dsh-plugin-memory/lib/index.js:122` 的 `inject` 不含 `tools`，grep 无 `tools.register`）；core 只有直写工具 `memory_core`，没有 `answer/change`，默认直写、无 `proposed`/`revision`（`dsh-memory-core/index.js:242-265,334-381`） | 可借：core 用“唯一子串定位，0 条或多条都报错”防止改错条目（`dsh-memory-core/lib/store.js:648-658`） | **采用**：一次模型调用返回 `{ kind: 'answer' \| 'change', answer?, entries? }`，改走 `assistant_memory_entry_write` + revision；注意当前 assistant 写入只允许 `active/archived`，`proposed` 是 team-only，需先扩展状态（`src/runtime/assistant-tools.ts:277-301`；`src/domain/schemas.ts:287-301`） |
| **M4** 自动捕获开关 | 否：两者都没有“每轮/完成时由模型提取 0–3 条候选”的代码；只有“该写了/闲置了”的提醒（`dsh-plugin-memory/lib/digest-guard.js:188`；`dsh-memory-core/lib/render.js:109-124`） | 可借：idle/digest 的触发时机、精确重复去重、lint 巡检清单（`dsh-memory-core/lib/store.js:605-619`；`dsh-plugin-memory/scripts/memory.mjs:194-228`） | **采用**：保留现有 `memoryAutoCapture` 的 proposed-only 通道，增加“每轮最多一次、0–3 条候选”的模型提议；默认关，UI 明示每轮多一次调用（`docs/superpowers/specs/2026-10-27-memory-gaps.md:48-56`；`docs/MEMORY-ARCHITECTURE.md:288-304`） |

一句话：**复用它们会丢掉 `visibility`、`status`、`revision/undo` 和“每轮注入在身份之前”的注入位置；这些正是我们与文件型记忆方案的分水岭（`docs/superpowers/specs/2026-10-27-memory-gaps.md:6-9`）。**

---

## 1. 实测方法与证据约定

### 1.1 下载与解包

```sh
mkdir -p /tmp/mem-plugin-reuse && cd /tmp/mem-plugin-reuse
npm view dsh-plugin-memory version dist.tarball
# 0.10.0  https://registry.npmjs.org/dsh-plugin-memory/-/dsh-plugin-memory-0.10.0.tgz
npm view dsh-memory-core version dist.tarball
# 0.1.9   https://registry.npmjs.org/dsh-memory-core/-/dsh-memory-core-0.1.9.tgz
npm pack dsh-plugin-memory@0.10.0   # 30 files
npm pack dsh-memory-core@0.1.9      # 18 files
tar -xzf dsh-plugin-memory-0.10.0.tgz -C plugin-memory --strip-components=1
tar -xzf dsh-memory-core-0.1.9.tgz -C memory-core --strip-components=1
```

### 1.2 实测结果

`dsh-plugin-memory` 自带 self-test：

```text
$ cd /tmp/mem-plugin-reuse/plugin-memory && node scripts/memory.mjs --self-test
initialized 13 entries -> /var/folders/.../memory
ok   init creates scaffold
ok   init is idempotent
ok   lint passes on valid page
packed 6 files -> /var/folders/.../pack.tar.gz
ok   pack writes archive
restored 6 files -> /var/folders/.../restore/.memory
ok   unpack restores files
self-test: PASS
```

`dsh-memory-core` 没有随包发布自测脚本（`README.md:146-152` 说 `_dryrun.mjs` 不发布）。直接在临时目录调用它的 store（不写本仓库、不碰 profile）：

```text
add('memory','用户喜欢中文') -> [2026-10-27] 用户喜欢中文
add 同一条                -> { ok:true, duplicate:true, '与已有记忆重复，未写入' }
project path              -> <tmp>/projects/ac4bf773dd63/memory.md
key path                  -> <tmp>/projects/ac4bf773dd63/key.md
SuggestionQueue           -> [{ target:'key', content:'x' }]
ArchiveStore              -> ['old']
```

这两次实测确认了下面“存什么、谁是写入者、重复怎么处理”的基本判断；其余结论来自源码逐行核验。

### 1.3 引用约定

- `dsh-plugin-memory/...`：解包后的包内路径，例如 `dsh-plugin-memory/lib/index.js:275`。
- `dsh-memory-core/...`：同上，例如 `dsh-memory-core/lib/store.js:581`。
- `@deepseek-ai/dsh-system-prompt/...`：本仓库 `node_modules` 里的宿主包。
- `src/...`、`docs/...`：本仓库路径。

---

## 2. `dsh-plugin-memory` 0.10.0

> 本节内未写包名的 `lib/...`、`skills/...`、`scripts/...`、`README.md` 均指 `dsh-plugin-memory`。

### 2.1 存什么

**一个全局 markdown 目录，不是“条目表”。**

- 默认库：`~/.memory`（`lib/index.js:127`；`README.md:103`）。
- 文件：`SOUL.md`（人格）、`BOOTSTRAP.md`（铸魂进度）、`MEMORY.md`（记忆协议）、`index.md`（路由表）、`log.md`（append-only 时间线），以及 `identity/ user/ skills/ decisions/ projects/{active,archive}/ concepts/ raw/`（`lib/scaffold.js:20-30,265-271`；`README.md:70-77`）。
- 每个页面是带 frontmatter 的 markdown：`title/date/type/salience/last_access/tags/sources`（`lib/scaffold.js:123-141`）。
- **没有条目 ID、没有 `visibility`、没有 `proposed/superseded/archived` 状态、没有 entry revision**。`grep -rn "visibility\|proposed\|superseded\|revision" lib skills scripts README.md` 在包内只命中 `config-store.js` 的 `private JSON` 说明和 README 的“encrypted volume”建议，没有记忆条目字段。
- 写入侧没有条目数/字符数上限；只有 **boot 注入预算** `bootMaxChars` 默认 12,000（`README.md:105`；`lib/boot.js:230-274`），以及按文件的预算分配（`lib/boot.js:99-159`）。
- 历史能力靠 `git`：默认 `autoCommit` 在改动安静 60 秒后 `git add -A && git commit`（`README.md:42,122-124`；`lib/index.js:257-270`）。这是**文件级**历史，不是条目级 revision/undo。

### 2.2 注入点：`systemPrompt.context`，不是 `systemPrompt.section`

```js
// dsh-plugin-memory/lib/index.js:273-285
bootDispose = ctx.systemPrompt.context({
  name: 'memory-boot',
  order: -200,
  text: (context) => {
    const agent = context?.agent
    if (agent && !tracker.shouldInject(agent.id, store.get())) return ''
    return renderBootBlock(memoryDir, { bootFiles, bootMaxChars, bootFileBudgets })
  },
})
```

- 注入的是 **runtime context**，不是 system prompt section。DSH 的 `systemPrompt.context()` 最终进入“sourced user-role snapshots in model history”（`@deepseek-ai/dsh-system-prompt/README.md:100`），渲染成一条 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`（`@deepseek-ai/dsh-system-prompt/lib/index.js:121-140`）。
- 宿主按投影去重：**内容不变只注入一次，变化时新快照替换旧快照**（`README.md:206-207`；`lib/boot.js:1-10`）。它不是“每轮把最新记忆重新拼进 system prompt”。
- 两个默认开启的礼貌门：`deferUntilUserSpeaks`（用户第一句真实消息后才注入）和 `activeSessionOnly`（只有最近收到用户消息的活跃会话注入）（`README.md:109-110,140`；`lib/index.js:196-197,279-284`）。**后台会话/非活跃成员会话可能拿不到记忆**，这对团队模式是副作用。
- `renderBootBlock(memoryDir, ...)` 只接收 `memoryDir`；**没有任何 assistantId/sessionId 参与拼接或选择**（`lib/index.js:284`；`lib/boot.js:230-274`）。

### 2.3 写入者：没有工具，靠 agent 自己改 markdown

- 包内没有 `ctx.tools.register`；`inject` 只有 `systemPrompt/skills/agents`（`lib/index.js:122`）。全包 `grep -rn "tools.register" lib skills scripts` 无结果。
- 写入由 `memory` skill 的操作协议驱动：`remember / recall / consolidate / forget` 都是“读页面 → 改页面 → 更新 `index.md` → 追加 `log.md`”（`skills/memory.md:18-21`；`lib/scaffold.js:106-121`）。skill 通过 `ctx.skills.register()` 注册（`lib/index.js:291-300`）。
- 另有一个 CLI `dsh-memory` 可手动 init/search/lint/status/pack/unpack（`README.md:178-195`）。
- 自动写入只有“提醒”没有“捕获”：idle 超过 `digestNudgeAfterMinutes` 后，通过 `agent.followup()` 注入一条 user-role 提醒，让 agent 去写 `log.md`/页面（`lib/digest-guard.js:1-20,188`；`README.md:40`）。内容仍由 agent 直接改文件，**没有 proposed 队列、没有确认步骤**。

### 2.4 冲突与去重：主要是文字约定，不是代码

- `MEMORY.md` 的约定是：“新信息与旧声明矛盾时：改旧页、在新页标注、`log.md` 记变更”（`lib/scaffold.js:137-141`）。
- skill 文档声称 `consolidate` 的 `lint` 会“查矛盾、过时声明、孤儿页……”（`skills/memory.md:20`），README 也说 “find contradictions”（`README.md:175`）。
- **但 `cmdLint` 的实际检查只有**：`index.md` 链接目标是否存在、孤儿页、frontmatter 必填项、`salience` 取值、index 行漂移/超长、`log.md` 行格式（`scripts/memory.mjs:194-228`）。它不读页面正文做矛盾检测，也没有语义重复/相似度去重。也就是说，**“查矛盾”目前是模型自觉执行的文字约定，不是可验证的代码能力**。
- 没有写入锁/条目级并发控制；并发写由 agent 的编辑顺序决定，`git` 只事后记录。

### 2.5 作用域与开关

- 作用域 = **profile 级全局目录**。`memoryDir` 是插件配置（composition 层）或 `<dshHome>/memory.json` 的热改项（`lib/index.js:125-162,188-203`；`README.md:100-113`）。同一 profile 下所有 assistant/session 共享同一个库；没有“每个助手一份”。
- 若要按助手隔离，插件本身没有这个开关：要么每个助手独立 profile（隔离靠部署方式，不靠插件），要么 fork 插件把 `assistantId` 加进 `memoryDir` 并改注入文本（等于重写）。
- 开关：`enabled`、`memoryDir`、`autoInject`、`registerSkill` 等可在设置面板热改；`bootFiles`/`bootMaxChars`/`bootFileBudgets`/`autoCommit*` 需要重启（`README.md:128`）。
- 兼容性成本：0.9+ 要求 DSH session format v4，0.8.0 及更早只支持 v3；两套白名单互斥（`README.md:89-94`）。手写 `insert` 与 bundle manifest 自动挂载会撞 `duplicate loader entry id "dsh-memory"`（`README.md:96`）。

### 2.6 对我们的适配结论

它提供的价值是“人格 + 可读 markdown 长期记忆 + 强制 boot 注入 + 整理 CLI”，但这些都与我们的核心模型冲突：

- 我们的每个 `MemoryEntry` 有 `visibility/status/revision/journal`，它没有；
- 我们要“每轮注入在身份之前”，它是 user-role runtime context 且去重；
- 我们要按助手/团队隔离，它是全局目录；
- M1/M3/M4 的 UI、问答、捕获它都没有现成 API。

**M1–M4 都不能直接复用它；最多借 `boot.js` 的按文件预算分配、`digest-guard` 的提醒时机。**

---

## 3. `dsh-memory-core` 0.1.9

> 本节内未写包名的 `lib/...`、`index.js`、`README.md` 均指 `dsh-memory-core`（带 `@deepseek-ai/` 前缀的除外）。

### 3.1 存什么

**按 preset 分的纯文本“轨”，条目用 `\n§\n` 分隔。**

- 数据目录：`$DSH_HOME/../.dsh-plugin-data/<presetName>/memory/`，或 `DSH_MEMORY_CORE_DIR`（`lib/defaults.js:28-33`；`README.md:74-76`）。默认 `presetName` 是字面量 `"default"`，多个 preset 不写会共用同一目录（`README.md:74-76`）。
- full 模式五轨（`lib/tracks.js:1-15`；`README.md:99-108`）：

  | 轨 | 文件 | 是否注入 |
  |---|---|---|
  | `memory` | `memory.md` | 是（预算 1000） |
  | `user` | `user.md` | 是（预算 600） |
  | `key` | `projects/<sha1(cwd) 前 12 位>/key.md` | 是（预算 400，按热词挑 top 5） |
  | `project` | `projects/<hash>/memory.md` | 否，按需 `memory_core list` |
  | `daily` | `daily/YYYY-MM-DD.md` | 否，按需 list |

- 条目形态：`[YYYY-MM-DD] 正文`（`daily` 是 `[HH:MM]` + 可选 `[git branch]` + `[项目名]`；`project` 是 `[YYYY-MM-DD HH:MM]`）（`lib/store.js:425-462`）。条目可选 `[id:8hex]`，但构造时 `entryIdMode` 默认 `off`（`lib/store.js:368-377`；`index.js:182` 没有开启），所以默认数据里没有 ID。
- 归档是另一个文件：`memory-archive.md` / `user-archive.md` / `projects/<hash>/key-archive.md`（`lib/store.js:889-953`）。
- 待确认是 `pending.md` 的 JSONL 队列（`lib/store.js:834-887`；`lib/tracks.js:17`）。
- 注入预算合计 2,000：`memory 1000 / user 600 / key 400`（`lib/budgets.js`；`lib/render.js:70-96`）。
- **没有 `visibility`、没有 `proposed/superseded/archived` 状态、没有 revision**。`grep -rn "visibility\|team-safe\|proposed\|superseded\|revision" index.js lib README.md` 无命中；归档是“从主轨搬到 `-archive.md`”，不是条目状态；待确认队列只在关掉直写开关时使用，也不是已存条目的状态。

### 3.2 注入点：同样是 `systemPrompt.context`

```js
// dsh-memory-core/index.js:435-449
ctx.systemPrompt.context({
  name: 'memory-core:snapshot',
  order: s.snapshotOrder,           // 默认 500
  text: (context) => {
    refreshLive()
    return renderSnapshot(store, s, writeGap, { agent: context?.agent ?? agentOf(ctx) })
  },
})
```

- 只把 `memory/user/key` 三轨渲染进快照；`project/daily` 不进上下文（`lib/render.js:70-96,109-124`；`README.md:99`）。
- 与 `dsh-plugin-memory` 一样，这是 runtime context（user-role 快照），不是 system prompt section；`order: 500` 只决定它和其他 **context** 的先后，不能决定它相对我们 `order: 9` 的身份 section 的位置（DSH 语义见 `@deepseek-ai/dsh-system-prompt/README.md:100`）。
- 未启用时零注册：`memoryEnabled !== true` 直接 return，不注册工具/注入/路由（`index.js:101-108`；`README.md:84`）。所以装完默认不影响任何会话。
- **进程级单例**：只有第一个实例注册工具/注入/路由；第二个实例只登记、不注册（`index.js:158-180`；`README.md:31,143`）。即使每个 preset 都挂载，也只有一个实例真正工作。

### 3.3 写入者：一个 `memory_core` 工具，默认直写

- `inject = ["systemPrompt", "tools", "webServer"]`（`index.js:22`）；注册一个工具 `memory_core`（`index.js:242-265,432`）。
- 动作：`add / list / replace / remove / archive`；`replace/remove/archive` 用唯一子串 `match` 定位，0 条或多条都失败（`index.js:242-265`；`lib/store.js:648-658`）。
- 默认 `directMemory/directUser/directKey = true`：`add` 直接落盘，不确认（`lib/defaults.js:14-17`；`index.js:334-356`）。只有把某一轨的直写关掉，`add` 才进入 `pending.md` 待确认队列（`index.js:357-381`；`lib/store.js:834-887`）。队列按 `target + trim(content)` 精确去重，重复只加 `hits`/`lastSeen`（`index.js:361-374`）。
- 子代理只读：`action !== 'list'` 一律拒绝（`index.js:299-301`）。
- **没有模型提取/自动捕获**：工具只写调用者传入的文本；看门狗只在连续 N 轮没写 `daily/project` 时在快照末尾加提醒（`index.js:206-219`；`lib/render.js:109-124`；`lib/watchdog.js`）。提醒不是候选条目，也不会自动写。

### 3.4 冲突与去重：精确重复 + 唯一子串，没有语义冲突

- `add` 先剥掉日期/git 前缀做 `dupKey`，完全相同则返回 `duplicate: true`，不写（`lib/store.js:605-619`）。这是**精确重复**，不是相似度去重。
- `replace/remove/peek` 用 `entry.includes(match)`，命中 0 条或多条都报错并返回候选（`lib/store.js:648-658,713-733`）。防止“改错条”的工程约束不错，但不处理“新旧事实矛盾”。
- `archive` 是两步：先写归档，再删主轨；删主轨失败会回滚归档（`index.js:406-424`；Web 路径 `index.js:801-814`）。`promote` 从归档搬回主轨（`index.js:858-871`）。
- 写入前有一个很轻的 prompt-injection 扫描：匹配“ignore previous instructions / 忽略之前的指令”等固定句式，命中拒绝（`lib/store.js:276-293`）。没有敏感信息（API key/token）脱敏。
- 没有 revision、没有乐观锁、没有条目级 undo；只有外部编辑导致格式漂移时的 `*.bak.<timestamp>` 备份（`lib/store.js:595-598`；`index.js:566-568` 的 `driftBackups` 状态字段也说明这一点）。

### 3.5 作用域与开关

- 作用域 = **preset + 项目 cwd**。`memory/user` 是 preset 级；`project/key` 按会话 `cwd` 的 sha1 前 12 位分目录（`lib/store.js:385-410`；`README.md:99-108`）。**没有 assistantId，也没有 teamId**。
- 启用方式：插件列表默认只注册管理页；要在目标 preset 的 `plugins` 里挂载并设 `memoryEnabled: true`（`README.md:24-49,82-88`；`cordis.patch.yml:1-7`）。
- 同一进程只能有一个实例接管 `/api/memory-core` 路由；profile 与 preset 同时开启会让后加载者报 `duplicate prefix route`（`README.md:31,143`；`index.js:158-180`）。
- 兼容性：`engines.dsh: >=0.2.0-rc.1 <0.3.0-0`（`package.json:45`）；本仓库当前 DSH 依赖是 `0.2.1-rc.2`（`package.json`），落在范围内。

### 3.6 对我们的适配结论

它比 `dsh-plugin-memory` 更接近“结构化条目”，但只到“纯文本 + 分隔符 + 日期前缀”这一层：

- 没有 `MemoryEntry` 的 scope/visibility/status/revision/journal；
- 作用域是 preset/cwd，不是 assistant/team；
- 默认直写，没有 proposed 确认；待确认队列只是关掉直写后的旁路；
- M1/M2/M3/M4 都没有现成 API；M4 只有“该写了”的提醒，没有“提取候选”。

**同样不能直接复用；可借它的精确去重、唯一子串保护、归档回滚、prompt-injection 扫描。**

---

## 4. 逐题回答

### Q1. 它们的记忆作用域是不是“每个助手一份”？能不能按助手隔离？

**不是，也不能在不改代码的前提下按助手隔离。**

| | `dsh-plugin-memory` | `dsh-memory-core` |
|---|---|---|
| 作用域键 | 只有 `memoryDir`（profile 级） | `presetName` + 项目 `cwd` |
| 同一 profile 多助手 | 共享同一个 `~/.memory` | 同一 preset 共享；不同 preset 若 `presetName` 相同也共享 `default` 目录 |
| 按助手隔离 | 需要每助手一个 profile，或 fork 加 `assistantId` 到路径/注入 | 需要 preset 与助手一一对应，且 **进程内只允许一个实例**（`dsh-memory-core/index.js:158-180`），多 preset 挂载只有第一个生效 |
| 证据 | `dsh-plugin-memory/lib/index.js:127,189-203,245,284`；`dsh-plugin-memory/lib/boot.js:230-274` | `dsh-memory-core/lib/defaults.js:28-33`；`dsh-memory-core/lib/store.js:385-410`；`dsh-memory-core/README.md:74-76,143` |

补充：本仓库的 assistant 有自己的 `agentPresetId`（创建时从 catalog 选择，`src/service/dsh-team-mode-service.ts:547-552`），但 preset 是可选运行模板，不是 assistantId；把“preset 目录”当“助手记忆”会在多个助手共用同一 preset 时串数据。即使强行一助手一 preset，`dsh-memory-core` 的单例也会让第二个 preset 不注册工具/注入。

### Q2. 有没有我们的 `visibility(private/team-safe)` 与 `status(proposed/superseded/archived)`？

**都没有。**

> 下表每列里的 `lib/...` / `README.md` 指该列所述包。

| 能力 | 我们（本仓库） | `dsh-plugin-memory` | `dsh-memory-core` |
|---|---|---|---|
| `visibility: private/team-safe` | `src/domain/schemas.ts:183,199`；注入时按 `team-safe` 过滤（`src/runtime/team-prompts.ts:74-78`） | 无；所有页面都在同一个库，boot 全量读（`lib/boot.js:230-274`） | 无；所有条目都在轨里，注入不区分可见性（`lib/render.js:70-96`） |
| `status: active/proposed/superseded/archived` | `src/domain/schemas.ts:186,200` | 无；只有 frontmatter `salience: 1/2/3` 和 `type`（`lib/scaffold.js:94-141`） | 无；归档是搬到 `-archive.md` 文件（`lib/store.js:889-953`），不是状态 |
| `revision` + 乐观锁 | `src/domain/schemas.ts:208`；写入工具要求 `expected_revision`（`src/runtime/assistant-tools.ts:277-280`） | 无条目 revision；git 是文件级历史（`README.md:42`） | 无；只有外部编辑漂移的 `.bak`（`lib/store.js:595-598`） |
| `journal` + undo | `src/domain/schemas.ts:238-250`；`src/service/dsh-team-mode-service.ts:1387-1444` | 无结构化 journal；`log.md` 是手写时间线，无 before/after 快照 | 无；归档可 promote 但不是 undo，且不保留原 revision |
| 写入脱敏 | `redactMemoryText`（`src/domain/memory.ts:101-131`） | 无 | 只有 prompt-injection 句式扫描（`lib/store.js:276-293`），无密钥脱敏 |
| 写权限 | 团队记忆成员只能 propose，Leader accept（`docs/MEMORY-ARCHITECTURE.md:148-164`） | 文件系统权限；任何能编辑文件的 agent 都能改 | 子代理只读（`index.js:299-301`）；没有团队角色概念 |

**接入后会丢的能力**：private/team-safe 的选择性注入、proposed 待审、superseded 历史链、按 entry 的 revision 冲突保护、journal 精确 undo、写入脱敏。这些不是 UI 装饰，是 M2/M3/M4 的契约基础。

### Q3. 它们怎么注入？能不能对齐我们“每轮注入在身份之前”？

**不能对齐，除非改它们的源码。**

- 我们都是 `systemPrompt.section`：记忆 section `order: 9`，身份 section `order: 10`（`src/runtime/assistant-runtime.ts:1288-1297`；团队侧 `src/runtime/team-runtime.ts:1728-1748`）。section 按 order 升序拼进 system prompt，所以记忆在身份之前。
- 它们都是 `systemPrompt.context`：`dsh-plugin-memory` order -200（`dsh-plugin-memory/lib/index.js:275-285`），`dsh-memory-core` order 500（`dsh-memory-core/index.js:435-449`）。context 在 DSH 里渲染成 user-role runtime snapshot（`@deepseek-ai/dsh-system-prompt/README.md:100`；`@deepseek-ai/dsh-system-prompt/lib/index.js:121-140`），**和 section 是两条通道**；context 的 order 只在 context 之间排序，不能把内容插到 order 9 的 section 前面。
- 频率也不同：我们是每轮读 section 闭包（`text: () => memoryPrompt(...)`，`src/runtime/assistant-runtime.ts:1288-1292`）；`dsh-plugin-memory` 是投影去重，内容不变不重复注入（`dsh-plugin-memory/README.md:206-207`），且受 `activeSessionOnly` 影响，非活跃会话不注入（`dsh-plugin-memory/README.md:110,140`）。`dsh-memory-core` 每次渲染都读文件，但仍是 context 快照，不是 system section。
- 结论：要“每轮、身份之前”，只能自己注册 `systemPrompt.section`（我们已经在做）。接插件会变成第二条 user-role 快照，破坏前缀稳定性和“身份之前”的语义。

### Q4. 群聊记忆（M2）能不能用它们实现？

**不能，必须我们自己做。**

- 两者都没有 team/group 这一级作用域：`dsh-plugin-memory` 是 profile 全局目录；`dsh-memory-core` 是 preset + cwd。它们的“隔离”是目录隔离，不是“哪个群/哪个团队”的权限隔离。
- 它们没有 Leader/member 角色：`dsh-memory-core` 只有“子代理只读”（`dsh-memory-core/index.js:299-301`），`dsh-plugin-memory` 只有文件系统权限。
- 它们没有“成员看不到群记忆”的注入过滤；`dsh-memory-core` 的注入对所有使用该 preset 的会话一致（`dsh-memory-core/lib/render.js:109-124`）。
- 我们已经有 `TeamAggregate.memory`、`teamMemoryPrompt` 和按 `active + team-safe + scope=team` 的过滤（`src/domain/schemas.ts:275-285`；`src/runtime/team-prompts.ts:63-86`）。M2 的实际工作是 UI、Leader 写权限、成员注入范围的收紧，不是换存储。
- 注意：当前 `teamMemoryPrompt` 被放进所有成员的 roster section（`src/runtime/team-runtime.ts:1750-1758`），而 spec 的 M2 验收要求“成员会话看不到群记忆”；这需要改注入条件（只 Leader），不是插件能解决的。以 spec 为准（`docs/superpowers/specs/2026-10-27-memory-gaps.md:20-30`）。

### Q5. 「问/改」（M3）与「自动捕获」（M4）有没有现成能力？质量如何？

**M3：没有现成的「问/改」。**

- `dsh-plugin-memory` 没有注册任何工具（`dsh-plugin-memory/lib/index.js:122`；全包无 `tools.register`）。模型只能按 skill 协议读页面、改页面；没有 `{kind:'answer'|'change'}` 返回结构，也没有 proposed 写入。
- `dsh-memory-core` 有一个 `memory_core` 工具，支持 `list/add/replace/remove/archive`（`dsh-memory-core/index.js:242-265`），但：
  - 默认直写（`dsh-memory-core/lib/defaults.js:14-17`），不是“提议 → 用户采纳”；
  - 没有 revision/乐观锁（`dsh-memory-core/lib/store.js` 没有 revision 字段）；
  - 没有“问”的独立模式；`list` 只是列条目，回答仍靠模型自由发挥。
- 可借的只有工程约束：唯一子串定位、0/多命中失败、归档回滚（`dsh-memory-core/lib/store.js:648-658`；`dsh-memory-core/index.js:406-424`）。这些可以直接体现在我们的 `assistant_memory_entry_write` / `team_memory_propose` 参数校验里，不需要装插件。

**M4：没有自动捕获；只有“提醒”。**

- `dsh-plugin-memory` 的 digest guard 在 idle 且库长时间未写时，通过 `agent.followup()` 发提醒（`dsh-plugin-memory/lib/digest-guard.js:188`）；recall nudge 只在空闲时用 `log.md` 标题做“主动回忆”，明确不写库（`dsh-plugin-memory/lib/recall-nudge.js:1-17`）。两者都不产生候选条目。
- `dsh-memory-core` 的 watchdog 只在连续 N 轮没写 `daily/project` 时在快照末尾加提醒（`dsh-memory-core/lib/render.js:109-124`）；没有模型提取。
- **噪声风险**：`dsh-memory-core` 默认直写 active，只有精确重复会拦（`dsh-memory-core/lib/store.js:605-619`），语义重复/过时事实会直接进长期记忆；`dsh-plugin-memory` 靠 agent 自觉写页面，`lint` 又不做语义矛盾检测（`dsh-plugin-memory/scripts/memory.mjs:194-228`）。如果直接复用，等于把“把噪声写进长期记忆”的风险交给模型自律。
- 我们的 M4 契约要求“只写 proposed、默认关、每轮最多 3 条、UI 明示成本”（`docs/superpowers/specs/2026-10-27-memory-gaps.md:48-56`），这必须建立在我们自己的状态机与写入路径上。

### Q6. 依赖它们要付出什么？两个同时装会不会打架？升级风险？

**额外配置与成本：**

> 下表每列里的 `lib/...` / `README.md` / `package.json` 指该列所述包。

| | `dsh-plugin-memory` | `dsh-memory-core` |
|---|---|---|
| 安装/启用 | `dsh plugin --profile ... add dsh-plugin-memory`；bundle patch 自动挂载；默认 `enabled: true`；需重启（`README.md:20-27,79-87`） | `dsh plugin add dsh-memory-core`；默认只注册管理页；要在 preset 的 `plugins` 里挂载并设 `memoryEnabled: true`；需重启（`README.md:18-49,82-88`） |
| 配置面 | `<dshHome>/memory.json` 热改 10 项 + composition 键（`README.md:100-128`） | preset config + `<preset>/memory-core.config.json` 热读；轨模式/直写开关/看门狗（`README.md:80-93`） |
| 上下文成本 | boot 块默认 12,000 字符（`README.md:105`） | 常驻注入 2,000 字符（`lib/budgets.js`；`README.md:99`） |
| 数据位置 | `~/.memory`（markdown + git） | `~/.dsh-plugin-data/<preset>/memory/`（纯文本） |
| peer/engine | cordis、dsh-skill、dsh-system-prompt、schemastery；DSH v4（`README.md:89-94`） | schemastery；`dsh >=0.2.0-rc.1 <0.3.0-0`（`package.json:45`） |
| 我们的兼容性 | 本仓库 DSH 0.2.1-rc.2，v4 可用；但 peer 是宽范围，升级仍需跟着 DSH 走 | 本仓库在范围内；但上限 `<0.3.0-0`，DSH 升级到 0.3 时要等插件更新 |

**两个同时装会不会打架？**

- **没有硬 ID 冲突**：包名/插件名不同——`dsh-plugin-memory` 的导出名是 `memory`（`dsh-plugin-memory/lib/index.js:111`），bundle id 是 `dsh-memory`（`dsh-plugin-memory/cordis.patch.yml:9-11`）；`dsh-memory-core` 的插件名是 `dsh-memory-core`（`dsh-memory-core/lib/constants.js:3`），bundle id 是 `memory-core`（`dsh-memory-core/cordis.patch.yml:5-7`）。所以不会撞 `duplicate loader entry id`，也不会抢同一个路由前缀。
- **但会双注入**：两者都注册 `systemPrompt.context`，一个默认 12k、一个 2k；同一会话会出现两段“长期记忆”快照，模型看到两套规则，用户看到两个记忆面板。这不是崩溃，是语义打架。
- **能力命名也不冲突**：`dsh-plugin-memory` 注册的是 skill `memory`（`dsh-plugin-memory/lib/index.js:291-300`），`dsh-memory-core` 注册的是 tool `memory_core`（`dsh-memory-core/index.js:242-265,432`）。真正的冲突风险是：`memory` skill 可能覆盖/被项目级 skill 覆盖（`dsh-plugin-memory/README.md:203-204`）；`dsh-memory-core` 需要和 `dsh-memory-shield` 配对来遮蔽其他记忆插件（`dsh-memory-core/README.md:7-14`），我们的 profile 若已有别的记忆插件，会多一层装配复杂度。
- **各自的翻车点**：`dsh-plugin-memory` 手写 insert 会和 bundle 自动挂载撞 `duplicate loader entry id`（`dsh-plugin-memory/README.md:96`）；`dsh-memory-core` 的第二个实例会因 `/api/memory-core` 重复前缀路由让 preset 加载失败（`dsh-memory-core/README.md:31`；`dsh-memory-core/index.js:158-180`）。
- **升级风险**：两者都是第三方插件。`dsh-plugin-memory` 有 v3/v4 session 格式硬切换（0.8.0 及更早不支持 v4；`dsh-plugin-memory/README.md:89-94`）；`dsh-memory-core` 把 DSH 上限锁在 `<0.3.0-0`（`dsh-memory-core/package.json:45`），且没有随包发布自测（`dsh-memory-core/README.md:146-152`）。本仓库没有针对它们的回归测试，升级只能靠它们自己的 self-test/手测。

---

## 5. 推荐方案

### 5.1 总原则

**不把 `dsh-plugin-memory` 或 `dsh-memory-core` 加为依赖；M1–M4 都落在我们自己的 structured memory 上。** 理由按硬阻塞排序：

1. **作用域不匹配**：它们没有 assistant/team 这一级；一个 profile 全局目录、一个 preset+cwd，且 core 进程内单例（`dsh-plugin-memory/lib/index.js:127,245`；`dsh-memory-core/lib/defaults.js:28-33`；`dsh-memory-core/index.js:158-180`）。
2. **状态机不匹配**：没有 `visibility/status/revision/journal`；接入会丢掉我们已有的核心能力（`src/domain/schemas.ts:183-250`）。
3. **注入位置不匹配**：它们是 user-role runtime context，不是 `order: 9` 的 system section；无法做到“每轮、身份之前”（`@deepseek-ai/dsh-system-prompt/README.md:100`；`src/runtime/assistant-runtime.ts:1288-1297`）。
4. **M3/M4 没有现成能力**：一个无工具，一个只有直写工具；自动捕获都只是提醒（`dsh-plugin-memory/lib/index.js:122,291-300`；`dsh-memory-core/index.js:242-265`；`dsh-memory-core/lib/render.js:109-124`）。
5. **成本/风险**：额外 profile/preset 配置、双注入、v4/引擎版本绑定、第三方升级风险；收益只是“少写一点文件读写代码”，不划算。

### 5.2 各项落地方式（可直接执行）

- **M1（自建，最小）**：在助手详情面板的「记忆」区块顶部加 `记忆 · N 条 · 管理 →`。数据源用现有 `assistant.memory.get` 的 `entries.length`；空态显示 `记忆 · 还没有记录`；点击打开设置并展开记忆分组（spec `docs/superpowers/specs/2026-10-27-memory-gaps.md:11-18`）。不需要任何新存储/依赖。
- **M2（自建，数据已有）**：在团队页加「记忆」区块，复用助手记忆条目组件；写入只给 Leader/用户；成员会话是否注入按 spec 收紧为“Leader 才注入”（spec `:20-30`）。现有 `TeamAggregate.memory` 与 `teamMemoryPrompt` 是基础（`src/domain/schemas.ts:275-285`；`src/runtime/team-prompts.ts:63-86`），当前 `src/runtime/team-runtime.ts:1750-1758` 对所有成员注入，需要按 spec 调整。
- **M3（自建）**：一次显式模型调用，返回固定 `{ kind, answer?, entries? }`；`change` 必须走 `assistant_memory_entry_write`（带 `expected_revision`），新增条目写 `proposed`。**前置改动**：当前 assistant 写入 schema 的 status 只有 `active/archived`（`src/domain/schemas.ts:287-301`；`src/runtime/assistant-tools.ts:288-291`），`proposed` 目前是 team-only；要支持 assistant 的 M3，需要把 `proposed` 加入 assistant 可写状态，或把 M3 的“改”设计成 `team_memory_propose` 的团队版本。不要绕过状态机直接写文件。
- **M4（借鉴 + 自建）**：保留 `memoryAutoCapture` 的“只写 proposed、不自动接受、默认关”约束（`src/config.ts:35-40,78`；`src/service/dsh-team-mode-service.ts:2246-2254`；`docs/MEMORY-ARCHITECTURE.md:288-304`），在其上增加“每轮结束最多一次、0–3 条候选”的模型提议：
  - 触发：显式开关 + 一轮结束事件；不做后台轮询；
  - 去重：复用 `memoryDedupeKey`（`src/domain/memory.ts:139-147`），先按 key/规范化文本去重；
  - 脱敏：复用 `redactMemoryText`（`src/domain/memory.ts:101-131`）；
  - 写入：只写 `proposed`，不写 `active`；UI 提供“全部忽略”；
  - 成本：UI 明确“开启后每轮多一次模型调用”，默认关；
  - 借鉴但不照搬：`dsh-plugin-memory` 的 idle/digest 提醒时机（`dsh-plugin-memory/lib/digest-guard.js:188`）、`dsh-memory-core` 的精确重复去重与唯一子串保护（`dsh-memory-core/lib/store.js:605-619,648-658`）。

### 5.3 可以借鉴的具体机制（不装依赖）

| 来源 | 机制 | 用在哪里 | 备注 |
|---|---|---|---|
| `dsh-plugin-memory/lib/boot.js:99-159` | 按文件预算分配、保护 `index.md` 路由表 | 我们未来 core 注入预算变大时 | 当前我们的核心注入是 4k/2k 固定上限（`docs/MEMORY-ARCHITECTURE.md:95-102`），暂不需要 |
| `dsh-plugin-memory/lib/digest-guard.js:188` | idle 后一次性提醒，不每轮骚扰 | M4 的触发时机 | 只借“何时提醒”，不借“直接写页面” |
| `dsh-plugin-memory/lib/recall-nudge.js:1-17` | 主动回忆只用真实 `log.md` 标题，明确不写库 | 未来 M3 的“问” | 防止模型编造记忆 |
| `dsh-memory-core/lib/store.js:605-619` | 规范化后精确重复不写 | M4 去重 | 我们已有 `memoryDedupeKey`，可对齐 |
| `dsh-memory-core/lib/store.js:648-658` | 唯一子串定位，0/多命中失败 | M3 改条目参数校验 | 比“按标题模糊匹配”安全 |
| `dsh-memory-core/index.js:406-424` | 归档两步 + 失败回滚 | 未来归档/恢复 | 我们已有 journal/undo，不需要搬文件 |
| `dsh-memory-core/lib/store.js:276-293` | 固定句式的 prompt-injection 扫描 | 写入前校验 | 可作为 `redactMemoryText` 之外的补充，但不要替代脱敏 |

### 5.4 如果将来仍想评估插件（可选，不影响本批）

- 只在**独立 scratch profile** 安装，不装进本仓库、不改当前 profile；
- 用一次性脚本把 markdown/纯文本导入我们的 `MemoryEntry`：`status: 'proposed'`、`visibility` 默认 `private`、`source: 'user'`，人工确认后才 `active`；
- 不要和我们的记忆注入同时开启，避免一个会话出现两套长期记忆；
- 评估指标只看“导入后人工采纳率 / 噪声条数 / 是否能按团队过滤”，不看“能不能写文件”。

**最终建议：不新增依赖、不做迁移；M1/M2/M3 自建，M4 借鉴提醒与去重机制后自建。**
