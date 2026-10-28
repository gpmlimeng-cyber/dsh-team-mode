# Hermes 对标规划：Bot Mode + bot-forge

> 2026-10-28 · 分开对标，不混成一个功能清单。
> 结论：Bot Mode 对标“同事层”，bot-forge 对标“创建层”；团队交付仍是我们的差异。

## 一、Bot Mode 对标

### 它提供

```text
Bot = profile
每个 Bot 永久 Bot Chat
roster：头像 / 未读 / 活跃 / 分组 / 隐藏 / 搜索
每个 Bot 的 Routines
群聊 2–6 个 Bot，@mention / @all / @user
Bot 之间 DM
头像 / 声音 / 多机器
CLI 完全等价
```

### 我们已有

```text
助手 / 单聊 / 团队
团队线程
记忆 / 权限 / 任务 / 评审
通知 / 今天
分组 / 批量 / 导出
```

### 我们缺

```text
1. 永久同事 Chat 的明确入口
   点同事就回到同一个关系
   /new 不拆关系

2. roster 分组
   自定义 section
   隐藏 / 恢复
   未读 / 最近消息

3. 每个同事的 routines
   定时任务挂在同事旁

4. 群聊讨论
   2–6 个同事
   @mention 轮次
   needs-you

5. Bot 之间 DM
   同事直接找同事

6. 同事形象
   声音 / 多机器（后置）
```

### 借鉴优先级

```text
B1 同事主页 + 永久 Chat 入口      ← P0 同事主页
B2 roster 分组 / 隐藏 / 未读      ← 现有分组增强
B3 同事 routines                  ← 宿主调度接入
B4 群聊讨论                       ← 后置
B5 Bot DM                         ← 后置
B6 声音 / 多机器                  ← 云端阶段
```

### 不借鉴

```text
每 Bot 一个 gateway 进程
Desktop 专属 metadata
2–6 人上限
多机器 relay（先本地）
```

---

## 二、bot-forge 对标

### 它提供

```text
一句话造 Bot
一句话造团队（lead + ≤6 specialist）
创建前测试，失败整只回滚
SOUL.md / memory / tools / skills / routines / Bot Chat / gateway
waiting_on_you 聚合
每个 Bot 私有 journal
share_agent / import_agent（.botforge.json，secret scan）
安装医生
回复状态 emoji
```

### 我们已有

```text
3 个团队模板
分区批量设置
分区导出/导入
团队任务 / 评审 / 记忆
今天 / 等你确认
```

### 我们缺

```text
1. 一句话创建同事
2. 一句话创建团队
3. 每个同事的 journal
4. waiting_on_you 按同事聚合
5. 分享模板的 secret scan / 版本
6. 安装医生
7. 回复状态 emoji
```

### 借鉴优先级

```text
F1 5 个同事预设                  ← 已对齐 P4
F2 一句话创建同事（需用户确认）
F3 一句话建团队（模板 + 审批）
F4 同事 journal                  ← P1 行动轨迹
F5 waiting_on_you 按同事聚合      ← 今天增强
F6 分享模板 secret scan / 版本
F7 安装医生
F8 回复状态 emoji
```

### 不借鉴

```text
Agent 自己创建 / 删除 Bot 不受控
每 Bot 独立 gateway
邮件通知
直接写 Desktop 内部 metadata
```

---

## 三、整合后的顺序

```text
第一波 同事层
  identity title/blurb（进行中）
  P0 同事主页
  P3 能力/审批分栏
  P4 5 个预设
  永久同事 Chat 入口确认

第二波 创建与证据
  F2 一句话创建同事（确认后创建）
  F4 / P1 同事 journal
  F6 分享模板 secret scan

第三波 组织
  F5 waiting_on_you 按同事聚合
  B2 roster 分组 / 隐藏 / 未读
  F7 安装医生

第四波 讨论
  B4 群聊讨论
  F3 一句话建团队
  B5 Bot DM

第五波 本地电脑 / 云端
  L1 本地浏览器
  L2 团队容器
  B6 声音 / 多机器 / 云端
```

## 四、现在不该做

```text
群聊讨论
Bot DM
多机器
每 Bot gateway
agent 自建 Bot 不受控
```

## 五、对齐状态

```text
已对齐：
  P0 放置：现有详情顶部摘要块
  P0 密度：状态 + 当前 + 最近 + 三个动作
  P1 粒度：任务 + 文件 + 测试
  P2：暂停 + 人工在会话操作 + 恢复
  P3：只读摘要 + 跳设置
  P4：5 个固定预设

待对齐：
  永久同事 Chat 是否需要独立入口
  一句话创建是否需要二次确认
  群聊讨论是否进入本地单机 v1
```

## 六、验收总目标

```text
用户点开一个同事
  1 屏知道：在等什么 / 在做什么 / 最近做了什么
  1 键回到同一个对话

用户创建一个同事
  选预设或说一句话
  确认后创建，失败可回滚

用户看一次交付
  任务 / 文件 / 测试 / 评审都有证据
```
