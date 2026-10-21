# 助手模式落地可行性研究

> 范围：在现有团队分组下加入「助手」入口，复用 DSH 原生会话主界面，一个助手对多个 Session，由助手编排层决定继续旧 Session 还是新建。
>
> 结论：**技术可行，中等风险，建议分阶段落地**。核心不是重写聊天 UI，而是做「助手目录 + 常驻编排 Session + 后台任务 Session + 路由/编排层」。

---

## 1. 结论摘要

- DSH 已具备创建、恢复、持久化、打开 Session 的完整能力；插件不需要自建聊天界面。
- 助手应建模为：**一个常驻编排 Session（人类默认入口）+ N 个后台任务 Session**。
- 人类点击助手只打开编排 Session；任务 Session 默认不出现在原生侧栏，由助手在后台创建和调度。
- 「智能判断继续还是新建」应做成**可审计的编排工具调用**，而不是纯模型隐式切换；必须有确定性兜底。
- 最大风险不在 Session API，而在：原生 Session 目录同步、子 Session 隐藏、路由准确性、DSH 升级后的 DOM/契约变化。

---

## 2. 目标与非目标

### 目标

1. 团队分组下同时展示团队行和助手行。
2. 团队行 = 群聊；助手行 = 单聊，图标使用助手头像。
3. 点击助手进入该助手的默认会话，使用原生会话主界面。
4. 一个助手可关联多个 Session ID。
5. 默认进入常驻编排 Session；助手可判断继续当前任务、切换已有任务 Session，或新建任务 Session。
6. 任务后台一个任务一个 Session；人类对话默认不直接暴露所有子 Session。
7. 重启、切页、刷新后映射和入口保持稳定。

### 非目标（首版）

- 不替换 DSH 原生会话主界面。
- 不重写消息气泡、输入框、工具卡片。
- 不做多助手互相群聊（团队模式已覆盖）。
- 不在首版做跨设备/跨 Host 的分布式调度。

---

## 3. 现有能力核查

| 能力 | 现有实现/证据 | 可行性 |
| --- | --- | --- |
| 创建 Agent Session | `ctx.agents.create({ sessionId, meta, agentOptions, setup })` | 已验证 |
| 恢复已有 Session | `ctx.agents.resume({ resumeSessionId, ... })` | 已验证 |
| 绑定工作区 | `workspace.attachSession(sessionId)` | 已验证 |
| 立即持久化空 Session | `ctx.sessions.flush(agent.session)` | 已验证 |
| 客户端保留/打开 Session | `sessions.retain` + `uiWorkspace.openSession` | 已验证 |
| 新 Session 目录同步 | `sessions.refresh()` 后重试 retain | 团队模式已修复 |
| 隐藏指定 Session 行 | `TeamSessionHider` 监听 `[data-row-key^="session:"]` | 已验证 |
| 助手模板 | `assistantTemplateSchema`：名称、描述、头像、模型、Preset、权限、Skill、MCP | 已具备 |
| 助手头像 | 内置 AionUI 20 个头像 + DiceBear + 上传 | 已具备 |
| 原生团队工具冲突 | 已把插件任务工具改名为 `team_mode_task_*` | 已处理 |

**判断：Session 生命周期和原生 UI 入口都具备，不需要新的底层能力。**

---

## 4. 推荐架构

```text
Sidebar
├─ 团队行（群聊） ──────────────► 团队页 / 并行 / 看板
└─ 助手行（单聊，头像）
      │ 点击
      ▼
   常驻编排 Session（原生会话主界面）
      │ 编排工具
      ├─ 任务 Session A（后台，独立上下文）
      ├─ 任务 Session B
      └─ 任务 Session C
```

### 4.1 组成

1. **AssistantDirectory**
   - 侧栏助手行：头像、名称、`单聊` 标识、状态、时间。
   - 点击只负责定位/创建编排 Session 并打开。

2. **AssistantSessionRegistry**
   - 持久化 `assistantId → sessions[]` 映射。
   - 记录角色、标题、状态、父 Session、最后活跃时间。

3. **AssistantOrchestratorRuntime**
   - 懒创建/恢复编排 Session。
   - 负责创建子 Session、发送任务、等待结果、汇总回编排会话。
   - 单 Host 所有权租约，避免多 Host 冲突。

4. **编排工具**
   - `assistant_task_list`：列出该助手的任务 Session。
   - `assistant_task_create`：新建任务 Session 并发送 brief。
   - `assistant_task_send`：向指定任务 Session 追加消息。
   - `assistant_task_wait`：等待/读取任务结果。
   - `assistant_task_summary`：把子会话结果压缩回编排会话。

5. **SessionHider / Opener**
   - 隐藏编排 Session 和任务 Session 的原生侧栏行。
   - 助手详情页提供 Session 切换器，允许人工打开任意任务会话。

---

## 5. Session 模型

### 5.1 角色

| 角色 | 数量 | 是否人类默认入口 | 说明 |
| --- | --- | --- | --- |
| `orchestrator` | 每助手 1 个 | 是 | 常驻，保存人类对话、计划、任务摘要 |
| `task` | 每任务 1 个 | 否 | 独立上下文，执行具体交付 |
| `ephemeral`（可选） | 临时 | 否 | 一次性分析，完成后归档 |

### 5.2 数据表建议

```text
assistant_instances
  id, template_id, name, avatar, provider, model,
  preset_id, permission_preset_id, status,
  orchestrator_session_id, created_at, updated_at

assistant_sessions
  id, assistant_id, session_id, role,
  title, status, parent_session_id,
  task_id?, last_active_at, created_at
```

- 复用现有 storage 的 versioned tables，新增一张 `assistant_sessions`。
- Session ID 必须 `flush` 后才可被原生目录发现。
- 删除助手时归档 Session，不物理删除日志。

### 5.3 懒创建

- 创建助手时不立即建 Session。
- 第一次点击助手时：
  1. 查映射；
  2. 有 orchestrator → `resume`；
  3. 无 → `create` + `attachSession` + `flush`；
  4. 客户端 `sessions.refresh()` 后 `retain/openSession`。
- 好处：避免大量空闲 Session，降低目录噪音。

---

## 6. 路由与编排策略

### 6.1 三层决策

1. **确定性规则（优先）**
   - 用户明确说「新任务 / 重新做 / 另起一个」→ 新建任务 Session。
   - 用户说「继续 / 上次 / 那个登录页」→ 匹配已有任务标题/摘要。
   - 用户明确指定任务 ID/名称 → 直接路由。
2. **编排模型判断**
   - 编排 Session 收到消息后，带「当前任务列表（标题、状态、最近摘要）」调用 `assistant_task_create / send / summary`。
   - 模型只做选择，不直接静默切换人类视图。
3. **兜底**
   - 置信度低 → 在编排会话里追问一句「新建任务还是继续 X？」。
   - 永远保留「在编排会话直接回答」选项。

### 6.2 人类看到什么

- 人类始终停留在编排 Session。
- 子任务执行时，编排会话插入一条**任务卡/工具结果**：
  - 已创建任务「登录页重构」
  - 已交给任务 Session，完成后汇总
- 子 Session 的完整对话不直接灌入编排上下文，只回传结构化摘要，控制上下文成本。
- 需要看细节时，从助手详情/Session 切换器打开子 Session。

### 6.3 为什么不让模型直接切换主视图

- 会打断人类当前阅读位置。
- 多任务并发时无法表达“后台运行”。
- 出问题无法审计。
- 保持“一个助手一个入口”的产品语义。

---

## 7. UI 方案

### 7.1 侧栏统一列表

```text
团队
  👥 软件研发团队        群聊   2小时   …
  🧑‍💻 论文助手           单聊   刚刚    …
  🧑‍💻 数据分析助手       单聊   1天     …
```

- 团队行：用户组图标，右侧置顶/归档/更多。
- 助手行：助手头像，右侧置顶/更多；不显示团队成员。
- 两者共用 hover、时间、选中态、行高。
- 助手行副标题可显示 `编排中` / `N 个任务`。

### 7.2 助手详情

- 打开助手后进入原生会话主界面。
- 头部可加一个轻量 Session 切换器：
  - 编排会话（默认）
  - 任务会话列表（标题、状态、最后活跃）
  - 新建任务
- 不新造聊天 UI；切换器只调用 `openSession`。

### 7.3 隐藏策略

- 编排 Session 和任务 Session 从原生侧栏隐藏。
- 助手行是唯一入口。
- 任务 Session 仍可通过切换器/通知打开。

---

## 8. 生命周期与异常

| 场景 | 处理 |
| --- | --- |
| 首次点击助手 | 懒创建 orchestrator，flush，refresh，open |
| 重启 | 按映射 resume；缺失则重建 orchestrator |
| 任务完成 | 子 Session 保持；编排会话写摘要；状态置 completed |
| 任务失败 | 回传错误摘要；不自动删除 Session |
| 助手删除 | 归档 orchestrator + 子 Session；解除映射 |
| 多 Host | 单所有者租约；非所有者只读/提示 |
| Session 目录未刷新 | retain 失败 → `sessions.refresh()` 重试（已验证） |
| 原生 UI 重渲染 | 侧栏隐藏器 MutationObserver 重新应用 |

---

## 9. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| Session 目录不同步 | 中 | 创建后 flush + refresh + retain 重试 |
| 子 Session 在侧栏泄漏 | 中 | 复用 hider；映射变更时重算隐藏集合 |
| 路由误判 | 高 | 确定性规则优先；低置信度追问；审计日志 |
| 上下文膨胀 | 中 | 子会话只回摘要；编排会话保留任务卡 |
| 多任务并发 | 中 | 每任务独立 Session；编排层聚合状态 |
| 原生 DOM/文案升级 | 中 | 隐藏器与标签替换加契约测试/降级 |
| 与原生 Agent Teams 工具冲突 | 中 | 命名空间隔离；助手工具统一 `assistant_*` |
| 权限越界 | 高 | 子 Session 继承助手 permissionPreset，禁止跨工作区 |
| 多 Host 所有权冲突 | 中 | 租约 + 单写者；冲突时只读提示 |

---

## 10. 分阶段落地

### Phase 0：助手目录 + 常驻编排（2–3 天）

- 侧栏助手行、头像、单聊标识。
- 助手模板选择/创建。
- 点击懒创建 orchestrator，打开原生会话。
- 隐藏 orchestrator 原生侧栏行。
- 验收：重启后能恢复同一 orchestrator。

### Phase 1：任务 Session + 手动路由（5–7 天）

- `assistant_sessions` 映射表。
- 编排工具：list/create/send/summary。
- 助手详情 Session 切换器。
- 新建任务、继续指定任务（用户显式选择）。
- 验收：一个助手 3 个任务 Session，侧栏只留助手入口。

### Phase 2：智能路由 + 汇总（5–10 天）

- 编排模型根据任务列表选择 create/send/reply。
- 任务摘要回传、并发状态。
- 低置信度追问。
- 验收：30 条真实对话路由准确率 ≥ 85%，误建任务可撤销。

### Phase 3：稳定性与体验（3–5 天）

- 失败重试、归档、权限、埋点。
- 文档与回归测试。
- 原生升级兼容检查。

**单人估算：3–4 周；Phase 0 可独立上线验证。**

---

## 11. 验证清单（Spike）

1. 创建助手 → 点击 → orchestrator 创建/打开 → 重启恢复。
2. 创建子任务 Session → 发送任务 → 子会话运行 → 摘要回编排。
3. 子 Session 不出现在原生侧栏；助手切换器可打开。
4. 用户说「继续登录页任务」→ 路由到正确 Session。
5. 用户说「新做一个接口文档」→ 新建任务 Session。
6. 3 个任务并发 → 编排会话状态正确、无串话。
7. 权限/工作区边界：子 Session 不能越权。
8. DSH 升级模拟：隐藏器/标签替换失效时是否有降级。

---

## 12. 待决策

1. 子 Session 是否允许在原生侧栏出现（建议：默认隐藏，可在详情查看）。
2. 新建任务是否要用户确认（建议：明确新任务直接建；模糊时追问）。
3. 路由激进程度（建议：确定性优先，模型只做建议）。
4. 子任务实现选型：**原生 DSH Session（推荐 MVP）** vs 原生 subagent（后续评估）。
5. 助手数量上限与并发上限。

---

## 13. 最终建议

- **可行，建议立项。**
- 先做 Phase 0：只验证「助手入口 + 常驻编排 Session + 原生会话复用」，不碰智能路由。
- Phase 1 再引入任务 Session 和映射表；Phase 2 再做模型路由。
- 不要重写原生聊天；插件负责目录、映射、编排工具和隐藏/打开。
- 只要 Phase 0 通过，后续主要是编排策略和稳定性工作，不存在底层阻塞。
