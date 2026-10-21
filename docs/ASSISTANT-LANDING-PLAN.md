# DSH 助手模式落地方案

> 对标：OpenMausBot + DS Bot；约束：不改造 DSH 原生会话/组件，只做增强。  
> 三种形态：项目任务（现状）、单聊助手（新增）、群聊助手（现有 Team Mode 迭代）。

---

## 0. 一句话方案

**不新造聊天界面**：助手 = DSH 原生 Session 上的产品层。  
一个助手 = 一个可见的“主会话”（Grok Bot 式 DM）+ 若干隐藏的任务 Session；主会话负责与人对话和调度，任务 Session 负责执行；Sidebar 只多一行助手入口。

---

## 1. 设计原则

1. **原生优先**：会话主界面、输入框、审批、工具卡、模型选择全部复用 DSH。
2. **只做增量**：Sidebar 增加助手行；会话隐藏用现有 hider；不 shadow `conversation.view`。
3. **一个助手一个入口**：用户只看到助手行和主会话；任务 Session 默认不可见。
4. **任务隔离**：后台一任务一 Session，独立上下文；主会话只收结构化结果。
5. **单写者**：助手状态存插件 storage；多 Host 时只读，避免抢写。
6. **可降级**：路由失败 → 主会话直接回答/追问；隐藏失败 → 详情可打开；原生升级 → 功能退化但不破坏 DSH。
7. **命名隔离**：工具统一 `assistant_*`，存储 `assistant-*`，避免与 Team Mode / 原生 Agent Teams / DS Bot 冲突。

---

## 2. 三种形态的边界

| 形态 | 入口 | 执行单元 | 是否新增 UI |
| --- | --- | --- | --- |
| 项目任务（现状） | 工作区 → 会话 | 一个 DSH Session | 不改 |
| 单聊助手 | Sidebar 助手行 | 主会话 + 隐藏任务 Session | 只加助手行 |
| 群聊助手 | Sidebar 团队行 | 现有 Team Mode 成员 Session | 沿用/迭代 |

本方案只新增“单聊助手”，不动项目任务，不改群聊。

---

## 3. 架构

```text
Sidebar
├─ 团队行（群聊） ─────────────► 现有 Team Mode
└─ 助手行（头像/单聊）
      │ click
      ▼
  主会话（可见，原生 conversation）
      │ assistant_* tools
      ├─ task session A（隐藏）
      ├─ task session B（隐藏）
      └─ task session C（隐藏）
```

### 3.1 进程/模块

```text
Host (Cordis plugin)
├─ AssistantService       模板、实例、CRUD
├─ AssistantSessionStore  bot ↔ session 映射、assignment 状态
├─ AssistantRuntime       ensure/resume orchestrator、create worker、deliver
├─ AssistantTools         assistant_task_* / assistant_worker_*
└─ AssistantChannel       /dsh-assistant/api + SSE

Client
├─ AssistantSidebarRows   与团队行同列表
├─ AssistantSessionHider  隐藏主会话/任务 Session 的原生行
└─ AssistantOpen          ensure + openSession（原生 UI）
```

### 3.2 不做什么

- 不做自定义 chat view / 消息气泡 / 输入框。
- 不替换 `conversation.chat.flow`。
- 不复制 OpenMausBot 的 Electron、driver、computer、connectors、voice。
- 不在首版做多助手群聊改造。

---

## 4. 数据模型

```text
assistant_instances
  id, template_id, name, avatar, provider, model, reasoning,
  preset_id, permission_preset_id, status,
  main_session_id, created_at, updated_at

assistant_sessions
  id, assistant_id, session_id, role,          -- main | task | consult
  title, status, parent_session_id,
  assignment_id?, task_id?, hidden,
  last_active_at, created_at
```

- `main` 每个助手唯一；`task` 可多个；`consult` 可选（一次性问答）。
- 任务 Session 创建后必须 `sessions.flush`，保证原生目录可见。
- 删除助手：归档 Session，不物理删除日志。

---

## 5. 运行时

### 5.1 主会话懒创建

点击助手行：

1. 查 `assistant_instances.main_session_id`。
2. 有 → `agents.resume`；无 → `agents.create`。
3. `workspace.attachSession`。
4. `sessions.flush`。
5. 客户端 `sessions.refresh()` 后 `retain/openSession`（复用团队模式修复）。
6. Hider 隐藏该 Session 原生行。

### 5.2 任务 Session

主会话通过工具创建：

- `assistant_task_create({ title, brief, mode })`
  - 生成 sessionId；
  - `agents.create`，继承助手 snapshot/preset/permission/workspace；
  - 写入 `assistant_sessions`；
  - 投递 brief；
  - 返回 task 卡片信息。
- `assistant_task_send({ taskId, message })`
- `assistant_task_list()`
- `assistant_task_wait({ taskId, timeoutMs })`
- `assistant_task_summary({ taskId })`
- `assistant_task_cancel({ taskId })`

### 5.3 Assignment 最小生命周期

采用 OpenMausBot 的“一条记录、一个生命周期、一个唤醒通道”，但只做最小字段：

```text
Assignment
  id, rootId, parentId, depth
  requester { botId, mainSessionId }
  assignee  { taskId, sessionId }
  mode      work | consult | notify
  reply     resume | poll | none
  status    queued | running | needs_input | waiting | completed | failed | cancelled
  brief, result, error
  createdAt, startedAt, finishedAt
```

- 子任务完成 → 写回 Assignment → 主会话收到一条“任务完成”事件（tool result 或系统消息）。
- 不把子会话完整 transcript 塞回主会话；只回传摘要/结果/证据。
- 重启时：running → 检查 Session 状态；丢失 → failed/resume。

### 5.4 路由

默认永远进主会话；由主会话决定：

1. 明确“新任务” → `assistant_task_create`。
2. 明确“继续/上次 X” → 匹配 task title/summary → `assistant_task_send`。
3. 简单问答/计划 → 主会话直接回答。
4. 低置信度 → 主会话追问；“新任务还是继续 X？”

禁止静默切换用户当前会话；用户看到的始终是主会话。

---

## 6. UI

### 6.1 Sidebar 行

与团队行同一个 section：

```text
团队
  👥 软件研发团队      群聊   2小时   …
  🧑‍💻 论文助手         单聊   刚刚    …
  🧑‍💻 数据助手         单聊   1天     …
```

- 助手行：头像、名称、`单聊`、相对时间、更多。
- 团队行：用户组图标、名称、`群聊`、时间、三图标。
- 点击助手：ensure + open 主会话。
- 助手行 hover：pin / 更多；不显示归档（首版）。
- 任务 Session 不出现在 Sidebar。

### 6.2 原生会话

- 主会话就是普通 DSH Session；标题用助手名。
- 不新增 tab；单聊助手不显示团队页签。
- 任务卡通过原生 tool call/card 或一条简洁 assistant 消息呈现：
  - 已开始：任务名
  - 进行中：N 个
  - 完成：摘要 + 打开任务（可选详情）
- 详情页（后续）可列任务 Session；首版不做切换器。

### 6.3 隐藏

复用 `TeamSessionHider` 思路：

- 拉取 `assistant.list` 得到 main + task session ids；
- 隐藏 `[data-row-key^="session:"]` 对应行；
- MutationObserver 重新应用；
- 助手详情打开时临时允许显示（可选）。

---

## 7. 从 OpenMausBot / DS Bot 各取什么

### OpenMausBot

- Bot = 联系人；任务 = bot 下的 thread（可展开但默认收起）。
- Assignment 一条记录 + 一个 wake lane + restart reconciliation。
- Decision model 只选 responder，失败回退 lead。
- Memory：MEMORY.md + topic files + daily log；预算/redaction。
- Approval level 在 enqueue 时计算。
- 房间/频道是后续群聊助手参考。

### DS Bot

- 一个 Bot 一个 root Session，状态/index 外置 JSON。
- `segments/parts` 解决上下文重置，不换 Bot 身份。
- Host lock / read-only fallback。
- Room admin + @mention + hidden member sessions。
- 重启 resume、delivery/turn/waiter 分层。
- Client 通过 slots 增强，可撤回原生 UI。

### 我们的差异

- 不替换 Sidebar/Conversation，只加助手行 + hider。
- 不驱动 CLI，执行单元是 DSH Session/Agent。
- 不做 Computer/Connectors/Voice。
- 群聊复用 Team Mode，不在首版合并。

---

## 8. 分阶段

### Phase 0：助手入口 + 主会话（2–3 天）

- assistant instance CRUD（复用 assistant template）。
- Sidebar 助手行（头像/名称/单聊/时间）。
- 点击懒创建/恢复主会话，flush + client refresh + open。
- Hider 隐藏主会话行。
- 验收：重启后回到同一助手/主会话；原生会话完全不变。

### Phase 1：隐藏任务 Session（4–6 天）

- `assistant_sessions` 表 + Assignment 最小状态。
- `assistant_task_create/send/list/wait/summary` 工具。
- 任务 Session 创建/隐藏/完成回收。
- 主会话任务卡（原生 tool card）。
- 验收：3 个任务并发；Sidebar 只见助手行；结果摘要回主会话。

### Phase 2：路由/记忆/审批（5–8 天）

- 主会话自动选择继续/新建/直接回答。
- 低置信度追问。
- Memory 最小版（MEMORY.md，后续 topic）。
- 审批继承助手 permission preset；任务级覆盖。
- 验收：30 条对话路由准确率 ≥85%，失败有回退。

### Phase 3：群聊助手与产品化（3–5 天）

- 群聊助手继续用 Team Mode；共享 assistant template。
- 任务详情/Session 切换器（可选）。
- 打包、文档、回归、升级兼容。

---

## 9. 测试清单

- [ ] 点击助手创建主会话；原生 Sidebar 不出现该 Session。
- [ ] 重启后同一助手打开同一主会话。
- [ ] 主会话发消息走原生 DSH UI/审批/工具。
- [ ] 创建 3 个任务 Session；均隐藏；任务独立上下文。
- [ ] 任务完成后主会话收到摘要；无串话。
- [ ] 任务失败/取消/重启恢复。
- [ ] 用户说“继续 X”命中正确任务；“新任务”创建新 Session。
- [ ] 多 Host 只读；不抢写。
- [ ] 与 Team Mode / 原生 Agent Teams 工具不冲突。
- [ ] DSH 升级后 hider/slots 失效时功能降级但不破坏原生。

---

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Session 目录未刷新 | create 后 flush + client refresh + retain 重试 |
| 隐藏行失败 | MutationObserver 重试；详情页兜底 |
| 多 Host 抢写 | 插件 storage 锁/单写者；只读提示 |
| 路由误判 | 确定性规则优先；低置信度追问；审计 |
| 上下文膨胀 | 子会话只回摘要/证据 |
| 工具冲突 | `assistant_*` 命名空间；启动检测 |
| 原生升级 | slots/hider 契约测试；失败降级 |
| 与 DS Bot 共存 | 独立 storage/工具/侧栏 section；文档标注互斥 |

---

## 11. 验收定义

Phase 0 完成的标准：

1. 助手行出现，头像/名称正确。
2. 点击打开原生会话；无自定义聊天 UI。
3. 主会话行从原生 Sidebar 消失。
4. 重启后仍进入同一主会话。
5. 不影响现有 Team Mode / 项目任务 / 原生会话。
