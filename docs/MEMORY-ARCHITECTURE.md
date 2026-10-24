# 记忆管理方案

> 2026-10-22 · 面向团队模式与单聊助手 · 参考 DS Bot、OpenMausBot 与 DSH 社区记忆插件

## 目标

把记忆从“单个字符串”升级为结构化、分 scope、可审计、可恢复的长期能力。

```text
助手记忆：我是谁、用户偏好、长期事实
团队记忆：我们怎么协作、共同决策、项目事实
Goal 记忆：这次目标做到哪、关键结论
会话日志：可搜索历史，不是记忆
工作记忆：任务板、attempt、进度
```

原则：

- 记忆与上下文压缩分离
- Core 稳定加载，Topic 按需召回
- 写入可审计，删除可恢复
- 团队记忆有明确权限
- 不把聊天记录直接当记忆

## 竞品结论

| 竞品 | 机制 | 采用 |
|---|---|---|
| DS Bot | Bot/群/团队分层；Markdown；Session 冻结；`recall`；journal/snapshot | scope 分离、冻结、按需召回 |
| OpenMausBot | `MEMORY.md` + topic + archive；预算；auto recall；capture/upkeep/tidy；journal undo；团队 key/pin | 预算、整理、审计、团队记忆 |
| DSH 社区插件 | 文件型、图型、自动演化型 | 借鉴召回与整理；核心 scope 自己掌控 |

不直接把第三方记忆插件作为核心后端；未来可作为可选检索/图关系适配器。

## Scope 模型

### Assistant memory

```text
assistantId + 全局
用户偏好、身份、长期约束
可在 DM 与团队中使用
```

### Team memory

```text
teamId + 团队内共享
团队约定、项目事实、决策、术语
只在团队成员 Session 中加载
不进入 DM，不跨团队
```

### Goal memory

```text
goalId + 目标级
目标摘要、关键决定、产物
目标结束后可提炼进 Team memory
```

### Working memory

```text
Task board / attempt / progress
不进入长期记忆
```

### Transcript

```text
会话消息与活动日志
可搜索、可引用
不自动注入 prompt
```

## 三层结构

```text
Core
  每轮加载
  Assistant core + Team core
  严格预算

Topic
  按需召回
  项目、客户、领域知识
  不默认进 prompt

Archive / Journal
  不加载
  可搜索、可恢复、可审计
```

建议预算（字符，配置可调）：

```text
Assistant core   4k
Team core        2k
Topic            16k / 篇
单次 recall      6k
```

## 数据模型

```ts
MemoryEntry {
  id
  scope: 'assistant' | 'team' | 'goal'
  scopeId
  key?             // Team memory 稳定 key
  title
  body
  tags[]
  source: 'user' | 'leader' | 'member' | 'auto'
  status: 'active' | 'proposed' | 'superseded' | 'archived'
  revision
  confidence?
  createdAt
  updatedAt
  expiresAt?
  supersedesId?
}
```

辅助：

```text
memory_journal
  操作者、时间、前后内容、原因

实现取舍：不新增 memory_journal 表。日志作为可选 `journal[]` 内嵌在
`assistant_memory` 与 `TeamAggregate.memory` 中，随记忆写入原子提交；
没有 journal 字段的旧记录原样加载，schemaVersion 不变。

memory_links（可选）
  条目关系，后续图记忆
```

兼容：

```text
assistant_memory 旧字段
→ 首次迁移为一条 core 条目
→ 旧工具保持兼容
```

## 权限

| 角色 | 助手记忆 | 团队记忆 |
|---|---|---|
| 助手主会话 | 读写 | 只读 |
| Worker | 只读 | 只读 |
| 团队成员 | 只读 | 读；可 propose |
| Leader / 管家 | 读写自己的 | 读写团队 |
| 用户 | 全部 | 全部 |

团队记忆流程：

```text
成员 propose
→ Leader accept / reject
→ 用户可直接编辑
```

## 读取

每轮：

```text
1. 加载 Assistant core
2. 团队中加载 Team core
3. 不自动加载 Topic
4. 需要时 memory_recall
```

后续自动 recall：

```text
用户消息
→ 检索相关 Topic
→ 最多 4 条
→ 作为“参考笔记”放在用户消息前
→ 不修改 system prompt
```

Core 必须在 Session 内保持稳定，保护前缀缓存。  
新写入之后才需要的内容，通过 `memory_recall` 获取。

## 写入

第一阶段手动：

```text
assistant_memory_write
team_memory_remember
team_memory_forget
memory_recall
```

目标结束：

```text
Leader 生成 Goal summary
→ 提炼 2–5 条 Team memory
→ 用户可见 / 可撤销
```

第二阶段自动：

```text
对话空闲 / 目标结束
→ 小模型提取事实
→ 去重、合并、冲突检测
→ 写入 proposed
→ Leader 或用户接受
```

不每轮自动写。

## 整理

```text
Capture   抓事实
Upkeep    归主题
Tidy      去重、过期、冲突
```

团队记忆额外：

```text
稳定 key
revision 乐观锁
supersedes
pin 核心条目
```

冲突规则：

```text
同 key 新条目 supersedes 旧条目
旧条目保留历史
不物理删除
```

敏感信息写入前 redact：API key、token、密码、私钥。

## UI

助手设置：

```text
助手记忆
├─ 核心记忆
├─ 主题
├─ 归档
└─ 变更历史 / 撤销
```

团队页：

```text
团队记忆
├─ 核心约定
├─ 项目事实
├─ 待接受提议
└─ 历史
```

展示：

- 当前加载量
- 未加载条目
- 来源
- 最后修改人
- 撤销入口

## 与上下文管理分离

```text
上下文管理：这次在做什么
记忆管理：跨对话应该记住什么
```

本阶段不实现完整上下文管家。  
后续长群聊单独做 Session 分段、checkpoint、handoff，不混入记忆。

## 自动捕获（可选）

`memoryAutoCapture` 默认 `false`，显式开启后才在完成事件上写入，且只写 `proposed`：

```text
Goal 显式完成
→ 最多 2 条 team 条目（goal:<id>、goal-results:<id>）
   objective/acceptance + 最多 3 条已完成任务结果
→ status=proposed, visibility=team-safe, source=auto

单聊助手的 worker 任务完成
→ 1 条 assistant 条目（task:<id>）
   title + resultSummary
→ status=proposed, visibility=private, source=auto
```

约束：不调用模型、不自动接受、不写 `active`、不新增工具；内容先脱敏再截断（标题 200、正文 4,000 字符），按 key 与规范化文本去重；团队侧在聚合原子写入内复查 epoch，助手侧复用记忆写入锁。捕获失败只记录日志，不影响完成事件；旧记忆容器与关闭配置下的行为完全不变。

## 落地阶段

```text
P0  结构化 MemoryEntry + Assistant/Team scope
    core 注入 + 手动读写 + 旧字符串兼容

P1  Team memory 提案/接受、pin、journal、UI 编辑
    Goal 结束提炼团队记忆

P2  recall（已落地 query/status/limit 子串召回）+ 主题检索
    自动 capture（已落地，默认关闭、只写 proposed）
    去重、过期、冲突整理

P3  会话搜索 / FTS、图关系、自动 recall
    可选社区记忆插件适配器
```

## 明确不做

- 继续单字符串作为唯一记忆
- 把聊天记录直接当记忆
- 所有成员直接覆盖团队核心记忆
- 每轮自动总结
- 让第三方记忆插件绕过团队权限
- 用记忆替代上下文压缩

## 当前差距

```text
assistant_memory：旧版字符串（16k 上限、4k 注入）+ 结构化条目（16k、100 条）
team memory：TeamAggregate.memory，提案/接受、key 取代、8k 预算
goal memory：无
recall：assistant_memory_read / team_memory_list 的 query/status/limit
        （子串匹配、有界、只读、不跨 scope）
journal / undo：容器内可选 journal（10 条；助手 16k / 团队 8k 字符），
        界面通过 assistant.memory.undo / team.memory.undo 精确撤销
memory UI：助手设置记忆面板 + 团队记忆面板，含变更日志撤销
自动 capture：可选（memoryAutoCapture 默认 false）；Goal 完成 ≤2 条团队
        proposed、worker 完成 1 条助手 private proposed，脱敏/去重/有界
语义召回 / FTS / 图关系：无
```
