# 对齐 nightly-labs/openbot（DSH 插件形态）

> 2026-10-29 · 目标：**在 DSH 的架构与插件体系内**，复刻 `nightly-labs/openbot` 的功能与 UI 交互。
> 本文替代 `2026-10-29-openbot-parity-rebuild.md`（那份误把 OpenMausBot 当成目标）。

## 0. 参考物是什么

`nightly-labs/openbot`：本地优先的桌面工作台，每个 agent 有自己的工作区与会话，支持 Codex / Claude / Grok / OpenCode / Gemini / Cursor / Cline 等多 provider，带本地队列、文件传输、内嵌浏览器、agent 间消息、共享频道聊天、Computer Use。

代码规模：**5332 个 TS/TSX**；桌面渲染层 31 个 feature 域：

```
conversation 81  web-client 51  servers 35  settings 28  onboarding 23
agents 16  channels 14  connectors 12  browser 12  updates 11  sidebar 11
window 8  computer-use 8  team 7  custom-providers 7  provider-updates 6
files 6  usage 5  speech 5  routine-flows 5  schedule  agent-tasks  agent-templates
agent-threads  account  custom-agents  dynamic-island  remote-desktop  startup  vault  workflows
```

## 1. 「复刻」的边界（DSH 决定的部分）

我们是 **DSH 插件**，不是 Electron 应用。所以每个域先过一次能力判定：

| 判定 | 含义 | 处理 |
|---|---|---|
| **B 自建** | 宿主不提供，插件用 slot/service 实现 | 我们写 |
| **H 映射** | 宿主已有等价能力 | 只做 UI 与数据映射，不重造 |
| **X 不做** | 宿主无此能力或产品边界外 | 记进 parity 文档说明理由 |

DSH 已提供（→ H）：Agent 运行时与模型路由、会话持久化、`conversation.*` / `sidebar.*` 槽、定时任务（schedule）、MCP 服务器、技能（skills）、Computer Use（`cua_driver` 工具族）、附件输入、权限闸门。

## 2. 分层计划（从基础往上，一次只开一个阶段）

### P0 能力矩阵（先做，纯文档）

把 31 个域逐个标 `B/H/X`，并写清"映射到哪个宿主 API"或"为什么不做"。

Exit：`docs/parity/00-capability-matrix.md`，31 行，每行带证据（宿主 slot 名 / 文档行号）。

**在 P0 完成前不写任何功能代码**——否则做出来的东西可能宿主早就有了（我们已经因为"不知道宿主有 schedule"重造过一次）。

### P1 外壳与导航

```
sidebar（11）  窗口与面板状态（window 8）  settings 框架（28 的壳）  startup/onboarding 入口（23）
dynamic-island（通知与运行态浮层）
```

Exit：左侧栏结构、会话区、右侧面板与 OpenBot 一一对应；开/关/宽度记忆；空态与加载态齐全。

### P2 Agent 模型

```
agents（16）  custom-agents  agent-templates  custom-providers（7）  provider-updates（6）
每个 agent 的：模型/推理/权限 profile/通知/浏览器/面板状态
```

Exit：新建 agent 可指定 provider 与模型、可编辑指令与头像、保存前有 section review；不支持的 provider 明确说明。

### P3 会话与队列（OpenBot 的核心差异点）

```
conversation（81）  agent-threads  agent-tasks  files（6）
FIFO 消息队列：暂停/恢复/取消 + 崩溃安全
```

Exit：一条消息在跑时长按"再发一条"→ 进队列并显示位置；暂停/恢复/取消都作用于队列而不是杀会话。

### P4 协作

```
team（7）  channels（14）  共享历史、单一任务负责人、显式分派
Stop / Resume / Reassign / Archive / Restore
```

Exit：共享频道里"谁负责这件任务"始终有唯一答案；Reassign 有 UI。

### P5 自动化

```
schedule  routine-flows（5）  workflows
```

Exit：定时与触发两类例行可用，有三态与运行记录（我们已有 spec）。

### P6 环境能力

```
browser（12）  computer-use（8）  servers（35）  remote-desktop  vault  connectors（12）
```

Exit：按 P0 矩阵里能映射到宿主的部分接通；不能的写清楚。

### P7 元能力

```
usage（5）  updates（11）  speech（5）  web-client（51，若与 DSH Web 重合则 X）
```

## 3. 每阶段的交付物

1. 代码 + `npm run check` 绿；
2. **一条端到端场景**（不是单元断言拼接）；
3. `docs/parity/<stage>.md`：逐组件对照表 `OpenBot 文件 → 我们的实现 → 完全/等价/不做 + 证据`；
4. 队长自己读 diff 验收。

## 4. 明确不做（除非宿主提供）

| 域 | 判定 | 理由 |
|---|---|---|
| `window`（Electron 窗口控制） | X→H | 窗口归宿主；只保留面板宽度记忆 |
| `updates`（应用更新） | X | 宿主负责分发 |
| `web-client` | X | DSH 自己就是 Web GUI |
| `remote-desktop` / `servers` | 视 P0 | 依赖远程会话与云主机，宿主未提供则 X |
| `account`（OpenBot 账号/Cloudflare） | X | 与产品边界冲突 |

## 5. 执行规则

- **一次一个阶段**，阶段内一次一个模块；
- 每阶段开工前做**带 `文件:行号` 的盘点**（P0 就是这个盘点的第一份）；
- 任何"等价"都要写清等价在哪，任何"不做"都要写理由；
- 不跨阶段加功能，点状优化只作为阶段收口的一部分。

## 6. 下一步

开 **P0 能力矩阵**。它是唯一能在写代码前回答"这件事到底该不该我们做"的东西，成本一天，省掉的是后面每个阶段的返工。
