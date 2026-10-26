# 对齐 MausBot 模式 — 策划

> 2026-10-26 · 目标插件 `@limeng/dsh-team-mode` · 状态：待评审
> 依据：`~/DSH/_ext/OpenMausBot`（Bot/Group/Section 三个模型 + section-context）

## 一、差距：我们和 MausBot 到底差在哪

MausBot 的模型是三层：**Section（部门）→ Bot（机器人）→ Thread（会话）**。我们目前只有前两层，且第二层是单会话。

| 能力 | MausBot 的实现 | 我们的现状 |
|---|---|---|
| 分区 | `AppState.sections: string[]` + 每项 `section` | ✅ 刚做完（视图级分组） |
| **分区共享指令** | `server/section-context.ts`：每区一段 `text`（≤24KB）+ `memoryKeys` 保证改名不丢记忆；**明确禁止 agent 写入** | ❌ 无 |
| **机器人 = 多会话** | `Bot.threadId`（主）+ 更多 thread，每个可绑 `cwd`；菜单「New thread in a working folder…」 | ⚠️ 半成品：`mainSessionId` + `retiredMainSessionIds`（只隐藏、不可见、不能新建并行） |
| 机器人设置批量套用 | `Set for all bots in this department…`，逐台应用、被拒的列出原因 | ❌ 无 |
| 分区导出/分享 | `Share department…`（bots + 共享指令 + skills） | ❌ 无 |
| 群组聊天 | `Group.memberIds` + 默认响应者 + 公告 | ✅ 我们的团队（更强：Leader/任务/收件箱） |

结论：**我们缺的不是"分组"，是分区共享指令和会话容器这两层。**

## 二、分四期做，每期独立可交付

### P1 · 机器人会话容器（对齐的核心）

让一个助手拥有**多条可见会话**，而不是"一条主会话 + 隐藏历史"。

- 数据：助手实例加 `threadSessionIds: string[]`（有序）；`mainSessionId` 保留为默认打开项。
- 已有地基：`retiredMainSessionIds` 证明这套关系我们能存、能迁；`assistantSession` 记录已在用。
- UI：助手行可展开显示其会话列表（第三层），行菜单加「新建会话」「在工作目录中新建…」。
- 风险与对策：
  - **身份漂移**（同一助手在不同会话里状态不同）→ 协调者/Leader 判定仍以**实例**为准，不以会话为准；
  - **第三层树太深** → 默认折叠，只记住上次展开；不展开时与现状一致。

### P2 · 分区共享指令（部门记忆）

- 数据：`sidebar_groups` 记录从 `string[]` 升级为 `{ name, brief, memoryKey, updatedAt }[]`（迁移：旧字符串转 name）。
- 注入：会话的系统提示里按"该团队/助手所属分区"注入 `brief`，与现有 `COORDINATOR_DUTIES` 同一个 section 机制。
- **硬约束**：`brief` 只能用户写，agent 的任何工具都不得写入——MausBot 在文件头就写了这一条，理由是"被污染的机器人不能给全组播种指令"，我们要照抄。
- 验收：改动 brief 后，该分区成员的下一轮系统提示含新内容；非该分区成员不含。

### P3 · 批量设置

- 分区菜单加「为本分区所有机器人设置…」：挑一个字段（模型/思考等级/权限预设），逐条应用，**被拒的跳过并列出原因**（MausBot 的语义）。
- 依赖 P2 的分区设置入口；不依赖 P1。

### P4 · 导出/分享分区

- 导出：分区名 + brief + 成员快照（不含密钥、不含对话）为一个 JSON；导入时重名加序号。
- 这是产品方向问题，建议放最后，且单独评审。

## 三、建议顺序

**P1 → P2 → P3 → P4**。

理由：P1 是你这次要的"模式对齐"本体；P2 便宜且立刻有用（团队共享一段规范）；P3 依赖 P2 的入口；P4 应先想清楚分享的边界。

## 四、不做的

- 不搬 MausBot 的 `soul`/吉祥物/颜色体系。
- 不做跨设备同步之外的能力。
- 不把我们的团队降级成 MausBot 的 Group（我们的 Leader/任务/收件箱更强）。
