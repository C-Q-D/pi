# 快速开始

本页将带你完成安装，并开始第一个实用的 Pi Session。

## 安装

Pi 以 npm Package 的形式发布：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装时禁用依赖的 lifecycle script。正常通过 npm 安装 Pi 不需要运行 install script。

### 卸载

请使用安装 Pi 时所用的 Package Manager 进行卸载。curl 安装脚本使用 npm 全局安装，因此通过 curl 或 npm 安装的 Pi 都使用 npm 移除：

```bash
# curl 安装脚本或 npm install -g
npm uninstall -g @earendil-works/pi-coding-agent

# pnpm
pnpm remove -g @earendil-works/pi-coding-agent

# Yarn
yarn global remove @earendil-works/pi-coding-agent

# Bun
bun uninstall -g @earendil-works/pi-coding-agent
```

卸载 Pi 不会删除 `~/.pi/agent/` 中的设置、凭据、Session 和已安装 Pi Package。

然后在希望 Pi 工作的项目目录中启动它：

```bash
cd /path/to/project
pi
```

## 认证

Pi 可以通过 `/login` 使用订阅型 Provider，也可以通过环境变量或认证文件使用 API key 型 Provider。

### 方式一：订阅登录

启动 Pi 并运行：

```text
/login
```

然后选择一个 Provider。内置订阅登录包括 Claude Pro/Max、ChatGPT Plus/Pro（Codex）和 GitHub Copilot。

### 方式二：API key

启动 Pi 前设置 API key：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

也可以运行 `/login` 并选择 API key 型 Provider，将 key 保存到 `~/.pi/agent/auth.json`。

所有受支持的 Provider、环境变量和 Cloud Provider 设置参阅 [Provider](providers.md)。

## 第一个 Session

Pi 启动后，输入请求并按 Enter：

```text
总结这个仓库，并告诉我如何运行检查。
```

默认情况下，Pi 为模型提供四个工具：

- `read`——读取文件
- `write`——创建或覆盖文件
- `edit`——以 Patch 方式编辑文件
- `bash`——运行 Shell 命令

还可以通过工具选项启用其他内置只读工具（`grep`、`find`、`ls`）。Pi 在当前工作目录中运行，并且可以修改其中的文件。如果希望方便地回退，请使用 Git 或其他 Checkpoint 工作流。

## 为 Pi 提供项目指令

Pi 启动时会加载上下文文件。添加 `AGENTS.md`，告诉 Pi 应当如何在项目中工作：

```markdown
# 项目指令

- 修改代码后运行 `npm run check`。
- 不要在本地运行生产环境 Migration。
- 保持回复简洁。
```

Pi 会加载：

- `~/.pi/agent/AGENTS.md` 中的全局指令
- 父目录和当前目录中的 `AGENTS.md` 或 `CLAUDE.md`

修改上下文文件后，请重启 Pi 或运行 `/reload`。

## 常用功能

### 引用文件

在编辑器中输入 `@` 模糊搜索文件，也可以通过命令行传入文件：

```bash
pi @README.md "总结这个文件"
pi @src/app.ts @src/app.test.ts "一起审查这两个文件"
```

可使用 Ctrl+V 粘贴图片或文本（Windows 上使用 Alt+V）；支持的终端还可以直接拖入图片。

### 运行 Shell 命令

在交互模式中：

```text
!npm run lint
```

命令输出会发送给模型。使用 `!!command` 可以运行命令，但不把输出加入模型上下文。

### 切换模型

使用 `/model` 或 Ctrl+L 选择模型。使用 Shift+Tab 循环切换 Thinking Level。使用 Ctrl+P / Shift+Ctrl+P 循环切换限定范围内的模型。

### 稍后继续

Session 会自动保存：

```bash
pi -c                  # 继续最近的 Session
pi -r                  # 浏览以前的 Session
pi --name "我的任务"   # 启动时设置 Session 显示名称
pi --session <path|id> # 打开指定 Session
```

在 Pi 中使用 `/resume`、`/new`、`/tree`、`/fork` 和 `/clone` 管理 Session。

### 非交互模式

发送一次性 Prompt：

```bash
pi -p "总结这个代码库"
cat README.md | pi -p "总结这段文本"
pi -p @screenshot.png "这张图片中有什么？"
```

使用 `--mode json` 输出 JSON 事件，或使用 `--mode rpc` 与其他进程集成。

## 后续阅读

- [使用 Pi](usage.md)——交互模式、Slash Command、Session、上下文文件和 CLI 参考。
- [Provider](providers.md)——认证和模型设置。
- [设置](settings.md)——全局配置和项目配置。
- [快捷键](keybindings.md)——快捷键和自定义方式。
- [Pi Package](packages.md)——安装共享的 Extension、Skill、Prompt 和 Theme。

平台说明：[Windows](windows.md)、[Termux](termux.md)、[tmux](tmux.md)、[终端设置](terminal-setup.md)、[Shell Alias](shell-aliases.md)。
