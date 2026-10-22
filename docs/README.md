# Agent Team 用户手册

[返回中文首页](../README_CN.md) · [English README](../README.md)

Agent Team 是 DeepSeek Harness Web 插件，用于把多个平级、独立的 AI Agent 组建为团队。每位成员拥有自己的模型、Session、上下文和工具调用，同时共享一个 Workspace，并通过团队任务与消息协作。

![多成员团队工作台](./assets/dsh-team-mode/parallel-final.png)

## 与常见 Subagent 工作流的区别

Agent Team 不把团队成员实现为 Leader 的临时子 Agent，而是为每个职责创建独立的根级 Agent。这样做的目标不是单纯增加 Agent 数量，而是把模型、工具、权限和上下文按专业职责拆开。

| 能力 | 带来的价值 |
| --- | --- |
| 每个成员独立模型 | 复杂规划使用高能力模型，编码、测试、提交信息等任务使用更适合或成本更低的模型 |
| 每个成员独立 Skills / MCP | 避免一个 Agent 同时加载大量无关能力，减少工具选择噪音和提示负担 |
| 每个成员独立上下文 | 执行细节留在执行成员中，Leader 只接收进度与结果，缓解单 Agent 上下文膨胀 |
| 每个成员独立权限 | 评审成员可以只读，编码成员只获得 Workspace 写权限，降低不必要的访问范围 |
| 显式团队消息 | 任务、进度和结果都有明确接收方与成员 ID，同名成员也能可靠区分 |

因此，一个团队可以由高能力 Leader、专业编码模型、低成本文档助手和只读审查助手共同组成，而不必让所有工作都经过同一个模型和同一套庞大配置。

### 典型配置示例

| 成员 | 推荐模型分工 | 权限和能力 |
| --- | --- | --- |
| GPT Leader | 需求理解、架构规划、任务拆解和结果验收 | 只加载团队管理与必要的审查能力 |
| GLM 编码成员 | 编写代码、修改文件、运行测试 | Workspace 可写，加载编码 Skills 和开发 MCP |
| DeepSeek Flash Commit 助手 | 读取 Git 变更并生成提交信息 | 只读，只需要 Git 分析相关工具 |

Leader 把编码任务交给 GLM，并只接收进度、测试结果和关键产出；验收后再把范围明确的 Commit 任务交给 DeepSeek Flash。这样既保留 GPT 在复杂决策上的优势，又避免所有步骤都使用同一个高成本模型。

## 从哪里开始

| 你的目标 | 推荐文档 |
| --- | --- |
| 首次安装和启动插件 | [安装与启动](./installation.md) |
| 创建 Leader、Coder 或其他角色 | [助手库](./assistants.md) |
| 使用单聊助手（个人常驻助手） | [单聊助手](./assistant.md) |
| 选择成员并创建团队 | [创建团队](./creating-teams.md) |
| 使用多成员聊天和团队协作 | [工作台与协作](./workbench.md) |
| 浏览文件、查看 Git 变更 | [Workspace 与 Git 变更](./workspace.md) |
| 添加/移出成员、清空或解散团队 | [团队管理](./team-management.md) |
| 安装失败、模型缺失或界面异常 | [故障排查](./troubleshooting.md) |
| 后续方向与优先级 | [团队模式后续规划](./TEAM-MODE-ROADMAP.md) |

## 核心概念

### 助手

助手是可复用的角色模板，保存 Provider、模型、Agent Preset、默认权限、思考模式、Skills、MCP Servers 和助手规则。助手本身不运行，加入团队后才会创建独立成员实例。

### 团队成员

团队成员是助手在某个团队中的运行快照。即使多次选择同一个助手，也会得到不同的成员 ID、Session 和上下文。

### Leader

每个团队必须有且只有一个 Leader。Leader 负责理解目标、拆解任务、分派成员、接收状态和验收结果。Leader 不是其他成员的父 Agent，所有成员仍然是平级、独立 Agent。

### Workspace

团队所有成员共享同一个 Workspace，因此可以读取或修改同一批文件。每位成员是否可以修改文件，由该成员当前 Session 的权限决定。

## 推荐使用流程

1. 在 Harness 中配置需要使用的 Provider、模型和凭据。
2. 进入 **设置 → Agent 团队** 创建至少一个 Leader 和一个普通成员助手。
3. 点击悬浮 **团队** 按钮进入工作台，再点击团队列表顶部的 `+`，选择成员、Leader 和 Workspace。
4. 创建团队后，在自动打开的工作台中向 Leader 描述完整目标。
5. 观察 Leader 分派任务、成员执行、状态回报和最终验收。
6. 需要时直接向某个成员补充要求，或在团队管理中调整成员。

## 数据与安全边界

- Provider API Key 和 MCP 凭据由 Harness Profile 管理，Agent Team 不保存这些凭据。
- 助手模板中的权限只是成员首次启动时的默认值，可在工作台中按成员调整。
- 解散团队不会删除助手模板或 Workspace 文件。
- 清空上下文或解散团队后，旧 Session 不再被插件恢复或使用；Harness 底层日志仍可能保留。

## 获取帮助

如文档未能解决问题，请在 [GitHub Issues](https://github.com/gpmlimeng-cyber/dsh-team-mode/issues) 提交反馈，并附上：

- DeepSeek Harness 版本。
- Agent Team 版本。
- 操作步骤和错误提示。
- 必要的界面截图（请先遮盖 API Key、Token 和私人路径）。
