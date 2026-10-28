# 剩余优化清单

> 2026-10-29 · 只做减面与一致性，不再加新能力。
> 前置：coworker-create 收尾。

## P0 · 界面减面（surface-cleanup）

### 1. 公告合并

```text
保留群公告
分区共享指令 → 分区公告
同一个入口 / 编辑器 / 作用域切换
旧 brief 数据可见、可编辑
删除独立“共享指令…”菜单
```

### 2. 团队活动板并进任务详情

```text
删除独立活动板入口
任务详情里保留事件时间线
不再有两套板
```

### 3. 全局概览去重

```text
只留入口
不再重复今天/团队列表
```

## P1 · 真值与文案

### 4. 任务完成/失败发布 change

```text
现在只发 conversation
已打开同事主页可能停在旧状态
→ 完成/失败也发 change
```

### 5. footer 徽标跟随 conversation

```text
团队审批只发 conversation
徽标可能延迟
→ 订阅 conversation 或页面可见时刷新
```

### 6. 任务级 pause/restore 按钮

```text
transport 已有
任务对话框没有按钮
→ 补原生按钮
```

### 7. 已归档文案

```text
今天仍写“暂不支持恢复”
instance restore 已存在
→ 改为“团队暂不支持恢复；助手可恢复”
```

### 8. 模板 description → blurb

```text
模板建助手不带 blurb
→ 在 P4 预设/模板创建时映射
不自动复制超长 description
```

## P2 · 去死代码

### 9. TeamPanel / TeamWorkbench

```text
T1 已确认是死代码
公告工具栏入口不可达
→ 删除或重新接入，二选一
```

### 10. 旧 brand / steward host 残留

```text
BRAND_HOST_ID / STEWARD_HOST_ID 已删
检查 CSS / docs 残留
```

## P3 · 运行边界

### 11. F8 容量竞态

```text
liveWorkerCount 不计 in-flight start claim
点击不同 queued row 可瞬时超限
→ claim 计入容量，或 admission 等 drain
```

### 12. R1 pause/markStarted 竞态

```text
t6 曾记录
t8 已做条件写
→ 复核是否仍有关窗
```

### 13. R2 同毫秒排序

```text
createdAt 相同时按 UUID
→ 增加单调序号或 id 时间前缀
```

## P4 · 后置

```text
群聊讨论
频道 owner / delegation
每个同事 routines
安装医生
附件 / reaction
本地浏览器 / 容器
多 provider
```

## 不做

```text
模式切换保持不动
Electron 桌面
默认 full-access
第二套权限系统
第二套聊天
```

## 验收

```text
每个优化点单独提交
有回归测试
npm run check 绿
不引入新入口
```
