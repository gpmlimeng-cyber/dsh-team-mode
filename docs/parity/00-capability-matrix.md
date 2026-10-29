# P0 · OpenBot 域 → DSH 能力矩阵

> 2026-10-29 · 31 个渲染层 feature 域逐个判定 **B 自建 / H 映射宿主 / X 不做**。
> 判定依据只认两类证据：宿主暴露的槽位与服务（我们已在用）、或本仓已有实现。**没有证据的一律进 §4 待验证，不假装确定。**

## 1. 矩阵

| # | OpenBot 域 | 判定 | 映射到 / 理由 | 证据 |
|---|---|---|---|---|
| 1 | `conversation` | **H** | 宿主会话 UI（消息流、composer、附件、审批卡位置都在宿主内） | 槽 `conversation.view` / `conversation.input.left` / `conversation.session.header.*`（`src/client/index.tsx`） |
| 2 | `sidebar` | **H + B** | 外壳与列表槽宿主给；团队/助手结构我们填 | 槽 `sidebar.footer.action`、`sidebar.right.pane.tab`；`sidebar.tsx` 的宿主导入点 |
| 3 | `settings` | **H + B** | 设置框架宿主给，我们的分区自己注册 | 槽 `sidebar.right.pane.tab`；`assistant-settings-pane.tsx` |
| 4 | `agents` | **B（叠 H）** | 宿主提供会话与模型路由，我们提供"同事实例"这层（形象/指令/技能/记忆） | `assistant-instance` 服务与 `team-member-chrome.tsx` |
| 5 | `agent-threads` | **B** | 每个同事一条主会话 + 多条线程 | `team.thread.*` 服务与传输、标题下拉切换器 |
| 6 | `agent-tasks` | **B** | 任务板、检查点、验收标准 | `team.tasks` / `team.task.*` 服务 |
| 7 | `agent-templates` | **B** | 可复用角色模板，建团队时选人 | `TEAM_TEMPLATES`、`assistant-create` 里的模板选择 |
| 8 | `team` | **B** | 团队/成员/角色/公告/批量/导出 | `team.*` 服务全量 |
| 9 | `channels` | **B（部分有）** | 共享频道聊天：我们已有团队会话与线程，**缺"单一任务负责人 + 显式分派"的频道语义** | `team.thread.*` 已有；负责人语义仅在任务上 |
| 10 | `schedule` | **H** | 宿主的定时/提醒面板 | `layout.selectPanel('schedules')`（`assistant-detail.tsx:488`） |
| 11 | `routine-flows` | **B** | 例行流程（触发→执行→记录）在宿主 schedule 之上加我们的语义 | 宿主 schedule + 本仓 `2026-10-28-team-briefing`（已 park）思路 |
| 12 | `workflows` | **B（待验证）** | OpenBot 的多步工作流；我们先用"例行 + 任务板"覆盖，纯工作流编辑器后置 | 见 §4 |
| 13 | `files` | **H + B** | 附件与图片走宿主输入槽；我们补"文件在团队内传递"的 UX | 槽 `conversation.input.attachments` / `overlay` |
| 14 | `browser` | **H（工具）/ B（面板）** | 宿主的浏览器工具族（CUA）可让 agent 操作网页；**内嵌常驻浏览器面板宿主没有可用的 slot** | 见 §4 待验证 |
| 15 | `computer-use` | **H** | `cua_driver` 工具族即宿主提供的 Computer Use | 会话工具清单中的 `cua_driver_native__*` |
| 16 | `connectors` | **H + B** | MCP 服务器是宿主能力；"连接应用"这层的目录与状态卡我们做 | `catalog.mcpServers`、设置面板技能与 MCP 分区 |
| 17 | `custom-agents` | **B（待验证）** | 自定义 ACP agent；宿主是否支持注册自定义 agent 后端未知 | 见 §4 |
| 18 | `custom-providers` | **H** | 自定义 OpenAI 兼容端点属于宿主模型配置 | 本机 `cordis.patch.yml` 的 `llm-pi-ai` providers |
| 19 | `provider-updates` | **X** | provider/模型目录由宿主维护 | 宿主 `catalog` 投影 |
| 20 | `onboarding` | **B** | 首次引导（我们只有首用卡，缺完整流程） | `team-next-step.tsx` 为起点 |
| 21 | `dynamic-island` | **B** | 悬浮运行态/通知浮层 | 槽 `shell.overlay` |
| 22 | `usage` | **H + B** | token/上下文投影宿主给，面板我们做 | `readAssistantAutomations` 等只读投影 |
| 23 | `window` | **X** | Electron 窗口控制归宿主；只保留面板宽度记忆 | — |
| 24 | `startup` | **X** | 应用启动/生命周期归宿主 | — |
| 25 | `updates` | **X** | 应用与插件分发归宿主 | — |
| 26 | `account` | **X** | OpenBot 账号/Cloudflare 与产品边界冲突 | — |
| 27 | `servers` | **X** | 远程会话与多租户托管超出插件职责 | — |
| 28 | `remote-desktop` | **X** | 同 27 | — |
| 29 | `vault` | **X（待验证）** | 凭据保管若宿主无 keychain 暴露则不做 | 见 §4 |
| 30 | `web-client` | **X** | DSH 本身就是 Web GUI | — |
| 31 | `speech` | **X（待验证）** | 语音输入/朗读需宿主音频通道 | 见 §4 |

**结论：自建 12、映射 9、不做 10。**

## 2. 由此得出的阶段顺序（替换原 P1–P7 的描述）

```
P1 现在能做的、全 B 的：onboarding / dynamic-island / channels 的负责人语义
P2 agent 模型的面：agents / agent-threads / agent-tasks / agent-templates 的缺口收口
P3 自动化面：routine-flows（宿主 schedule 之上的语义）
P4 连接与文件：files 的团队内传递、connectors 的目录与状态卡
P5 待验证项有结论后再排：browser 面板 / custom-agents / vault / speech / workflows
```

## 3. 明确不做（写死，避免以后重问）

`provider-updates`、`window`、`startup`、`updates`、`account`、`servers`、`remote-desktop`、`web-client` —— 全是宿主职责或产品边界外。

## 4. 待验证清单（P0 遗留，各需一次小 spike）

| 项 | 要验证什么 | 若不成立的替代 |
|---|---|---|
| 内嵌浏览器面板 | 宿主是否有可承载常驻 webview 的 slot 或公开 API | 只保留浏览器工具（H），不做常驻面板 |
| 自定义 agent 后端 | 宿主能否注册非内置 agent/provider 实现 | 只做自定义模型端点（H） |
| vault / 凭据 | 宿主是否有凭据保管服务 | 不做，依赖宿主设置页 |
| speech | 宿主是否有语音输入/朗读通道 | 不做 |
| workflows | OpenBot 的 workflows 是否只是"例行 + 任务板"的组合 | 用 B 的例行 + 任务板覆盖，不单独做编辑器 |

每一项 spike 的产出是一段 10 行的结论（能/不能 + 证据 + 替代方案），不做实现。
