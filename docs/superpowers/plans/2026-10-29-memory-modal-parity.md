# 记忆弹窗对齐计划（nightly OpenBot）

> 2026-10-29 · 先完全还原，再谈差异化。
> 形态：DSH 插件；UI 用 DSH Dialog/Button/Textarea/Settings 原语与 token。

## 一、目标

```text
助手设置 → 记忆 · N 条 → 记忆弹窗
与 OpenBot 的 AgentMemoriesModal 同等结构、交互、状态
```

## 二、弹窗结构

```text
header
  记忆
  + 新增
  × 关闭

说明区（有记忆时）
  记忆如何进入上下文
  已用 / 预算（8 KB）

新增 composer
  多行文本
  Cancel / Save
  Esc 取消
  Ctrl/Cmd+Enter 保存

上限提示
  达到上限时 + 禁用

错误
  inline role=alert

列表
  文本
  自动学习 / 手动
  日期
  essential / searchable
  用户控制 / Agent 控制

行内编辑
  文本域
  essential / searchable / automatic 三段
  Cancel / Save
  Esc 取消

删除
  行立即消失
  Undo toast
  超时才真正删除

清空
  底部 destructive 按钮
  确认对话框
  确认后清空所有（包括待删除）

空态
  说明 + 添加

loading
  loading 文案
```

## 三、后端必须补的字段

```text
inclusion: essential | searchable
user_controlled: 0 | 1
revision
```

现有字段：

```text
id / title / body / visibility / key / status
journal
```

新增语义：

```text
essential
  每次注入
  共享 8 KB 字节预算

searchable
  默认不注入
  按需检索

automatic
  用户交还给 Agent 自动选择
```

不能只做 UI 假值；没有字段就不显示这些段。

## 四、接口

```text
assistant.memory.get
  已有

assistant.memory.create / update / delete / clear
  已有

新增
  assistant.memory.selection
    返回 selections + usedBytes + budgetBytes
  assistant.memory.setInclusion
    { memoryId, inclusion, expectedRevision }
```

## 五、上下文与检索

P1：

```text
essential 序列化进 system/developer instructions
  8 KB 预算
  超出拒绝保存

searchable
  不注入
  P2 再加 search 工具
```

P2：

```text
FTS / 关键词检索
openbot.search_memories 等价工具
```

## 六、自动复盘

P3：

```text
每 20 回合 / 空闲 / 清空 / 线程关闭触发
只产 proposed 条目
用户采纳后生效（差异化，不自动应用）
```

## 七、范围

```text
本轮
  助手记忆弹窗
  inclusion / user_controlled / revision
  8 KB essential 预算
  Undo 删除
  清空确认

后置
  频道/团队记忆
  FTS 检索
  自动复盘
  侧栏常驻记忆
```

## 八、验收

```text
入口计数准确
弹窗结构与 OpenBot 一致
essential/searchable/automatic 可切换并持久化
8 KB 预算与上限可见、不可超
删除 Undo 不复活已清空记忆
清空确认
空/loading/limit/error 状态齐全
DSH 原语与 token；无新页面/overlay
```

## 九、顺序

```text
1. schema + service + transport（inclusion/revision/budget）
2. 弹窗 UI 重写
3. 删除 Undo / 清空
4. 验收 + 评审
5. 再谈 search / 自动复盘 / 差异化
```
