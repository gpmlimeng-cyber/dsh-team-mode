# 助手 / Grok Bot 形态竞品调研

> 日期：2026-10-21
> 目的：先确定对标范围，再进入 REA + deepfork 的深拆和落地方案。
> 结论先行：**产品形态对标 Grok Bot，工程与 DSH 落点对标 DS Bot，运行时编排参考 OpenBot，Agent 目录/会话 UX 参考 LibreChat，记忆参考 Letta。**

---

## 1. Grok Bot 的产品基准

Grok Bot 是 xAI 的常驻 Agent 产品，不是普通聊天框。

公开资料描述的核心能力：

- 每个 Bot 运行在独立云电脑上，可操作网站、应用、收件箱和工具。
- 面向多步骤任务，端到端执行；需要审批/决策时回到人类。
- 每个 Bot 保持对话上下文，记住用户偏好和工作流。
- 用户可以“演示一遍”，Bot 观察后保存工作流并重复执行。
- 多个 Bot 可并行，通过共享线程交换上下文、分工。
- 支持把多个 Bot 放进群聊，由 Bot 协调并请求人类输入。

对本项目最关键的三个产品信号：

1. **Bot 是唯一入口**：用户面对一个 Bot，而不是一堆 Session。
2. **Bot 内部有执行体**：任务、云电脑、工具调用都在 Bot 后面。
3. **人类只在决策点介入**：审批、补充信息、验收。

本地已安装 `Grok Bot.app 0.70.2`（`com.anysphere.sand`），后续可用 REA 做行为与协议分析。

来源：

- https://x.ai/news/designing-grok-bot
- https://www.infoq.com/news/2026/08/grok-bot-agent/

---

## 2. 竞品地图

| 项目                        | 类型                        | License                 | Stars（约） | 与 Grok Bot 的关系                                 |
| --------------------------- | --------------------------- | ----------------------- | ----------- | -------------------------------------------------- |
| Grok Bot                    | 商业产品                    | 闭源                    | —           | 产品形态基准                                       |
| DS Bot / DeepSeek-Bot       | DSH Bot 插件                | Apache-2.0              | 2.7k        | 最接近的 DSH 原生竞品                              |
| OpenMausBot                 | 开源 Grok Bot 替代          | Apache-2.0              | 5.3k        | 产品/运行时最接近的开源实现                        |
| OpenBot                     | 自托管 Bot 平台             | MIT                     | 31          | 最接近的运行时/编排参考                            |
| LibreChat                   | Agent 聊天平台              | MIT                     | 46k         | Agent 目录、会话、管理 UX 参考                     |
| Letta                       | Stateful Agent 平台         | Apache-2.0              | 25k         | 长期记忆/状态参考                                  |
| OpenHands Agent Canvas      | Agent 控制中心              | MIT                     | 91k         | 任务/自动化/多后端参考                             |
| CrewAI                      | 多 Agent 框架               | MIT                     | 60k         | 角色编排参考                                       |
| AutoGen                     | 多 Agent 框架               | CC-BY-4.0（仓库元数据） | 61k         | 对话式多 Agent 参考；不建议直接重建                |
| grok-bot-0.18-reconstructed | Grok Bot 非官方重构         | 无 License              | 42          | 只能做理解，不可重建                               |
| grokbot-shim                | Grok Bot 本地宿主/协议 shim | ISC                     | 27          | 协议、Computer、桌面接管参考                       |
| GrokBot Guide               | Grok Bot 中文实践指南       | MIT                     | 3           | 用户语言、Bot 模板、场景、工作台用法参考；不含实现 |

---

## 3. 重点竞品拆解

### 3.1 DS Bot（最直接竞品）

**是什么**：DeepSeek Harness 的 Bot 插件，把 DSH 改造成 Bot 产品。

已公开能力：

- **Bot**：一个 Bot 一个窗口完成对话和工作；Bot 有记忆；详情页可切换模型、管理记忆、看用量。
- **Main Bot（Chief）**：默认主 Bot，高权限，管理其他 Bot 和群聊。
- **群聊**：每个群有管理员；默认管理员回答，可 @ 指定 Bot；Bot 之间可用 @ 交接；群有独立记忆；可引用其他聊天作为上下文。
- **Capabilities**：MCP、Skill、Prompt 的共享能力库。
- **桌面应用**：自带 DSH，可独立安装；也支持 DSH 插件/Docker。

源码层面已确认（读公开源码片段）：

- `store.js`：`state.json` 保存 bots / rooms / agents / exchanges 等；Session 到 Bot/群聊的索引。
- `chat-index.js`：SQLite FTS5 索引 Bot 自己的聊天，支持搜索/最近/上下文读取。
- `resume.js`：DSH 重启后恢复未完成 turn 和未投递消息。
- `groups.js`：群聊轮次、@mention、交接、群工具。
- `agents.js`：一个普通 DSH Agent 入口，与 Bot/群聊 Session 区分。

**对我们的价值**：它已经验证了 DSH 上“Bot + 群聊 + 记忆 + 能力”的产品可行性；我们不需要从零证明 DSH 能承载 Bot。

**差异/机会**：

- DS Bot 的 Bot 更偏“一个 Bot 一个窗口/上下文”，没有 Grok Bot 式“Bot 内部按任务开隐藏 worker Session”的公开形态。
- 我们可以做：**Bot 常驻 DM + 内部任务 worker + 任务卡 + 自动路由**，同时保持 DS Bot 式的单入口。
- 还要处理与 DS Bot 的共存/竞争：同一 DSH 里两套 Bot 插件会争侧栏与工具命名空间。

来源：https://github.com/Fei2411/DeepSeek-Bot

### 3.2 OpenMausBot（最接近的开源 Grok Bot 替代）

**是什么**：Apache-2.0、TypeScript/Electron/React 的开源 Grok Bot 替代。定位就是“聊天应用里的一队 AI Bot”，本机已安装 `OpenMausBot.app 0.1.108`。

核心形态与 Grok Bot 高度一致：

- 侧栏每个 Bot 是一个真实 Agent（Claude / Codex / Grok CLI），有自己的性格、模型、云电脑、连接应用。
- 像联系人一样聊天；Bot 在后台工作，审批/提问以卡片回到聊天。
- 每个 Bot 有独立 thread、长期记忆、工作目录、模型和 Computer。
- Channels：Work / Personal / 项目分频道，各自有 transcript、共享指令、工作目录、响应规则、Bot 名单。
- Rooms/群聊：多个 Bot 在同一房间协作，可 @ 指定 Bot；未 @ 的消息由 **Decision model（Jev）** 在几百毫秒内选出合适 Bot，失败回退到 room lead。
- 审批：shell、文件编辑、问题都以 inline card 出现，Allow / Deny / 回答。
- 连接应用：Composio 市场，OAuth 一次，多个 Bot 共用。
- 团队/预设可打包为 Markdown 分享导入；有 MCP server 供外部编排。

工程架构（公开文档）：

```text
React/Electron App
   │ HTTP commands + 单条 SSE 事件流
   ▼
Harness server (127.0.0.1:8799)
   ├─ Driver registry: Claude / Codex / Grok CLI
   ├─ Permission broker
   ├─ 持久 thread / NDJSON 事件日志
   ├─ Cloud Computer (Boat) / 本地 Computer
   └─ Composio connectors
```

更关键的是它有一套 **job runtime contract**：

- 每个“一个 Bot 交给另一个 Bot 的工作”都是一条 `Assignment` 记录。
- `rootId/parentId/depth` 形成工作树；`origin` 记录来源（人/例程/外部）。
- `mode`: `work` / `consult` / `notify`。
- `reply`: `resume` / `poll` / `none`。
- 有 status/outcome、executions/restarts、result/evidence、重启恢复。
- 所有唤醒、交接、例程、webhook 统一到一条生命周期，不再各自维护时钟和状态。

记忆：每个 Bot 一个私有 workspace，`MEMORY.md` 每轮加载，`memory/<topic>.md` 按需读取，daily log 记录当天工作；支持查看/编辑/撤销，自动脱敏凭证。

**对我们的价值**：这是产品形态 + 运行时契约 + Bot 目录 UX 的最完整开源参考，而且许可证允许 deepfork。它验证了：

1. “Bot 是联系人，不是会话列表”的 UI 可行。
2. 每个 Bot 拥有独立 thread、记忆、Computer、工具。
3. 把“交给另一个 Bot 的工作”统一成 Assignment 树，是避免多套唤醒/交接逻辑的关键。
4. 决策模型只做“选谁”，不做实际工作；失败回退固定 lead。

**差异**：它是独立 Electron 应用，直接驱动 Claude/Codex/Grok CLI；我们是 DSH 插件，必须落到 DSH Session/Agent 上。可借产品模型和 runtime contract，不能直接搬 driver/computer 层。

来源：https://github.com/milind-soni/OpenMausBot

### 3.3 OpenBot（最接近的运行时参考）

**是什么**：自托管、多 Bot、持久化 Actor 平台。

核心设计：

- Bot、人、外部系统都是 **actor**，各有持久 inbox。
- 通过共享 thread 投递消息；Bot 收到 mail 后唤醒，跑 LLM agent loop + tools + memory。
- Bot 之间用 `@mention` 交接，带 hop limit 防止循环。
- 每个 Bot 有 LangMem 长期记忆，运行后自动反思。
- 工具有 shell/file/HTTP、插件、MCP；支持审批和提问。
- React UI：Inbox / Threads / Bots / Settings，SSE 实时更新。
- SQLite/Postgres；桌面应用。

**对我们的价值**：

- “Bot 是 actor + inbox + thread”这套模型，正好可以映射到 DSH Session + 消息注入。
- 交接、并发上限、审批暂停、长期记忆，都是我们要补的运行时能力。
- 它的 Threads UI 也说明：用户需要看到“任务线程”，但不必看到每个内部 Session。

来源：https://github.com/regnull/openbot

### 3.4 LibreChat（Agent 目录与聊天 UX 参考）

**是什么**：开源 AI 聊天平台，带 Agents（Agent 管理 API、文件、Skills、工作区、后台工具、子 Agent）。

可借鉴：

- Agent 列表 + 单个 Agent 的会话管理。
- Agent 管理 API（创建/发现/更新/删除）。
- 后台工具与 Subagent 分离。
- 统一工具活动、推理、搜索、Agent 工作流 UI。
- 附件、上下文用量、手动压缩。

**差异**：LibreChat 仍是“会话列表”模型，不是 Grok Bot 的“一个 Bot 一个 DM”。但它的 Agent 详情/管理/会话切换 UX 很适合做助手详情页。

来源：https://github.com/LibreChat-AI/LibreChat

### 3.5 Letta（长期记忆参考）

**是什么**：Stateful Agent 平台（前 MemGPT），强调记忆、身份、跨设备持续。

可借鉴：

- 分层记忆（core/archival/recall）与自我编辑。
- Agent 身份与对话历史分离。
- 跨渠道（Slack/Telegram/Discord）保持同一 Agent。

**对我们的价值**：Bot 常驻 DM 需要长期记忆，Letta 是最成熟的记忆架构参考；但不需要引入它的运行时。

来源：https://github.com/letta-ai/letta

### 3.6 OpenHands Agent Canvas（任务/自动化参考）

**是什么**：自托管 Agent 控制中心，运行 OpenHands/Claude Code/Codex 等，支持多后端、自动化、任务分解。

可借鉴：

- 任务/自动化作为一等对象。
- 多后端（本地/远程/云）切换。
- 运行历史与任务状态 UI。
- “常驻工程团队”的产品叙事。

来源：https://github.com/OpenHands/OpenHands

### 3.7 CrewAI / AutoGen（编排模式参考）

- CrewAI：角色、任务、流程（sequential/hierarchical）编排；适合看“任务分配/角色协作”抽象。
- AutoGen：对话式多 Agent、群聊、handoff；适合看“多 Agent 消息循环”。

两者都是框架，不是 Bot 产品；不建议作为 UI/产品对标，只作为编排概念参考。

来源：

- https://github.com/crewAIInc/crewAI
- https://github.com/microsoft/autogen

### 3.8 GrokBot Guide（中文实践指南）

**是什么**：MIT 许可的 Grok Bot 中文教程站，仓库是 VuePress 文档与模板数据，不是 Grok Bot 实现。内容覆盖：

- 30 分钟入门、7 天路径、按角色路径
- 六类 Bot 模板（选题、工程、例程、审批、研究、对账）
- 场景库：邮件、审批门、云 Agent PR、CSV 对账、情报摘要、Notion 摘要、配额监控
- 工作台：channels、cloud agents、connectors、memory、multi-bot、routines、skills、security、settings

**用途**：校准中文产品语言、模板/场景分类、routines 与审批的真实用户预期。  
**边界**：教程中的产品描述只能作为行为参考，不能替代对 Grok Bot 本体的 REA/黑盒验证；代码与资产不进入我们的仓库。

来源：https://github.com/anightmonarch/grokbot-guide

### 3.9 Grok Bot 非官方项目

- `xianyu110/grok-bot-0.18-reconstructed`：非官方重构，**无 License**。只能做行为理解，不能进入重建。
- `codeaashu/grokbot-shim`：ISC。把 Grok Bot UI 接到本地 host/runtime，支持本地 Computer、模型代理、noVNC 接管。适合看宿主协议、Computer 沙箱、桌面接管，不适合直接做产品。

来源：

- https://github.com/xianyu110/grok-bot-0.18-reconstructed
- https://github.com/codeaashu/grokbot-shim

---

## 4. 与我们的目标对照

我们的目标形态：

```text
助手行（单聊入口）
  └─ Bot 常驻 DM（唯一可见会话）
        ├─ worker session A（内部任务）
        ├─ worker session B
        └─ worker session C
```

| 能力              | Grok Bot    | DS Bot   | OpenBot      | LibreChat  | 我们的落点        |
| ----------------- | ----------- | -------- | ------------ | ---------- | ----------------- |
| 一个 Bot 一个入口 | 是          | 是       | 偏 thread    | 偏会话列表 | 侧栏助手行        |
| Bot 常驻 DM       | 是          | 是       | thread       | 是         | 原生 Session      |
| 内部任务 worker   | 云电脑/任务 | 未公开   | actor/thread | Subagent   | 隐藏 task Session |
| Bot 自主路由      | 是          | 部分     | @handoff     | Agent 工具 | 编排工具 + 规则   |
| 长期记忆          | 是          | 是       | LangMem      | 有         | 后续接            |
| 多 Bot 群聊       | 是          | 是       | 是           | 多 Agent   | 团队模式已有      |
| 审批/人工介入     | 是          | 有       | 有           | 有         | 原生审批          |
| 任务状态 UI       | 是          | 群聊动态 | Threads      | 工具活动   | Bot DM 任务卡     |

**结论**：

- 产品形态：Grok Bot 是基准，**OpenMausBot 是最接近的开源实现**，DS Bot 是最接近的 DSH 原生实现。
- 运行时：OpenBot 的 actor/inbox/thread 模型最适合映射到 DSH Session。
- UX：LibreChat 的 Agent 管理/详情最值得抄结构，不抄视觉。
- 记忆：Letta 做后续增强参考，不进首版。

---

## 5. 建议的对标范围（供你敲定）

### 方案 A：产品形态组（推荐）

- **Grok Bot**：REA 分析本地 `Grok Bot.app 0.70.2`，看 Bot/DM/任务/审批/记忆/Computer 的真实交互。
- **OpenMausBot**：deepfork（Apache-2.0），重点看 Bot roster、thread、channels/rooms、Assignment runtime、Decision model、审批卡片。
- **DS Bot**：deepfork（Apache-2.0），重点看 DSH 上的 Bot→Session 映射、群聊、记忆、重启恢复。
- **LibreChat**（可选，只拆 Agent 目录/详情/会话管理子系统）。
- **GrokBot Guide**（MIT，中文实践指南）：校准用户语言、Bot 模板、场景库、routines / channels / memory / approval 的真实使用方式；只作产品与文案参考，不作代码或内核依据。

产出：产品形态 + 运行时契约 + DSH 落点的完整方案。

估算：REA 1 天 + deepfork 2–3 天 + 方案 1 天，约 **4–5 天**。

### 方案 B：运行时/编排组

- OpenMausBot + OpenBot + Letta + OpenHands。
- 重点：worker/assignment 生命周期、任务状态、记忆、自动化。
- 弱化 Grok Bot UI 和 DS Bot 的 DSH 适配。

估算：**2–3 天**。

### 方案 C：最小对标

- OpenMausBot + DS Bot。
- 只回答“Grok Bot 形态如何在 DSH 上落地”，最快。
- 估算：**2–3 天**。

## 6. 确定范围后 REA + deepfork 的分工

| 目标                | 工具                                 | 产出                                                                         |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| Grok Bot 0.70.2     | REA（asar/JS 应用图、协议、UI 结构） | Bot 入口、DM、任务/审批、Computer 行为模型                                   |
| OpenMausBot 0.1.108 | deepfork（Apache-2.0）+ 可选 REA     | Bot roster、thread、channels/rooms、Assignment runtime、Decision model、审批 |
| DS Bot              | deepfork（Apache-2.0）               | Bot→Session 映射、群聊、记忆、恢复、UI 槽位                                  |
| OpenBot             | deepfork（MIT）                      | actor/inbox/thread、handoff、并发、审批、记忆                                |
| LibreChat           | deepfork 子系统（MIT）               | Agent 目录、详情、会话管理、Subagent/后台工具                                |
| Letta               | deepfork（Apache-2.0，可选）         | 长期记忆分层与自我编辑                                                       |

License gate：

- 可重建：OpenMausBot、DS Bot、OpenBot、LibreChat、Letta、OpenHands、CrewAI、grokbot-shim。
- 仅理解：Grok Bot（闭源）、grok-bot reconstructed（无 License）。
- AutoGen 仓库元数据为 CC-BY-4.0，建议只做概念参考，不进入重建。

---

## 7. 需要你敲定的三件事

1. 对标范围选 A / B / C，或自定义组合。
2. 首版是否只做“Bot 常驻 DM + 隐藏 worker”，不做多 Bot 群聊（团队模式已覆盖群聊）。
3. 是否允许与 DS Bot 共存；如果共存，侧栏/工具命名空间如何分治。

---

## 8. 参考链接

- Grok Bot 设计文章：https://x.ai/news/designing-grok-bot
- Grok Bot 发布报道：https://www.infoq.com/news/2026/08/grok-bot-agent/
- DS Bot：https://github.com/Fei2411/DeepSeek-Bot
- OpenMausBot：https://github.com/milind-soni/OpenMausBot
- OpenBot：https://github.com/regnull/openbot
- LibreChat：https://github.com/LibreChat-AI/LibreChat
- Letta：https://github.com/letta-ai/letta
- OpenHands：https://github.com/OpenHands/OpenHands
- CrewAI：https://github.com/crewAIInc/crewAI
- AutoGen：https://github.com/microsoft/autogen
- Grok Bot 非官方重构：https://github.com/xianyu110/grok-bot-0.18-reconstructed
- grokbot-shim：https://github.com/codeaashu/grokbot-shim
