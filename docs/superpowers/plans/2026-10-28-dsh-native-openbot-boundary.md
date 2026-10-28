# 固定 DSH 插件形态下的 nightly OpenBot 对标边界

> 2026-10-28 · 前提：产品形态不变，始终是 DSH 插件。
> 结论：不做 Electron 桌面、不接 ACP CLI 全家桶、不内嵌浏览器；
> 在 DSH 能力范围内做“本地 AI 同事工作台 + 团队交付”。

## 一、形态边界

### 我们保留

```text
DSH Web / 宿主 UI
插件槽位 + 原生控件
DSH Session / 权限 / 审批 / 工具
本地数据
单机优先
```

### 我们不做的

```text
Electron 桌面应用
Codex / Claude / Grok / Cursor CLI 进程
自带 provider runtime
内嵌 Chromium + CUA
移动端 / 远程桌面
账号 / 团队隧道
```

这些是宿主或另一个产品形态，不是插件能补的。

## 二、能对标的，分四层

### L1 同事层（现在）

```text
持久同事
同事主页
永久同事 Chat
waiting_on_you
能力 / 审批分栏
一句话创建 + review
```

### L2 工作区层

```text
每个单聊同事独立 workspace
团队仍共享团队 workspace
文件不串
```

DSH 已有 workspace 概念；插件负责分配与展示。

### L3 运行控制层

```text
FIFO 队列
pause / resume / cancel
Stop / Reassign / Archive / Restore
崩溃恢复
一个任务一个 owner
显式 delegation
```

这是当前最大差距，也是插件能做的。

### L4 上下文层

```text
每个同事监控 context
阈值触发原生 /compact
压缩后关系不变
```

不造第二套压缩器。

## 三、明确不做或后置

```text
多 provider CLI        宿主能力，后置
内嵌浏览器 / CUA       宿主能力，后置
移动端 / 远程          另一个产品形态
账号 / 团队隧道        另一个产品形态
默认 full-access       安全上不做
```

## 四、调整后的路线

```text
当前
  同事主页
  永久同事 Chat
  waiting_on_you

下一步
  单聊同事独立 workspace
  队列 + Stop/Resume/Cancel
  Reassign / Archive / Restore
  自动 compact

再下一步
  一句话创建 + review
  同事 journal
  频道 owner / delegation 控制面

后置
  本地浏览器（若宿主提供）
  多 provider（若宿主提供）
```

## 五、产品语言

```text
不是“OpenBot 的 DSH 版”
是“DSH 原生的本地 AI 同事工作台”
```

差异：

```text
OpenBot  独立桌面 + 多 CLI + 浏览器
我们     DSH 内 + 原生审批 + 团队交付证据
```

## 六、验收

```text
同事点开有固定关系
同事有独立工作目录
任务可暂停/恢复/重派
上下文自动压缩不丢关系
创建同事先 review
所有动作走 DSH 权限
```
