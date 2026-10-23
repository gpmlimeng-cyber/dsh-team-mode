# 安装与启动

[文档首页](./README.md) · [下一篇：助手库](./assistants.md)

## 环境要求

- Node.js `22.19.0+` 或 `24.0.0+`
- DeepSeek Harness `0.2.1-rc.2`
- Agent Team `@limeng/dsh-team-mode` `0.4.0`
- `pnpm` 已加入终端 `PATH`（`dsh plugin` 会把安装动作转发给 pnpm）

检查版本：

```bash
node --version
pnpm --version
```

如果没有 pnpm：

```bash
npm install -g pnpm
```

## 从本地压缩包安装（推荐）

在仓库根目录打包，再安装到当前 Profile：

```bash
npm install
npm run build
npm pack --pack-destination /tmp
npx @deepseek-ai/dsh plugin --profile web add /tmp/limeng-dsh-team-mode-0.4.0.tgz
```

文件名中的版本号可能不同，请按 `npm pack` 的实际输出替换。`npm pack` 只生成 `.tgz`，不会发布到 Registry。

## 从本地目录安装（推荐）

适合持续开发：先构建，再把目录本身加入 Profile。

```bash
npm install
npm run build
npx @deepseek-ai/dsh plugin --profile web add /absolute/path/to/dsh-team-mode
```

桌面版也可以使用插件管理器安装本地 bundle 目录。安装后启动：

```bash
npx @deepseek-ai/dsh web
```

终端通常会输出：

```text
dsh web: http://127.0.0.1:3080
```

在浏览器打开该地址即可。

## 从 npm 安装（尚未发布）

`@limeng/dsh-team-mode` 目前**没有发布到 npm Registry**：`npm view @limeng/dsh-team-mode` 返回 `404`。发布之后才能使用：

```bash
npx @deepseek-ai/dsh plugin --profile web add @limeng/dsh-team-mode@0.4.0
```

在发布之前，请使用上面的本地压缩包或本地目录安装方式。

## 使用官方 npm Registry

如果 `npm login` 或安装命令显示了第三方镜像地址，可以把用户级 Registry 改回 npm 官方地址：

```bash
npm config set registry=https://registry.npmjs.org/ --location=user
npm config get registry
```

第二条命令应输出：

```text
https://registry.npmjs.org/
```

## 确认安装成功

启动 Harness 后检查两个入口：

1. 页面左侧出现用于打开工作台的悬浮 **团队** 按钮；按钮可拖动并会记住位置。
2. **设置 → Agent 团队** 中出现助手库。

## 安装或更新后重启

如果 Harness 已经运行，请先在原终端按 `Ctrl+C` 停止，再重新执行：

```bash
npx @deepseek-ai/dsh web
```

浏览器页面没有更新时，再刷新页面。插件不依赖修改 Harness 源码。

## 卸载插件

如果 Harness 正在运行，先在原终端按 `Ctrl+C` 停止服务，然后执行：

```bash
npx @deepseek-ai/dsh plugin --profile web remove @limeng/dsh-team-mode
```

该命令会从 `web` Profile 中移除插件依赖及其配置层。命令完成后重新启动 Harness，侧边栏和设置中的 Agent Team 入口将不再加载。

卸载插件不会修改 DeepSeek Harness 源码，也不会删除团队 Workspace 中的文件。插件自身保存的助手模板、团队记录和 Session 引用是否继续保留，取决于 Harness Profile 数据目录是否仍存在；如需彻底清理这些数据，请先备份并自行处理对应 Profile 数据目录。

## 发布前本地校验（维护者）

发布动作不在本仓库的自动化范围内：CI 与本地脚本都**不会**执行 `npm publish`、部署或打标签。

```bash
npm ci
npm run check
npm run release:smoke
```

- `npm run check`：架构守卫 → `tsc --noEmit` → Vitest → 生产构建。
- `npm run release:smoke`：`npm pack` 后校验必需文件、排除开发/密钥文件、扫描绝对路径与凭据，再把 tarball 安装到一个临时 `DSH_HOME` 并确认 `lib/client.js` 可解析。没有 `dsh` 命令时自动跳过安装段。
- CI（`.github/workflows/ci.yml`）在 Node 22/24 上执行同样的检查；pack/install smoke 使用 Node 22。
- `dsh-plugin-dev check` 的已知例外（3 个 `/client` 子路径误报、peer 范围收紧、npm/pnpm 与多语言 README 警告）记录在 [CHANGELOG](../CHANGELOG.md#known-dsh-plugin-dev-check-exceptions) 与 [0.4.0 发布复检](./RELEASE-2026-10-20.md#8-040-发布复检2026-10-23) 中。

## 下一步

继续阅读 [助手库](./assistants.md)，创建第一个 Leader 和成员助手。
