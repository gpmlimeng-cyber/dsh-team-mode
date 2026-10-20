# 故障排查

[上一篇：团队管理](./team-management.md) · [文档首页](./README.md)

## 安装命令提示 `pnpm not found on PATH`

Harness 使用 pnpm 管理 Profile 插件。执行：

```bash
npm install -g pnpm
pnpm --version
```

确认能输出版本后，重新安装插件。

## `npm login` 打开了第三方镜像

检查当前 Registry：

```bash
npm config get registry
```

切换到 npm 官方 Registry：

```bash
npm config set registry=https://registry.npmjs.org/ --location=user
```

## 启动报错 `EADDRINUSE 127.0.0.1:3080`

端口已被另一个 Harness 进程占用。回到原来启动 Harness 的终端按 `Ctrl+C`，然后重新执行：

```bash
npx @deepseek-ai/dsh web
```

如不知道哪个进程占用端口，可只读检查：

```bash
lsof -nP -iTCP:3080 -sTCP:LISTEN
```

## 安装后看不到“团队”入口

依次检查：

1. 安装命令使用了 `--profile web`。
2. 安装后已经完全停止并重启 Harness。
3. 浏览器已刷新。
4. **设置 → 插件** 中能看到 `@limuyang2/dsh-team-mode`。
5. 当前运行的确实是安装插件的那个 Harness Profile。

## 助手或团队列表一直刷新

- 确认页面右上角没有“事件连接已断开”提示。
- 检查 Harness 终端是否有插件加载错误。
- 刷新浏览器，等待事件连接恢复。
- 仍然提示 `assistant.list` 或 `team.list` 超时时，重启 Harness。

列表接口不依赖模型生成。模型目录加载较慢不应阻塞已经保存的助手和团队列表。

## 模型列表不完整

Agent Team 只展示 Harness 当前 Profile 已配置并可用的 Provider 与模型：

1. 先在 Harness 模型设置中确认 Provider 和模型。
2. 检查凭据是否有效。
3. 返回助手库点击刷新。
4. 编辑助手时重新选择 Provider 和模型。

## GLM 或其他模型没有思考模式

思考档位来自 Harness 模型能力目录。若 Provider 没有声明能力，插件只显示模型默认。升级或修正 Profile 的模型能力配置后，刷新助手目录。

不要随意选择模型未支持的档位；错误参数可能导致请求失败。

## 权限一直显示只读

助手模板权限只是初始默认值。进入团队工作台，在对应成员输入框左下角切换当前 Session 权限。更改会保存到该成员运行配置，但不会修改助手模板。

## 消息发送失败或停止按钮无效

- 确认事件连接和 API 请求没有断开。
- 等待当前成员状态刷新后重试。
- 不要连续快速点击发送按钮；同一条消息会使用 ID 去重，但网络恢复期间仍应等待界面反馈。
- 单成员停止只影响该成员，其他列可能继续运行。

## 中文或英文输入时回车误发送

当前版本会识别输入法组合状态。输入法候选确认时的回车不会发送；正常状态下 `Enter` 发送、`Shift+Enter` 换行。如仍复现，请记录操作系统、浏览器和输入法名称后提交 Issue。

## 无法删除助手

助手仍被一个或多个团队成员引用。进入相关团队：

1. 把该助手对应的成员移出团队；或
2. 解散不再需要的团队。

然后返回 **设置 → Agent 团队** 删除。

## Workspace 不自动刷新

点击 Workspace 标题右侧的刷新图标。浏览器从休眠恢复、文件瞬间大量变化或事件连接重连后，手动刷新可以立即重新读取目录和 Git 状态。

## “变更”页签提示不是 Git 仓库

插件检查的是团队 Workspace 根目录。请确认该目录包含 `.git`，而不是只有某个子目录包含仓库。普通目录仍可使用文件浏览功能。

## 为什么选择文件后出现在 `.dsh-team-mode/uploads/`

浏览器不能安全地把任意本地绝对路径直接交给 Host Agent。插件把文件复制进 Workspace，确保 Agent 可以读取且不会越过 Workspace 安全边界。

## 清空或解散后旧日志仍存在

Harness 当前没有物理删除单个 Session 日志的公开 API。插件会解除关联，不再恢复、展示或把旧内容加入模型上下文，但底层日志可能继续保留。

## 提交问题

在 [GitHub Issues](https://github.com/limuyang2/dsh-team-mode/issues) 提交：

- Harness 与插件版本。
- Provider 和模型名称（不要提交 API Key）。
- 可重复操作步骤。
- Harness 终端错误和界面截图。
- 是否能够在刷新或重启后恢复。
