# 可自定义侧栏布局验证记录

- **日期：** 2026-10-26
- **范围：** 计划 `docs/superpowers/plans/2026-10-26-sidebar-layout.md` 的 Task 4（接入侧栏副作用、收敛重复扫描、全量检查、真机验证）
- **实现提交范围：** `src/client/sidebar.tsx`、`src/client/sidebar-layout-dom.ts`、`src/client/sidebar-layout-section.tsx`、本文件、`README.md`、`README_CN.md`
- **环境：** macOS，`/Users/limeng/DSH/团队/dsh-team-mode`，Node/npm 同仓库默认工具链；插件通过软链接 `~/.dsh/profiles/desktop/node_modules/@limeng/dsh-team-mode -> /Users/limeng/DSH/团队/dsh-team-mode` 装在 DSH Desktop（DSH NEXT `ai.deepseek.dsh.desktop.next`，pid 77473）的 desktop profile 里。

## 结论摘要

| 项目 | 结果 | 证据 |
|---|---|---|
| `npm run check`（架构守卫 + typecheck + 全部 Vitest + 生产构建） | **PASS（EXIT=0）** | 见「命令与退出码」 |
| 全仓唯一一份侧栏条目扫描实现 | **PASS（代码审计）** | 见「代码审计证据」 |
| 构建产物确实包含本任务的接入代码 | **PASS（产物字符串核对）** | 见「构建产物证据」 |
| 真机验证（重启 DSH 后逐条确认 6 条行为） | **未验证（全部 6 条）** | 见「真机验证矩阵」与「为什么没能真机验证」 |

## 命令与退出码

在仓库根目录实跑（输出重定向到 `/tmp/t4-check.log`）：

```bash
npm run check > /tmp/t4-check.log 2>&1; echo "EXIT=$?" >> /tmp/t4-check.log
```

关键输出（原文摘录）：

```
> @limeng/dsh-team-mode@0.4.0 check
> npm run guard:architecture && npm run typecheck && npm run test && npm run build

Agent Team architecture guard passed.
> @limeng/dsh-team-mode@0.4.0 typecheck
> tsc --noEmit
> @limeng/dsh-team-mode@0.4.0 test
> vitest run
 Test Files  63 passed (63)
      Tests  951 passed (951)
> @limeng/dsh-team-mode@0.4.0 build
> tsdown
 ✔ Build complete in 1500ms   (lib/client.js, 1.18 MB)
 ✔ Build complete in 1573ms   (lib/client.d.ts)
 ✔ Build complete in 1615ms   (lib/index.js)
EXIT=0
```

即：架构守卫通过、`tsc --noEmit` 无输出（通过）、63 个测试文件 / 951 个用例全绿（含本功能 12 个规划用例 + 5 个配置面用例）、`tsdown` 三个入口构建完成，**整条命令退出码 0**。

## 代码审计证据

1. **只有一份条目扫描实现。** 唯一的候选节点扫描在 `src/client/sidebar-layout-dom.ts`：

```bash
grep -rn 'role="button"' src --include='*.ts' --include='*.tsx'
# src/client/assistants/AssistantPanel.tsx:776:  role="button"          ← JSX 属性，不是扫描
# src/client/sidebar-layout-dom.ts:65:const CANDIDATE_SELECTOR = 'button, [role="button"], a[tabindex]'
```

   `sidebar-layout-section.tsx` 里 t3 自带的那份 `readSidebarEntries()`（含 `ORIGIN_CONTAINERS` / `CANDIDATE_SELECTOR` / `deriveKey` / `isToolLabel` 二次实现）已删除，改为 `import { readSidebarEntries } from './sidebar-layout-dom.js'`。

2. **容器选择器只剩 DOM 层与 sidebar.tsx 的既有用途。** `grep -rn '_panelList\|_footerActions\|_topStrip\|_logoRow\|_settingsArea' src tests` 的命中里，除 `sidebar-layout-dom.ts` 外只有 `sidebar.tsx` 的既有代码（滚动包装层定位 + 团队模式自己的底部区域插入），都不做条目枚举/去重，不构成第二份扫描逻辑。

3. **配置界面拿不到侧栏时不空白。** `discoverEntries` 每次扫描到非空条目就记进模块级 `lastEntries`；`readSidebarEntries` 在 `readSidebarRoot` 取不到根、或本次扫描为空时返回该快照。侧栏（`sidebar.tsx` 的 MutationObserver 轮次）会持续刷新快照，因此设置页即使晚于侧栏挂载/侧栏临时不在视口内，也仍能列出条目，不会退化成「当前侧栏没有可分配的条目」。

4. **不会自激的重新应用。** `applySidebarLayout` 位于 `MutationObserver` 驱动的 `ensure()` 中，而 `applyLayout` 本身会重写宿主 DOM，因此以 `plan` 签名（`slot:key` 列表 + 隐藏列表）为门控：签名不变就只跑 `syncMirrorState`（幂等）。原生节点被 React 换掉（`isConnected === false`）时强制重新应用。注释在 `sidebar.tsx` 里写明「镜像先渲染、再隐藏原生」的顺序不可交换。

5. **事件与清理。** `useEffect` 内注册 `dsh-team-mode:sidebar-layout-changed` 监听（重置签名 + `schedule()`），清理函数里 `removeEventListener` + `restoreNative(hosts, document)`，卸载后原生节点不会继续保持 `visibility: hidden`。

## 构建产物证据

`lib/client.js` 由本次 `npm run check` 重新构建，字符串核对（`grep -c -F`）：

```
dsh-team-mode:sidebar-layout-changed: 1
data-dsh-sidebar-mirror: 2
data-dsh-sidebar-layout-hidden: 1
data-dsh-sidebar-submenu: 3
```

即构建产物里确实带着 Task 4 的接入代码（事件名、宿主标记、隐藏标记、下菜单夹层标记）。

## 真机验证矩阵

计划 Task 4 Step 4 的 6 条行为，**全部未验证**（没有在真实 DSH 界面里点过，不做任何推测性描述）：

| # | 计划要求的行为 | 结果 |
|---|---|---|
| 1 | 设置 → 团队 → 侧栏布局，列表里能看到「插件」「自动化任务」及第三方条目 | **未验证** |
| 2 | 把「插件」分到 `footer`：顶部插件行消失，底部账户行右侧出现可点击的「插件」按钮，点击能打开插件页 | **未验证** |
| 3 | 把「自动化任务」分到 `submenu`：工作区下方出现新夹层；全部移走后夹层消失且不留空白 | **未验证** |
| 4 | 选「隐藏」：条目消失，配置里仍保留该项 | **未验证** |
| 5 | 切一次界面语言：条目回落原位，不出现空白 | **未验证** |
| 6 | 折叠侧栏成 rail：镜像不溢出 | **未验证** |

另外，`docs/superpowers/plans/2026-10-26-sidebar-layout.md` 的 Review Focus 5 条（指向已消失条目的 key、渲染中途消失、空下菜单高度、语言切换 key 失配、rail 折叠）同样**未验证**，只有纯函数层的用例覆盖到其中部分逻辑（如「指向未知条目不隐藏任何节点」「镜像没渲染成功就不隐藏」）。

## 为什么没能真机验证

两个具体阻塞，都不是推测：

1. **唯一的 DSH 实例正是运行本次任务的宿主。** 本机只有一个 DSH Desktop 进程（pid 77473），其 desktop profile 里软链的就是本仓库。计划要求的「重启 DSH」等于杀掉承载本任务/本会话的宿主进程，会让验证本身中断，因此没有重启；`lib/client.js` 虽已重建，但**没有对已加载的渲染进程窗口做重载**，所以当前运行的客户端仍是旧 bundle。
2. **Web GUI 拒绝外部浏览器。** 直接请求运行中的 GUI 地址得到认证拒绝，无法用独立浏览器加载新构建做端到端验证：

```
$ curl -sS -i -m 5 http://127.0.0.1:61348/
HTTP/1.1 403 Forbidden
cache-control: no-store
Browser access is disabled
```

因此本次只交出了「命令级 + 产物级 + 代码审计级」证据，界面行为一条都没有记为通过。

## 复验步骤（重启 DSH 后执行）

重启 DSH（或重载窗口让新 `lib/client.js` 生效）后，按上表 1–6 逐条确认，把结果替换掉「未验证」。若要留下可复核的证据，建议按 `docs/testing/2026-10-25-e2e-report.md` 的格式记录截图名与 DOM 断言（例如镜像按钮的 `data-dsh-layout-key`、原生行的 `data-dsh-sidebar-layout-hidden`、下菜单夹层的 `data-dsh-sidebar-submenu[hidden]`）。同时在 设置 → 团队 → 侧栏布局 里用「恢复默认」清掉验证中写入的分配，避免污染用户配置。
