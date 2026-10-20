# 安装与启动

[文档首页](./README.md) · [下一篇：助手库](./assistants.md)

## 环境要求

- Node.js `22.19.0+` 或 `24.0.0+`
- DeepSeek Harness `0.1.1-rc.2`
- Agent Team `0.1.2`
- `pnpm` 已加入终端 `PATH`

检查版本：

```bash
node --version
pnpm --version
```

如果没有 pnpm：

```bash
npm install -g pnpm
```

## 从 npm 安装

在任意目录执行：

```bash
npx @deepseek-ai/dsh plugin --profile web add @limuyang2/dsh-team-mode
```

Harness 会把插件加入 `web` Profile。安装完成后启动：

```bash
npx @deepseek-ai/dsh web
```

终端通常会输出：

```text
dsh web: http://127.0.0.1:3080
```

在浏览器打开该地址即可。

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

## 从本地压缩包安装

拿到 `.tgz` 文件后，在文件所在目录执行：

```bash
npx @deepseek-ai/dsh plugin --profile web add ./limuyang2-dsh-team-mode-0.1.2.tgz
```

文件名中的版本号可能不同，请按实际文件名替换。

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
npx @deepseek-ai/dsh plugin --profile web remove @limuyang2/dsh-team-mode
```

该命令会从 `web` Profile 中移除插件依赖及其配置层。命令完成后重新启动 Harness，侧边栏和设置中的 Agent Team 入口将不再加载。

卸载插件不会修改 DeepSeek Harness 源码，也不会删除团队 Workspace 中的文件。插件自身保存的助手模板、团队记录和 Session 引用是否继续保留，取决于 Harness Profile 数据目录是否仍存在；如需彻底清理这些数据，请先备份并自行处理对应 Profile 数据目录。

## 下一步

继续阅读 [助手库](./assistants.md)，创建第一个 Leader 和成员助手。
