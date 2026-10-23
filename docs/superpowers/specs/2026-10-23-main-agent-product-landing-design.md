# 主 Agent 产品形态与双模式共存 — 设计方案

> 2026-10-23 · 产品形态方案 · 落地版
> 目标：把已有的团队运行时包装成用户能直接使用的“一个主 Agent + 一个团队”
> 约束：同一个 profile 共存；不新增 Agent 实体；不新增 DSH Preset；不做全局 Captain

## 1. 结论

```text
Team           = 持久组织
Main Agent     = 用户唯一默认入口（当前由 Leader 承担）
Leader         = 当前值守人，可随 Team Epoch 更换
Members        = 二级执行层，不默认展开
SurfaceMode    = native | team，同一 profile 内切换
```

第一版不新增 `ChiefAgent` 或 `principal` schema。  
先把 Leader 从“团队成员之一”提升为“团队主 Agent 的产品入口”。

## 2. 用户模型

```text
用户
  ↓
主 Agent（团队默认会话）
  ├─ 普通问题：直接回答
  ├─ 单一交付：1 个 Goal + 1 个 Task
  ├─ 复杂目标：DAG + 成员
  └─ 收口：只给结论、风险、待决策
        ↓
团队面板：成员 / 任务 / 依赖 / 审批
        ↓
成员会话：按需展开，不默认并排
```

主 Agent 不是“所有消息都经手”的中介；它是**默认界面和最终责任人**。

## 3. 界面

### 3.1 团队默认页

```text
┌ 侧栏 ─┬─ 主 Agent 对话 ─────────────┬─ 团队面板（默认收起）─┐
│ 团队   │ 团队名 / 主 Agent / 状态    │ 成员                 │
│ 助手   │                            │ 任务                 │
│ 原生   │ 对话记录                    │ 待审批               │
│        │ 输入框                      │ 依赖概览              │
└───────┴────────────────────────────┴──────────────────────┘
```

- 打开团队 = 打开 Leader 主会话，使用 DSH 原生会话界面
- 现有“群聊/并行”标签保留，但改为“并行视图”，不是默认
- 现有“看板”标签保留，进入后按 `team-collaboration-overview` 设计提供 `总览/任务`
- 成员会话从团队面板进入，打开后作为二级会话，不替换主 Agent

### 3.2 顶部身份

```text
Compiler Team · 主 Agent
当前 Leader：小码
状态：思考中 / 等待审批 / 空闲
```

MVP 用团队名 + 团队头像 + 团队职责作为稳定身份；Leader 名称是“当前值守人”。  
后续再增加团队级 principal 配置（名称、头像、团队指令），不阻塞 MVP。

## 4. 双模式共存

同一个 profile 内：

```ts
type SurfaceMode = "native" | "team";
```

### native

- 只显示 DSH 原生会话与原生界面
- 隐藏团队/助手注入入口、团队面板、协作总览
- 不改变 Session 数据、不注销工具
- 当前是团队 Session 时，切到 native 导航到原生落点；团队 Session 继续隐藏

### team

- 显示团队/助手入口、主 Agent、团队面板、协作总览
- 原生会话保留为“普通会话”
- 原生会话不获得团队工具；团队工具仍只挂在团队/助手 Session 上

### 切换

- 侧栏顶部或命令面板：`[原生] [团队]`
- 客户端持久化：`dsh-team-mode:surface-mode`
- 插件配置只提供默认值：

```yaml
dsh-team-mode:
  defaultMode: team
```

- 切换不重启、不重载插件、不写业务数据
- 刷新后保持上次选择

## 5. 主 Agent 行为

Leader prompt 增加：

- 普通问题直接回答，不建 Goal/Task
- 单一交付才建一个任务
- 复杂目标才开 DAG
- 成员结果由主 Agent 收口
- 只把需要人决策的点抛给用户
- 不把成员原始会话倒给用户
- 不自己审批自己；审批仍走 DSH 原生交互

Turn Engine 默认把用户消息路由到 Leader；`@member` 才直接找成员。

## 6. 协作总览

复用 `docs/superpowers/specs/2026-10-23-team-collaboration-overview-design.md`：

- 现有看板内增加 `总览 / 任务`
- 总览包含 Leader 摘要、进度、成员任务、依赖图、任务详情、Leader 收件箱
- 不新增独立页面、不复制团队切换、不引入图形库

## 7. 数据与接口

MVP 不新增后端 API、不新增 schema 字段：

- 团队身份从 `TeamView` 的 name/avatar/workspace 派生
- 主 Agent 就是 Leader Session
- 团队面板从现有 members/tasks/messages 派生
- 协作总览从现有 tasks/messages 派生
- `defaultMode` 只加插件配置
- 客户端新增 `surface-mode` 与 `team-main-agent` 纯逻辑模块

后续才考虑：

- `principal` 团队级身份
- 成员消息从主对话中折叠
- 全局跨团队总览

## 8. 分期

### P0 收尾（不新开功能）

- Turn Engine 修复与复验通过
- 真实宿主重启验证，未执行则记 UNKNOWN
- 主分支 `npm run check` 稳定

### P1 主 Agent 入口（MVP）

1. 双模式状态 + 配置默认值
2. 侧栏模式切换，原生模式隐藏插件入口
3. 团队默认打开 Leader 主会话；并行视图改为非默认
4. 团队面板：成员、任务、待审批、依赖概览
5. Leader prompt 增加直接回答/收口约束

### P2 协作总览

按现有设计实现看板内 `总览/任务`，再补依赖图、任务详情、Leader 收件箱。

### P3 身份与收口

- 团队级稳定 principal
- 成员消息折叠到团队面板
- 主 Agent 汇总卡
- 模式：对话 / 单任务 / 编排

## 9. 验收

- 同一 profile 切换原生/团队，不重载插件、不丢数据
- 团队打开默认是 Leader 主会话
- 原生模式不显示团队入口；团队模式原生会话仍可访问
- 成员会话从团队面板打开，不替换主 Agent
- 普通问题不建 Goal/Task
- 有活跃 worker 时，团队面板显示运行态
- 总览/任务切换保留筛选
- `npm run check` 稳定通过
