# 记忆之后的五项对齐排期

> 2026-10-27 · 状态：排队（等 `memory-gaps` 的 t12/t13 收尾后开新团队）

## 顺序

```text
1. 分区共享指令       P0  先做
2. 分区批量设置       P1
3. 宿主 usage 核对    P1  只读调查，先于用量面板
4. 分区导出/导入      P2
5. 团队公告           P3  可延后
```

依赖：

```text
1 → 2
3 独立
1 + 2 → 4（导出要包含 brief）
5 独立
```

## 1. 分区共享指令

目标：一个 sidebar group 一段 user-authored brief，注入该 group 下团队/助手的系统提示。

数据：

```ts
SidebarGroup = {
  name: string
  brief: string
  memoryKey: string
  updatedAt: number
}
```

硬约束：

- 旧 `string[]` 幂等迁移，保序、保名。
- 只有用户/transport 能写 `brief`；任何 agent tool 不得写。
- 长度上限 24 KB，UI 目标 4 KB。
- 只注入该 group 的成员，无跨组泄漏。
- 改名不丢 brief（memoryKey 稳定）。

验收：

- 改 brief 后，该组成员下一轮系统提示含新内容。
- 非该组成员不含。
- 空 brief 不产生空 section。
- 旧数据加载正常。

现有计划：`2026-10-26-sidebar-group-brief.md`。

## 2. 分区批量设置

目标：对分区内所有助手批量改模型 / 思考等级 / 权限预设。

语义：

- 逐条应用，不做整体回滚。
- 被拒绝的列出原因，其余继续。
- 只影响之后的会话，不改已有会话的运行中配置。

验收：

- 选 3 个助手改模型，成功 2、拒绝 1，UI 列出被拒项与原因。
- 不碰分区外助手。

## 3. 宿主 usage 核对（只读，不实现）

先回答：

```text
DSH 是否已有 token / 费用 / 用量 API？
按 assistant / team / session 聚合是否可得？
```

结论只有两种：

- 有：做只读用量入口，按助手/团队聚合 + 跳转，不建统计库。
- 没有：关闭该项，不在插件里自建计费。

## 4. 分区导出/导入

导出 JSON：

```text
group name + brief + members snapshot + skills
```

不含：

```text
密钥、API Key、对话内容、Session 历史
```

验收：

- 导出后在另一实例导入，分区名、brief、成员、技能恢复。
- 重名加序号，不覆盖。
- 导入前显示将创建/跳过的条目。

## 5. 团队公告

目标：团队页顶部一条当前公告，Leader/用户可写，成员只读。

优先级低于分区 brief；团队记忆已能承载长期约定。做时只需一条公告，不要做公告历史/已读回执。

## 不做

```text
soul / reply style 分层
创建期记忆预置
MausBot Markdown 记忆目录
自建 analytics / 计费库
浏览器 / 电脑 / 连接器 / 语音
reportsTo 逐级汇报
```

## 下一团队建议

```text
group-brief      1
group-batch      2（等 1）
usage-audit      3（只读，可并行）
group-share      4（等 1/2）
announcement     5（最后）
```
