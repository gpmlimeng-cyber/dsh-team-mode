# 身份、记忆与权限边界决策

> 状态：已采纳 · 2026-10-22  
> 范围：单聊助手、团队成员、DM、多团队、Leader 换人、权限与记忆

## 背景

我们已经确定：

```text
assistantId / membershipId 稳定
sessionId 按上下文创建
DM 主会话独立
每个团队一个 membership Session
Assistant memory 全局
Team memory 按团队
```

但以下边界未定，会直接影响记忆 P0、Team Session 和恢复：

- assistant memory 是否进入团队
- 团队记忆谁写
- 同一助手多上下文并发写
- Leader 换人后的 Session 归属
- 团队权限与助手权限谁优先

## 决策

### D1：Assistant memory 分可见性，默认 private

```ts
MemoryEntry.visibility: 'private' | 'team-safe'
```

默认 `private`。

| 上下文 | 可读取 |
|---|---|
| DM 主会话 | 全部 assistant memory |
| 团队成员会话 | 仅 `team-safe` |
| Worker | 同所属主会话；只读 |

规则：

- `team-safe` 只放语言、代码风格、称呼、通用工作偏好
- 个人事实、私聊内容、敏感偏好默认 `private`
- 只有用户或助手主会话可以提升为 `team-safe`
- 团队不会看到条目标题或内容，除非明确标记

旧 `assistant_memory` 字符串迁移为一条 `private` core 条目；不自动进入团队。

### D2：团队记忆由成员 propose，Leader/user accept

```text
member → proposed
Leader/user → active
user → edit/archive
```

只有 `active` 且 `pin` 的核心条目进入 Team core。  
`proposed`、`superseded`、`archived` 不加载，但可搜索。

Team memory 只在当前团队成员 Session 中可见：

- 不进入 DM
- 不跨团队
- 成员退出后立即不可读写

Goal memory 是临时层；目标结束后只能显式提炼为 `proposed` Team memory，不自动升级。

### D3：跨上下文写入必须带 revision

Assistant memory：

```text
读取 → revision
写入 → expectedRevision
冲突 → MEMORY_REVISION_CONFLICT
```

Team memory：

```text
每条 entry 有 revision
同 key 新条目 supersedes 旧条目
旧条目保留历史
```

规则：

- 同一 assistant 的 memory 写入串行化
- 同一 team 的 team memory 写入串行化
- 不做最后写入者覆盖
- 冲突返回当前版本，由 Leader/user 决定

工具层必须暴露 `expected_revision`，不能只依赖服务层。

### D4：Leader 换人采用 Team Epoch，不 reparent

DSH 只在 create/resume 时接受 `parentAgent`，没有 reparent API。

因此：

```text
Team
├─ epoch
├─ teamSessionId
└─ memberships[].sessionId
```

Leader 换人：

```text
1. 旧 Team Session 归档为只读
2. epoch += 1
3. 新 Leader 创建新 Team Session
4. 旧 membership Session 归档，不 reparent
5. 新 membership Session 按需创建
6. 旧 epoch 的 active Goal/Task 转为 paused/blocked
7. 新 Leader 显式恢复或重新派发
```

禁止：

- 静默把成员 Session 挂到新 Leader 下
- 复用旧 Team Session 当新父级
- 让旧 epoch 的 attempt 继续写新 epoch 的任务

### D5：团队权限以团队成员的显式设置为准

DSH 权限预设是 session-pinned 的 bundle，无法可靠自动比较“谁更严格”。

因此：

```text
DM：使用 assistant.permissionPresetId
团队：使用 membership.permissionPresetId
```

规则：

- 加入团队时，membership 从 assistant 预设初始化
- 之后只有用户/团队 Owner 可以改 membership 权限
- 成员 Agent 不能改自己的权限
- Assistant 预设变化不追溯修改已有 membership
- 团队内不自动做 min(assistant, team)
- 每次启动显示实际生效权限

后续如增加团队级 ceiling，必须是显式配置和显式用户操作，不做隐式推导。

### D6：自动记忆默认关闭

```text
auto capture     默认 off
auto recall      默认 off
auto tidy        默认 off
```

自动整理只能写入 `proposed`，不能直接写 active。

开启后：

- 写入前 redact 敏感信息
- 不读取其他团队/私聊内容
- 不把其他 Bot 的猜测写成事实
- Goal 结束时最多提炼 2–5 条提议

### D7：上下文管理与记忆分离

```text
上下文管理：这次在做什么
记忆管理：跨对话应该记住什么
```

本阶段不做自定义上下文管家。  
长群聊需要时单独设计 Session 分段、checkpoint、handoff，不混入记忆层。

## 结果

```text
Assistant memory
├─ private       仅 DM
└─ team-safe     团队可用

Team memory
├─ proposed      成员提议
├─ active        Leader/用户接受，加载
└─ archived      历史，可搜索

Team epoch
├─ teamSessionId 当前 Leader Session
├─ memberships   当前 epoch 的成员会话
└─ old epoch     只读归档
```

## 实施顺序

```text
1. MemoryEntry + visibility + revision
2. Team memory propose/accept + journal
3. 工具层 expected_revision + 权限过滤
4. Team epoch（Leader 换人）
5. 自动 capture/recall 作为 opt-in
```

## 明确不做

- 不把全部 assistant memory 注入团队
- 不让成员直接覆盖团队核心记忆
- 不做最后写入者覆盖
- 不静默 reparent
- 不自动比较/合并权限预设
- 不默认开启自动记忆
- 不用记忆替代上下文压缩
