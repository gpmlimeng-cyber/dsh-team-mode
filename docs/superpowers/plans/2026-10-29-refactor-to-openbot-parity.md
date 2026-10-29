# 基于现有实现的改造方案（对齐 OpenBot）

> 2026-10-29 · 输入：`docs/parity/00-capability-matrix.md`（31 域判定 B12 / H9 / X10）。
> 原则：**不推倒重来**。现有 15k 行客户端 + 6.7k 行服务是可用的地基，改造成本必须落在缺口上，而不是重写已经跑通的东西。

## 1. 现有资产盘点（改造的地基）

| 资产 | 位置 | 改造判断 |
|---|---|---|
| 团队/成员/角色/公告 | `team.*` 服务、`teams/TeamPanel.tsx`(2594 行) | **保留**，加频道语义 |
| 线程（团队会话） | `team.thread.*`、标题下拉 `team-member-chrome.tsx` | **保留**，补队列与负责人 |
| 任务板/检查点/验收 | `team.tasks`、`TeamBoard.module.css` | **保留**，加"个人视图" |
| 助手实例（同事） | `assistant-instance` 服务、`assistants/` | **保留**，补 per-agent 面板/通知状态 |
| 记忆 | `assistant-memory-panel.tsx`、`memory-gaps` spec | **保留**，按 spec 落地 |
| 模板 | `TEAM_TEMPLATES`、建团选择器 | **保留** |
| 导出/导入 | 分组 portable JSON | **保留** |
| 用量 | 只读投影面板 | **保留**，扩到 per-agent |
| 今天首页 | `today-model.ts` + `today-surface.tsx`(709 行) | **保留**，成为通知岛的数据源 |
| 设置面板 | `assistant-settings-pane.tsx`（8 分组） | **保留**，加连接器分组 |
| 头像/模型控件 | `assistant-avatar-editor.tsx`、`model-control.tsx` | **保留**（已对齐） |

**没有一项要整体重写。** 改造 = 4 类动作：扩展（E）、合并（M）、新增（N）、删除（D）。

## 2. 差距与动作表

| OpenBot 域 | 我们现在 | 动作 | 具体做什么 |
|---|---|---|---|
| `channels` | 团队 + 线程，有任务但有"负责人" | **E** | 线程级 `ownerSlotId`（唯一负责人）+ 显式分派（`team.thread.assign`）；`Stop/Resume/Reassign/Archive/Restore` 五项进线程菜单 |
| `conversation`（队列） | 只能等一轮跑完 | **N** | FIFO 队列：暂停/恢复/取消 + 崩溃安全落库；UI 在 composer 上方显示队列位置 |
| `agent-tasks` | 只有团队任务板 | **E** | 任务板加「按同事筛选」视图；同事详情显示它手上的任务 |
| `onboarding` | 一张首用卡 `team-next-step.tsx` | **N** | 三步引导：建同事 → 建团队 → 派第一个任务；每步可跳过且能回看 |
| `dynamic-island` | 无 | **N** | `shell.overlay` 浮层：跑着的回合、待确认数、失败提示；**数据源复用 `today-model.ts`** |
| `routine-flows` | 无 | **N** | 宿主 schedule 之上加"例行"记录：上次/下次/结果，不做第二套调度器 |
| `files` | 宿主附件够用 | **E** | 团队内文件清单（谁给了谁），复用附件通道 |
| `connectors` | 技能与 MCP 分区 | **E** | 设置面板加「连接应用」分组：名称/状态/工具数，只读为主 |
| `usage` | 全局面板 | **E** | 加 per-agent 用量行（复用同一投影） |
| `browser` / `custom-agents` / `vault` / `speech` / `workflows` | 无 | **等 spike** | 见矩阵 §4，有结论再排 |

## 3. 四批改造（每批独立可发布）

### 批一：词汇与事件统一（无用户可见变化，先做）

```
把 bot/assistant/instance/coworker → 统一为「同事」(coworker)
room/team/group → 团队（有子概念：频道=线程）
approval/escalation/gate → 待确认
新增 docs/parity/01-domain.md；代码内注释与 UI 文案随批一统一
事件层：today-model 与未来的通知岛共用同一份派生输入
```

理由：现在 6.7k 行服务里同一概念有多个名字，**每加一个功能都要在脑内做一次翻译**，这是持续成本。

### 批二：频道语义（OpenBot 的核心差异）

```
schema: teamThreadSchema 增加 ownerSlotId?
service: team.thread.assign / stop / resume / archive / restore
UI:     线程行的负责人标记；线程菜单五项；空状态说明"谁在负责"
```

Exit：一个频道里任何时刻只有**一个**负责人；换负责人有记录；Stop/Resume 不影响会话本身。

### 批三：消息队列（最有用户价值，也最重）

```
本地持久化队列（失败/重启后仍在）
暂停/恢复/取消作用于队列而不是杀会话
UI: composer 上方一条"队列 N 条 · 暂停中"
```

Exit：连发三条消息，第一条在跑，后两条排队且位置可见；暂停后不再发下一条；重启后队列还在。

### 批四：可见性（onboarding + 通知岛 + 例行）

```
onboarding 三步
dynamic-island 复用 today-model
routine-flows 记录页
```

## 4. 风险与回退

| 风险 | 处理 |
|---|---|
| 队列改动碰到宿主回合生命周期 | 队列只排"何时提交"，**不碰回合内部**；宿主拒绝时回落到当前行为 |
| per-agent 状态膨胀 | 只存真正影响 UI 的字段（面板宽度、通知开关），**不存派生值** |
| 词汇统一造成大 diff | 只改注释与 UI 文案，**不动 API 名**（transport 名保持稳定，避免破坏已有调用） |

## 5. 第一刀（本轮就做）

**批一（词汇与事件统一）**：产出 `docs/parity/01-domain.md` + 文案/注释统一 + `today-model` 与通知岛共用的派生入口。**不改 API 名、不改行为**，所以可以一次合入、随时回退。
