# 执行模型策略

> 2026-10-23 · 预算受限时的 AgentTeams 模型路由

## 默认策略

```text
Captain（当前会话）：保持当前模型
执行成员（auditor / implementer）：
  provider: xiaomi-token-plan-cn
  model:    mimo-v2.6-flash

思考 / 验证 / 评审（planning / verifier / reviewer）：
  provider: deepseek-account
  model:    deepseek-flash
  目的：保留分析、验证与评审质量
```

如果 mimo flash 路由不可用：

```text
回退 deepseek-account / deepseek-flash
并在团队报告中说明回退原因
```

## 为什么

- 执行类任务量大、上下文长，优先低成本模型
- Reviewer 保持独立质量和判断
- Captain 负责规划与协调，不额外切换
- 不让预算限制降低最终验收标准

## 配置位置

DSH profile 已配置：

```yaml
llm-pi-ai:
  providers:
    xiaomi-token-plan-cn:
      models:
        - id: mimo-v2.6-flash
          name: MiMo-V2.6-Flash
```

AgentTeams 创建成员时使用：

```text
provider: xiaomi-token-plan-cn
model: mimo-v2.6-flash
```

## 适用时间

从下一个团队开始生效。  
已经在运行的团队不中途换模型，避免截断 in-flight 任务。

`context-steward` 团队在策略明确前创建，执行成员仍是 deepseek-flash；  
该团队完成后，新团队按本策略创建。

## 例外

- 高风险架构/安全评审可临时使用更强模型，但需说明原因
- 模型不可用或限流时按回退策略处理
- 实际外部部署仍需用户确认

## 语言约定

面向用户的团队信息全部使用中文，确保非技术用户能直接看懂：

- 团队成员名、角色名
- 任务主题、描述、验收标准
- Goal 标题、目标、验收
- 团队消息摘要、活动文案
- 审批、状态、错误提示

内部代码标识、API 字段、日志键名保持英文，不改协议。

已运行的英文团队不强制中途改名；后续新建团队、成员和任务必须使用中文。
