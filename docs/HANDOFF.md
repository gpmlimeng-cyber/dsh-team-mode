# 交接文档 / Handoff

> 2026-10-23 · 换机器继续开发时先读这份

## 当前状态

```text
仓库：~/dsh-team-mode
分支：main
远程：https://github.com/gpmlimeng-cyber/dsh-team-mode
DSH：0.2.1-rc.2
版本：0.4.0
npm 发布：未发布
外部部署：未部署
```

最后阶段是 `release-readiness`，已收尾：

```text
95a8f4e chore: prepare 0.4.0 release readiness
25054f9 fix: keep handoff out of the release package
88d39ca fix: mount global overview in the live team detail view
c0df2c9 feat: add autonomous ops budgets and idle routine
```

安装/打包已验证，但未 publish、未部署、未打 0.4.0 tag。
HANDOFF 不随包发布；当前树 release:smoke 为 43 files / 7.6 MiB（pulled docs 增加条目）。

## 完成后新增能力（pull 最新代码）

```text
Team Turn Coordinator：每团队单 active turn、Leader-first、@ 路由、queued 投递
Assistant DM checkpoint + handoff：手动检查点、新主会话接管
Team main agent panel + surface switch：团队主 Agent 面板、原生/团队视图切换
Global overview：团队/助手全局总览，已挂到「详情」页
Team collaboration overview / sidebar status：团队概览与侧栏状态
```

## 已完成里程碑

```text
f1340b0  重载主会话所有权冲突显式恢复
e7acf6f  task attempt fencing
8be4ce8  Goal 层 + 团队管家模式
d0bd070  助手/团队结构化记忆
826e17d  membership → assistantInstance 链接
572a502  记忆 UI + Goal/DAG UI
65030f8  task claim + member inbox + thread context
ea8baf3  归档屏障 + recovery generation
bdac60a  Team Epoch（Leader 换人）
2fa13b8  quality gates + review verdict
28aa260  member tool policies
```

另有多份 docs commit：

```text
c974a71  身份/记忆/权限边界
3f442f2  Raft 借鉴
1960d26  竞品差距
0f0ff6d  执行模型策略
```

## 核心设计

```text
Team Session（Leader）为父
成员为持久 membership Session
单聊助手保留独立 DM 主会话
assistantId / membershipId 稳定
sessionId 按上下文创建
```

关键规则：

- Team Epoch：Leader 换人后旧 Session 全量归档，不 reparent
- task attempt：成员更新必须带当前 attempt
- quality gates：verification/review 完成必须 verdict=pass
- memory scope：assistant / team / goal / working / transcript 分离
- tool policies：成员只拿到 baseline ∩ allow，Leader 不受限
- claim / inbox / thread：成员可领取 ready task，收件箱只读，消息带 task thread
- 团队管家：direct / single / orchestrated 三模式

## 新机器启动

```bash
git clone https://github.com/gpmlimeng-cyber/dsh-team-mode.git
cd dsh-team-mode
npm ci
npm run check
```

本地安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-team-mode
# 或使用 npm pack 后的 tarball
```

安装/启动细节：

- `docs/installation.md`
- `docs/migration-0.2.1.md`
- `README_CN.md`

## 未开始规划（尚未写实现计划）

以下项目只有方向/架构说明，没有 AgentTeams 实施计划；下次继续时先补 plan。

| 项目                                                 | 当前资料                        | 状态   |
| ---------------------------------------------------- | ------------------------------- | ------ |
| Context Steward 自动化（阈值压缩/团队 handoff） | `COMPETITIVE-GAPS.md` | 部分：Assistant DM 手动 checkpoint 已完成 |
| Group Chat Turn Engine（管理员先答/顺序/@/迟到回复） | Team Turn Coordinator | 已完成基础版，迟到回复/审批胶囊待补 |
| Autonomous Ops（routines/reminders/budget/park）     | `COMPETITIVE-GAPS.md` + roadmap | 已完成 Phase 2 |
| Memory Automation（capture/recall/tidy/journal）     | `MEMORY-ARCHITECTURE.md` P2/P3  | 未开始 |
| DSH Ecosystem Reuse（能力发现/成员策略/权限边界）    | `COMPETITIVE-GAPS.md`           | 未开始 |
| Task reminders / follow-up                           | roadmap P2                      | 未开始 |
| 新成员有界历史注入                                   | roadmap / RAFT                  | 未开始 |
| 成员私有 workspace                                   | roadmap / RAFT                  | 未开始 |
| F8 记忆配额硬化                                      | release review residual         | 未开始 |
| quality-gate findings 邮件措辞                       | quality-gates review residual   | 未开始 |
| multi-host 评估                                      | roadmap P2                      | 未开始 |

## 规划文档索引

```text
docs/TEAM-MODE-ROADMAP.md
docs/COMPETITIVE-GAPS.md
docs/MEMORY-ARCHITECTURE.md
docs/DECISIONS-IDENTITY-MEMORY.md
docs/RAFT-ADOPTION.md
docs/TEAM-STEWARD.md
docs/EXECUTION-POLICY.md
docs/HANDOFF.md
docs/superpowers/plans/*.md
```

## 未完成工作

### 高优先级（竞品差距）

```text
1. Context Steward
   压缩 / 分段 / checkpoint / handoff

2. Group Chat Turn Engine
   管理员先答 / 顺序发言 / @ / 迟到回复 / 审批胶囊

3. Autonomous Ops
   routines / reminders / budget / busy park

4. Memory Automation
   capture / recall / tidy / journal

5. DSH 生态复用
   能力发现 / 成员策略 / 第三方插件权限边界
```

完整分析：

- `docs/COMPETITIVE-GAPS.md`
- `docs/TEAM-MODE-ROADMAP.md`

### P2 具体项

```text
Task reminders / follow-up
新成员有界历史注入
成员私有 workspace / scratch
auto-capture / auto-recall（opt-in）
F8 记忆配额硬化
context segmentation / checkpoint / handoff
quality-gate findings 邮件措辞
multi-host 评估
```

## 已知问题 / 残留风险

```text
dsh-plugin-dev check 仍 exit 1：
  3 个 /client 子路径 checker false positive
  窄 peer 范围与 checker 期望不一致
  已在 CHANGELOG / RELEASE 文档说明

tarball 条目 0600 / uid0
5 张 PNG 约 8 MB
内部策略文档仍随包发布
4 个相对链接在 tarball 中断裂
CHANGELOG 对 Config schema 的描述不准确
CI 尚未在 GitHub 实跑
headless 不能激活 web-only services
tar 内容随构建有少量非确定性（CSS module key 顺序）
```

## AgentTeams 状态

- 团队运行状态在本地 `.agent-teams/`，已 gitignore
- 换机器不会带过去
- 需要继续自动开发时，按 `docs/superpowers/plans/` 重建团队
- 最近 release 团队是 `release-readiness`

## 模型与预算

```text
执行成员：xiaomi-token-plan-cn / mimo-v2.6-flash（优先）
回退：deepseek-account / deepseek-flash
Reviewer：deepseek-account / deepseek-flash
```

mimo 在本机出现过 TRANSPORT 断连；release 团队已回退 deepseek。  
详见 `docs/EXECUTION-POLICY.md`。

## 安全

- 会话中曾出现 GitHub PAT；请在 GitHub 设置中撤销/重新生成
- 不要把 token 写进仓库、文档或脚本
- 发布前确认 `npm pack` 内容无 `.env`、密钥、绝对路径

## 下次建议顺序

```text
1. 先跑 npm run check / release:smoke
2. 确认最新 commit（当前 88d39ca）
3. Task reminders + Autonomous Ops Phase 2 已完成
4. 下一步：Memory Automation（capture/recall/tidy/journal）
5. 再做 Context Steward 自动化 / DSH 生态
```

不要先做多 Host、云部署或外部 npm publish。