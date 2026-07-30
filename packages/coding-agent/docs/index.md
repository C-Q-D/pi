# Pi 文档

Pi 是一个精简的终端 Coding Harness。它的设计目标是保持核心小巧，同时通过 TypeScript Extension、Skill、Prompt Template、Theme 和 Pi Package 扩展能力。

## 快速开始

使用 npm 安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装时禁用依赖的 lifecycle script。正常通过 npm 安装 Pi 不需要运行 install script。

在 Linux 或 macOS 上也可以使用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

如果通过 curl 或 npm 安装，请使用 npm 卸载 Pi：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

如果通过 pnpm、Yarn 或 Bun 安装，请使用对应的全局移除命令：`pnpm remove -g @earendil-works/pi-coding-agent`、`yarn global remove @earendil-works/pi-coding-agent` 或 `bun uninstall -g @earendil-works/pi-coding-agent`。

然后在项目目录中运行：

```bash
pi
```

订阅型 Provider 使用 `/login` 认证；API key 型 Provider 则在启动 Pi 前设置 `ANTHROPIC_API_KEY` 等 API key。

完整的首次运行流程参阅[快速开始](quickstart.md)。

## 从这里开始

- [快速开始](quickstart.md)——安装、认证并运行第一个 Session。
- [使用 Pi](usage.md)——交互模式、Slash Command、上下文文件和 CLI 参考。
- [Provider](providers.md)——内置 Provider 的订阅和 API key 配置。
- [llama.cpp](llama-cpp.md)——运行本地 Router，并使用 `/llama` 管理模型。
- [安全](security.md)——项目信任、Sandbox 边界和漏洞报告。
- [容器化](containerization.md)——使用 Gondolin、Docker 或 OpenShell 隔离 Pi。
- [设置](settings.md)——全局设置和项目设置。
- [快捷键](keybindings.md)——默认快捷键和自定义 Keybinding。
- [Session](sessions.md)——Session 管理、分支和树导航。
- [上下文压缩](compaction.md)——上下文压缩和分支摘要。

## 自定义

- [Extension](extensions.md)——用于工具、命令、事件和自定义 UI 的 TypeScript 模块。
- [Skill](skills.md)——可按需复用能力的 Agent Skill。
- [Prompt Template](prompt-templates.md)——通过 Slash Command 展开的可复用 Prompt。
- [Theme](themes.md)——内置和自定义终端 Theme。
- [Pi Package](packages.md)——打包并分享 Extension、Skill、Prompt 和 Theme。
- [自定义模型](models.md)——为支持的 Provider API 添加模型条目。
- [自定义 Provider](custom-provider.md)——实现自定义 API 和 OAuth 流程。

## 编程方式使用

- [SDK](sdk.md)——将 Pi 嵌入 Node.js 应用。
- [RPC 模式](rpc.md)——通过 stdin/stdout JSONL 集成。
- [JSON 事件流模式](json.md)——输出结构化事件的 Print 模式。
- [TUI 组件](tui.md)——为 Extension 构建自定义终端 UI。

## 参考

- [环境变量](environment-variables.md)——Pi 进程配置，以及 Bash 工具可用的 Session 元数据。
- [Session 格式](session-format.md)——JSONL Session 文件格式、Entry 类型和 SessionManager API。

## 平台设置

- [Windows](windows.md)
- [Android 上的 Termux](termux.md)
- [tmux](tmux.md)
- [终端设置](terminal-setup.md)
- [Shell Alias](shell-aliases.md)

## 开发

- [开发](development.md)——本地设置、项目结构和调试。
