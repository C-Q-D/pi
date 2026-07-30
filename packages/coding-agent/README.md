<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的 Issue 和 PR 默认会自动关闭。维护者每天都会检查自动关闭的 Issue。请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

---

Pi 是一个精简的终端 Coding Harness。你可以让 Pi 适应自己的工作流，而不是反过来迁就 Pi，并且不必 Fork 或修改 Pi 内部实现。可以使用 TypeScript [Extension](#extension)、[Skill](#skill)、[Prompt Template](#prompt-template) 和 [Theme](#theme) 扩展它。还可以把 Extension、Skill、Prompt Template 和 Theme 放进 [Pi Package](#pi-package)，通过 npm 或 git 与他人分享。

Pi 提供了强大的默认能力，但没有内置 Sub-agent、Plan Mode 等功能。你可以直接让 Pi 构建所需能力，也可以安装符合自己工作流的第三方 Pi Package。

Pi 支持四类运行方式：交互模式、Print 或 JSON 模式、用于进程集成的 RPC 模式，以及可嵌入自有应用的 SDK。

## 分享你的开源 Coding Agent Session

如果你使用 Pi 参与开源工作，欢迎分享 Coding Agent Session。

公开的开源 Session 数据有助于使用真实开发工作流改进 Model、Prompt、Tool 和评测。

完整说明请参阅 [X 上的这篇帖子](https://x.com/badlogicgames/status/2037811643774652911)。

可以使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) 发布 Session。设置方法请阅读其 README.md；你只需要 Hugging Face 账户、Hugging Face CLI 和 `pi-share-hf`。

也可以观看[这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中演示了如何发布 `pi-mono` Session。

我会定期在这里发布自己的 `pi-mono` 工作 Session：

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 目录

- [快速开始](#快速开始)
- [Provider 与 Model](#provider-与-model)
- [交互模式](#交互模式)
  - [Editor](#editor)
  - [命令](#命令)
  - [键盘快捷键](#键盘快捷键)
  - [消息队列](#消息队列)
- [Session](#session)
  - [分支](#分支)
  - [上下文压缩](#上下文压缩)
- [设置](#设置)
- [上下文文件](#上下文文件)
- [自定义](#自定义)
  - [Prompt Template](#prompt-template)
  - [Skill](#skill)
  - [Extension](#extension)
  - [Theme](#theme)
  - [Pi Package](#pi-package)
- [编程方式使用](#编程方式使用)
- [设计理念](#设计理念)
- [CLI 参考](#cli-参考)

---

## 快速开始

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖的生命周期脚本。通过 npm 正常安装 Pi 时不需要执行安装脚本。

也可以使用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

使用 API key 认证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

也可以使用现有订阅：

```bash
pi
/login  # 然后选择 Provider
```

之后直接与 Pi 对话即可。默认情况下，Pi 为 Model 提供四个 Tool：`read`、`write`、`edit` 和 `bash`。Model 使用这些 Tool 完成你的请求。可以通过 [Skill](#skill)、[Prompt Template](#prompt-template)、[Extension](#extension) 或 [Pi Package](#pi-package) 添加能力。

**平台说明：** [Windows](docs/windows.md) | [Termux（Android）](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal 设置](docs/terminal-setup.md) | [Shell alias](docs/shell-aliases.md)

---

## Provider 与 Model

Pi 为每个内置 Provider 维护一份支持 Tool 的 Model 列表。已配置的 Provider 目录会自动刷新；运行 `pi update --models` 可以立即强制刷新。通过订阅（`/login`）或 API key 完成认证后，使用 `/model`（或 Ctrl+L）选择该 Provider 的任意 Model。

**订阅：**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API key：**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

Pi 还支持 llama.cpp router server。使用 `/login llama.cpp` 配置，通过 `/llama` 管理下载项和已加载 Model，然后使用 `/model` 选择已加载的 Model。设置和用法请参阅 [docs/llama-cpp.md](docs/llama-cpp.md)。

其他 Provider 的设置说明请参阅 [docs/providers.md](docs/providers.md)。

**自定义 Provider 与 Model：** 如果 Provider 兼容受支持的 API（OpenAI、Anthropic、Google），可以通过 `~/.pi/agent/models.json` 添加。自定义 API 或 OAuth 请使用 Extension。请参阅 [docs/models.md](docs/models.md) 和 [docs/custom-provider.md](docs/custom-provider.md)。

---

## 交互模式

<p align="center"><img src="docs/images/interactive-mode.png" alt="交互模式" width="600"></p>

界面从上到下依次为：

- **启动 Header** — 显示快捷键（使用 `/hotkeys` 查看全部）、已加载的 AGENTS.md 文件、Prompt Template、Skill 和 Extension
- **消息区** — 显示你的消息、Assistant 回复、Tool Call 及其结果、通知、错误和 Extension UI
- **Editor** — 输入内容的位置；边框颜色表示 Thinking Level
- **Footer** — 显示工作目录、Session 名称、token/缓存总用量（`↑` 输入、`↓` 输出、`R` 缓存读取、`W` 缓存写入、`CH` 最近一次缓存命中率）、费用、上下文用量和当前 Model。总量包括 Assistant 回复、Tool 报告的用量及摘要生成用量。

Editor 可以暂时被其他 UI 替换，例如内置 `/settings`，或 Extension 提供的自定义 UI（比如让用户以结构化格式回答 Model 问题的问答 Tool）。[Extension](#extension) 还可以替换 Editor，在其上方或下方添加 Widget，或者添加 Status Line、自定义 Footer 和 Overlay。

### Editor

| 功能 | 操作方式 |
|---------|-----|
| 文件引用 | 输入 `@` 对项目文件进行模糊搜索 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter（Windows Terminal 上也可使用 Ctrl+Enter） |
| 外部 Editor | Ctrl+G 依次尝试打开 `externalEditor`、`$VISUAL`、`$EDITOR`、Windows 上的 Notepad，或其他平台上的 `nano` |
| 剪贴板 | 按 Ctrl+V 粘贴图片或文本（Windows 上为 Alt+V），也可以把图片拖入 Terminal |
| Bash 命令 | `!command` 执行命令并把输出发送给 LLM；`!!command` 执行但不发送输出 |

删除单词、撤销等操作使用标准编辑快捷键。请参阅 [docs/keybindings.md](docs/keybindings.md)。

### 命令

在 Editor 中输入 `/` 可以触发命令。[Extension](#extension) 可以注册自定义命令，[Skill](#skill) 以 `/skill:name` 的形式使用，[Prompt Template](#prompt-template) 则通过 `/templatename` 展开。

| 命令 | 说明 |
|---------|-------------|
| `/login`, `/logout` | 管理 Provider 凭据 |
| [`/llama`](docs/llama-cpp.md) | 下载、加载和卸载 llama.cpp router Model |
| `/model` | 切换 Model |
| `/scoped-models` | 启用或禁用参与 Ctrl+P 循环切换的 Model |
| `/settings` | 设置 Thinking Level、Theme、消息投递和 Transport |
| `/resume` | 从以往 Session 中选择 |
| `/new` | 启动新 Session |
| `/name <name>` | 设置 Session 显示名称 |
| `/session` | 显示 Session 信息（文件、ID、消息、token、费用） |
| `/tree` | 跳转到 Session 中的任意位置并从那里继续 |
| `/trust` | 保存供后续 Session 使用的项目信任决定（需要重启） |
| `/fork` | 从之前的 User 消息创建新 Session |
| `/clone` | 把当前活动分支复制到新 Session |
| `/compact [prompt]` | 手动压缩上下文，可附加自定义指令 |
| `/copy` | 将最后一条 Assistant 消息复制到剪贴板 |
| `/export [file]` | 将 Session 导出为 HTML 或 JSONL 文件 |
| `/import <file>` | 从 JSONL 文件导入并恢复 Session |
| `/share` | 上传为私有 GitHub gist，并获得可分享的 HTML 链接 |
| `/reload` | 重新加载快捷键、Extension、Skill、Prompt、Theme 和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 Pi |

### 键盘快捷键

使用 `/hotkeys` 查看完整列表。可以通过 `~/.pi/agent/keybindings.json` 自定义。请参阅 [docs/keybindings.md](docs/keybindings.md)。

**常用快捷键：**

| 按键 | 操作 |
|-----|--------|
| Ctrl+C | 清空 Editor |
| 连按两次 Ctrl+C | 退出 |
| Escape | 取消/中止 |
| 连按两次 Escape | 打开 `/tree` |
| Ctrl+L | 打开 Model 选择器 |
| Ctrl+P / Shift+Ctrl+P | 向前/向后循环切换指定范围的 Model |
| Shift+Tab | 循环切换 Thinking Level |
| Ctrl+O | 折叠/展开 Tool 输出 |
| Ctrl+T | 折叠/展开 thinking block |
| Ctrl+X | 复制最后一条 Assistant 消息 |

### 消息队列

Agent 工作时也可以提交消息：

- **Enter** 将 *steering* 消息加入队列，在当前 Assistant Turn 完成 Tool Call 后投递
- **Alt+Enter** 将 *follow-up* 消息加入队列，仅在 Agent 完成全部工作后投递
- **Escape** 中止执行，并将队列中的消息恢复到 Editor
- **Alt+Up** 将队列中的消息取回 Editor

Windows Terminal 默认将 `Alt+Enter` 用作全屏快捷键。请按照 [docs/terminal-setup.md](docs/terminal-setup.md) 重新映射，使 Pi 能接收到 follow-up 快捷键。

可以在[设置](docs/settings.md)中配置投递方式：`steeringMode` 和 `followUpMode` 可设为 `"one-at-a-time"`（默认，等待回复）或 `"all"`（一次投递队列中的全部消息）。对于支持多种 Transport 的 Provider，`transport` 用于选择偏好的传输方式（`"sse"`、`"websocket"` 或 `"auto"`）。

---

## Session

Session 以具有树状结构的 JSONL 文件保存。每个条目都有 `id` 和 `parentId`，因此无需创建新文件即可在原 Session 内形成分支。文件格式请参阅 [docs/session-format.md](docs/session-format.md)。

### 管理

Session 会自动保存到 `~/.pi/agent/sessions/`，并按工作目录组织。

```bash
pi -c                  # 继续最近一次 Session
pi -r                  # 浏览并选择以往 Session
pi --no-session        # 临时模式（不保存）
pi --name "我的任务"   # 启动时设置 Session 显示名称
pi --session <path|id> # 使用指定 Session 文件或 ID
pi --fork <path|id>    # 将指定 Session 文件或 ID Fork 为新 Session
```

在交互模式中使用 `/session` 查看当前 Session ID，之后可通过 `--session <id>` 或 `--fork <id>` 复用。

### 分支

**`/tree`** — 在当前文件中浏览 Session Tree。可以选择之前的任意位置继续，并在不同分支之间切换。全部历史都保存在同一个文件中。

<p align="center"><img src="docs/images/tree-view.png" alt="Tree 视图" width="600"></p>

- 直接输入即可搜索；使用 Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ 折叠、展开及在分支间跳转；使用 ←/→ 翻页
- 筛选模式（Ctrl+O）：默认 → 无 Tool → 仅 User → 仅已标记 → 全部
- 按 Ctrl+X 复制选中的消息
- 按 Shift+L 将条目标记为书签，按 Shift+T 切换标签时间戳

**`/fork`** — 从活动分支中之前的一条 User 消息创建新的 Session 文件。该命令会打开选择器，复制到该位置为止的活动路径，并将选中的 Prompt 放入 Editor 供修改。

**`/clone`** — 在当前位置把当前活动分支复制为新的 Session 文件。新 Session 保留完整的活动路径历史，并以空 Editor 打开。

**`--fork <path|id>`** — 直接从 CLI Fork 现有 Session 文件或部分 Session UUID。该命令会把完整源 Session 复制到当前项目的新 Session 文件中。

### 上下文压缩

较长的 Session 可能耗尽 Context Window。上下文压缩会总结较早的消息，同时保留最近的消息。

**手动：** `/compact` 或 `/compact <自定义指令>`

**自动：** 默认启用。在上下文溢出时触发（恢复后重试），或在接近限制时主动触发。可以通过 `/settings` 或 `settings.json` 配置。

上下文压缩会损失信息。完整历史仍保留在 JSONL 文件中，可以使用 `/tree` 回看。可通过 [Extension](#extension) 自定义压缩行为。内部原理请参阅 [docs/compaction.md](docs/compaction.md)。

---

## 设置

使用 `/settings` 修改常用选项，也可以直接编辑 JSON 文件：

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（覆盖全局设置） |

全部选项请参阅 [docs/settings.md](docs/settings.md)。

### 项目信任

交互模式启动时，如果项目文件夹包含项目本地设置、资源或项目 `.agents/skills`，并且 `~/.pi/agent/trust.json` 中没有为该文件夹或其父文件夹保存决定，Pi 会先询问是否信任。信任项目后，Pi 可以加载 `.pi/settings.json` 和 `.pi` 资源、安装缺失的项目 Package，并执行项目 Extension。

作出信任决定前，Pi 只加载上下文文件、用户/全局 Extension 和 CLI `-e` Extension，以便它们处理 `project_trust` 事件。只有项目受信任后，才会加载项目本地 Extension、由项目 Package 管理的 Extension 及项目设置。当切换到另一个 cwd 的 Session，且当前进程尚未处理该目录的信任状态时，同样遵循此规则。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不会显示信任提示。如果没有适用的已保存决定，它们会使用全局设置中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略这些项目资源，`always` 则信任它们。可以传入 `--approve`/`-a` 或 `--no-approve`/`-na`，仅覆盖本次运行的项目信任状态。

如果没有适用的 Extension 或已保存决定，回退行为由 `defaultProjectTrust` 控制。可以在 `~/.pi/agent/settings.json` 中将其设为 `"ask"`、`"always"` 或 `"never"`，也可以通过 `/settings` 修改。

`pi config` 和 Package 命令使用相同的项目信任流程，但 `pi update` 从不提示。传入 `--approve` 可在单次命令中信任项目本地设置，传入 `--no-approve` 则忽略它们。

在交互模式中使用 `/trust`，可以保存供后续 Session 使用的项目信任决定，其中也可包含对直接父文件夹的信任。该命令只写入 `~/.pi/agent/trust.json`，不会重新加载当前 Session，因此需要重启 Pi 才能使更改生效。

### Telemetry 与更新检查

Pi 有两项彼此独立的启动功能：

- **更新检查：** 请求 `https://pi.dev/api/latest-version`，检查是否存在更新的 Pi 版本。设置 `PI_SKIP_VERSION_CHECK=1` 可以禁用。禁用更新检查只会关闭这一项检查。
- **安装/更新 Telemetry：** 首次安装后，或 Changelog 检测到更新后，向 `https://pi.dev/api/report-install` 发送匿名版本 Ping。此设置还控制 OpenRouter、Cloudflare 和直接 NVIDIA NIM 请求中可选的 Provider Attribution Header。可以在 `settings.json` 中将 `enableInstallTelemetry` 设为 `false`，或设置 `PI_TELEMETRY=0` 来退出。这样不会禁用更新检查；除非同时禁用更新检查或启用离线模式，否则 Pi 仍可能联系 `pi.dev` 获取最新版本。

使用 `--offline` 或 `PI_OFFLINE=1` 可以禁用这里所述的全部启动网络操作，包括更新检查、Package 更新检查及安装/更新 Telemetry。

---

## 上下文文件

Pi 启动时会从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：

- `~/.pi/agent/AGENTS.md`（全局）
- 父目录（从 cwd 逐级向上查找）
- 当前目录

这些文件可用于提供项目指令（`AGENTS.md`/`CLAUDE.md`）、约定和常用命令。所有匹配的文件会拼接在一起。

使用 `--no-context-files`（或 `-nc`）可以禁用上下文文件加载。

### System Prompt

使用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）替换默认 System Prompt。若只想追加而不替换，请使用 `APPEND_SYSTEM.md`。

---

## 自定义

### Prompt Template

Prompt Template 是可复用的 Markdown Prompt 文件。输入 `/name` 即可展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
检查此代码中的 Bug、安全问题和性能问题。
重点关注：{{focus}}
```

将文件放在 `~/.pi/agent/prompts/`、`.pi/prompts/` 或 [Pi Package](#pi-package) 中，即可与他人分享。请参阅 [docs/prompt-templates.md](docs/prompt-templates.md)。

### Skill

Skill 是遵循 [Agent Skills 标准](https://agentskills.io)、按需加载的能力包。可以通过 `/skill:name` 调用，也可以让 Agent 自动加载。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# 我的 Skill
当用户询问 X 时使用此 Skill。

## 步骤
1. 执行此操作
2. 然后执行下一项
```

将 Skill 放在 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`、`.agents/skills/`（从 `cwd` 逐级向上查找父目录）或 [Pi Package](#pi-package) 中，即可与他人分享。请参阅 [docs/skills.md](docs/skills.md)。

### Extension

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

Extension 是 TypeScript 模块，可使用自定义 Tool、命令、键盘快捷键、事件处理程序和 UI 组件扩展 Pi。

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

默认导出也可以是 `async`。Pi 会等待异步 Extension Factory 完成后再继续启动，这适合执行一次性初始化，例如在调用 `pi.registerProvider()` 前获取远程 Model 列表。

**可实现的能力：**

- 自定义 Tool（也可以完全替换内置 Tool）
- Sub-agent 和 Plan Mode
- 自定义上下文压缩和摘要
- 权限门禁和路径保护
- 自定义 Editor 和 UI 组件
- Status Line、Header 和 Footer
- Git Checkpoint 和自动 Commit
- SSH 和 Sandbox 执行
- MCP Server 集成
- 让 Pi 呈现为 Claude Code 的样式
- 等待期间运行游戏（没错，Doom 也能运行）
- ……以及任何你能想到的能力

将 Extension 放在 `~/.pi/agent/extensions/`、`.pi/extensions/` 或 [Pi Package](#pi-package) 中，即可与他人分享。请参阅 [docs/extensions.md](docs/extensions.md) 和 [examples/extensions/](examples/extensions/)。

### Theme

内置 Theme：`dark`、`light`。Theme 支持热重载：修改当前 Theme 文件后，Pi 会立即应用更改。

将 Theme 放在 `~/.pi/agent/themes/`、`.pi/themes/` 或 [Pi Package](#pi-package) 中，即可与他人分享。请参阅 [docs/themes.md](docs/themes.md)。

### Pi Package

通过 npm 或 git 打包和分享 Extension、Skill、Prompt 与 Theme。可以在 [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) 或 [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628) 查找 Package。

> **安全提示：** Pi Package 运行时拥有完整系统访问权限。Extension 可以执行任意代码，Skill 也可以指示 Model 执行任何操作，包括运行可执行文件。安装第三方 Package 前请检查其源代码。

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # 固定版本
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # Tag 或 Commit
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # Tag 或 Commit
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # Tag 或 Commit
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # Tag 或 Commit
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # remove 的 alias
pi list
pi update                               # 仅更新 Pi
pi update --all                         # 更新 Pi 和 Package
pi update --extensions                  # 仅更新 Package
pi update --models                      # 仅刷新 Model 目录
pi update --self                        # 仅更新 Pi
pi update --self --force                # 即使已是当前版本也重新安装 Pi
pi update npm:@foo/pi-tools             # 更新一个 Package
pi config                               # 启用/禁用 Extension、Skill、Prompt、Theme
```

Package 会安装到 `~/.pi/agent/git/`（git）或 `~/.pi/agent/npm/`（npm）。使用 `-l` 可以执行项目本地安装（`.pi/git/`、`.pi/npm/`）。Git `@ref` 值表示固定的 Tag 或 Commit；`pi update --extensions` 和 `pi update --all` 会跳过固定版本的 Package，因此要将现有 Package 切换到新的 ref，请使用 `pi install git:host/user/repo@new-ref`。Git Package 默认使用 `npm install --omit=dev` 安装依赖，因此运行时依赖必须列在 `dependencies` 中；配置 `npmCommand` 后，为兼容 Wrapper，Git Package 会使用普通 `install`。如果使用 Node 版本管理器，并希望安装 Package 时复用稳定的 npm 上下文，请在 `settings.json` 中设置 `npmCommand`，例如 `["mise", "exec", "node@20", "--", "npm"]`。

在 `package.json` 中添加 `pi` key 即可创建 Package：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

如果没有 `pi` Manifest，Pi 会从约定目录（`extensions/`、`skills/`、`prompts/`、`themes/`）中自动发现资源。

请参阅 [docs/packages.md](docs/packages.md)。

---

## 编程方式使用

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("当前目录中有哪些文件？");
```

如需高级的多 Session Runtime 替换，请使用 `createAgentSessionRuntime()` 和 `AgentSessionRuntime`。

请参阅 [docs/sdk.md](docs/sdk.md) 和 [examples/sdk/](examples/sdk/)。

### RPC 模式

对于非 Node.js 集成，请通过 stdin/stdout 使用 RPC 模式：

```bash
pi --mode rpc
```

RPC 模式采用严格的 LF 分隔 JSONL Frame。Client 必须仅按 `\n` 分割记录。不要使用 Node `readline` 等通用逐行读取器，因为它们还会按 JSON Payload 内的 Unicode 分隔符进行分割。

协议详情请参阅 [docs/rpc.md](docs/rpc.md)。

---

## 设计理念

Pi 追求高度可扩展，因此无需规定你的工作流。其他 Tool 内置的功能，可以通过 [Extension](#extension)、[Skill](#skill) 构建，或从第三方 [Pi Package](#pi-package) 安装。这样既能保持核心精简，又能让你按照自己的工作方式塑造 Pi。

**不内置 MCP。** 可以构建带 README 的 CLI Tool（参阅 [Skill](#skill)），或构建添加 MCP 支持的 Extension。[为什么？](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**不内置 Sub-agent。** 实现方式有很多：可以通过 tmux 启动多个 Pi 实例，也可以使用 [Extension](#extension) 自行构建，或安装符合自己需求的 Package。

**不内置权限弹窗。** 可以在 Container 中运行，或使用 [Extension](#extension)，根据自己的环境和安全要求构建确认流程。

**不内置 Plan Mode。** 可以把计划写入文件、使用 [Extension](#extension) 构建，或安装相关 Package。

**不内置待办事项。** 它们会令 Model 困惑。可以使用 TODO.md 文件，或通过 [Extension](#extension) 自行构建。

**不内置后台 Bash。** 请使用 tmux，它具备完整可观测性并支持直接交互。

完整设计理由请阅读这篇[博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。

---

## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

### Package 命令

```bash
pi install <source> [-l]     # 安装 Package；-l 表示项目本地安装
pi remove <source> [-l]      # 删除 Package
pi uninstall <source> [-l]   # remove 的 alias
pi update [source|self|pi]   # 仅更新 Pi，或更新一个 Package Source
pi update --all              # 更新 Pi 和 Package
pi update --extensions       # 仅更新 Package
pi update --models           # 仅刷新 Model 目录
pi update --self             # 仅更新 Pi
pi update --self --force     # 即使已是当前版本也重新安装 Pi
pi update --extension <src>  # 更新一个 Package
pi list                      # 列出已安装的 Package
pi config                    # 启用/禁用 Package 资源
```

`pi config` 和项目 Package 命令接受 `--approve`/`--no-approve`，用于在单次命令中信任或忽略项目本地设置。`pi update` 从不显示项目信任提示。

### 模式

| 参数 | 说明 |
|------|-------------|
| （默认） | 交互模式 |
| `-p`, `--print` | 输出回复后退出 |
| `--mode json` | 以 JSON Line 输出所有事件（参阅 [docs/json.md](docs/json.md)） |
| `--mode rpc` | 用于进程集成的 RPC 模式（参阅 [docs/rpc.md](docs/rpc.md)） |
| `--export <in> [out]` | 将 Session 导出为 HTML |

在 Print 模式中，Pi 还会读取通过管道传入的 stdin，并将其合并到初始 Prompt：

```bash
cat README.md | pi -p "总结这段文本"
```

### Model 选项

| 选项 | 说明 |
|--------|-------------|
| `--provider <name>` | Provider（anthropic、openai、google 等） |
| `--model <pattern>` | Model 模式或 ID（支持 `provider/id` 和可选的 `:<thinking>`） |
| `--api-key <key>` | API key（覆盖环境变量） |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | 用逗号分隔、供 Ctrl+P 循环切换的模式 |
| `--list-models [search]` | 列出可用 Model |

### Session 选项

| 选项 | 说明 |
|--------|-------------|
| `-c`, `--continue` | 继续最近一次 Session |
| `-r`, `--resume` | 浏览并选择 Session |
| `--session <path\|id>` | 使用指定 Session 文件或部分 UUID |
| `--fork <path\|id>` | 将指定 Session 文件或部分 UUID Fork 为新 Session |
| `--session-dir <dir>` | 自定义 Session 存储目录 |
| `--no-session` | 临时模式（不保存） |
| `--name <name>`, `-n <name>` | 启动时设置 Session 显示名称 |

### Tool 选项

| 选项 | 说明 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 在内置、Extension 和自定义 Tool 中，仅允许指定的 Tool 名称 |
| `--exclude-tools <list>`, `-xt <list>` | 在内置、Extension 和自定义 Tool 中禁用指定的 Tool 名称 |
| `--no-builtin-tools`, `-nbt` | 默认禁用内置 Tool，但保持 Extension/自定义 Tool 启用 |
| `--no-tools`, `-nt` | 默认禁用所有 Tool |

可用的内置 Tool：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`

### 资源选项

| 选项 | 说明 |
|--------|-------------|
| `-e`, `--extension <source>` | 从路径、npm 或 git 加载 Extension（可重复使用） |
| `--no-extensions` | 禁用 Extension 自动发现 |
| `--skill <path>` | 加载 Skill（可重复使用） |
| `--no-skills` | 禁用 Skill 自动发现 |
| `--prompt-template <path>` | 加载 Prompt Template（可重复使用） |
| `--no-prompt-templates` | 禁用 Prompt Template 自动发现 |
| `--theme <path>` | 加载 Theme（可重复使用） |
| `--no-themes` | 禁用 Theme 自动发现 |
| `--no-context-files`, `-nc` | 禁用 AGENTS.md 和 CLAUDE.md 上下文文件自动发现 |

将 `--no-*` 与显式参数组合，可以忽略 settings.json，只加载需要的内容（例如 `--no-extensions -e ./my-ext.ts`）。

### 其他选项

| 选项 | 说明 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 Prompt（仍会追加上下文文件和 Skill） |
| `--append-system-prompt <text>` | 追加到 System Prompt |
| `--verbose` | 强制显示详细启动信息 |
| `-a`, `--approve` | 本次运行信任项目本地文件 |
| `-na`, `--no-approve` | 本次运行忽略项目本地文件 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

### 文件参数

在文件名前加 `@`，即可把文件包含在消息中：

```bash
pi @prompt.md "回答这个问题"
pi -p @screenshot.png "这张图片中有什么？"
pi @code.ts @test.ts "检查这些文件"
```

### 示例

```bash
# 使用初始 Prompt 进入交互模式
pi "列出 src/ 中的所有 .ts 文件"

# 非交互模式
pi -p "总结这个代码库"

# 在非交互模式中通过管道传入 stdin
cat README.md | pi -p "总结这段文本"

# 命名的一次性 Session
pi --name "发布审计" -p "审计此仓库"

# 使用其他 Model
pi --provider openai --model gpt-4o "帮我重构"

# 使用带 Provider 前缀的 Model（不需要 --provider）
pi --model openai/gpt-4o "帮我重构"

# 使用 Thinking Level 简写的 Model
pi --model sonnet:high "解决这个复杂问题"

# 限制参与循环切换的 Model
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "检查代码"

# 禁用一个 Extension 或内置 Tool，其他项仍保持可用
pi --exclude-tools ask_question

# High Thinking Level（高思考等级）
pi --thinking high "解决这个复杂问题"
```

### 环境变量

| 变量 | 说明 |
|----------|-------------|
| `PI_CODING_AGENT` | CLI 和 RPC 入口会将其设为 `true`，使子进程能够检测到自己正运行在 Pi 内部 |
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认：`~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖 Session 存储目录（会被 `--session-dir` 覆盖） |
| `PI_PACKAGE_DIR` | 覆盖 Package 目录（适用于 Store 路径不利于 Tokenization 的 Nix/Guix） |
| `PI_OFFLINE` | 禁用启动网络操作，包括更新检查、Package 更新检查和安装/更新 Telemetry |
| `PI_SKIP_VERSION_CHECK` | 启动时跳过 Pi 版本更新检查，避免向 `pi.dev` 发起最新版本请求 |
| `PI_TELEMETRY` | 覆盖安装/更新 Telemetry 和 Provider Attribution Header。使用 `1`/`true`/`yes` 启用，使用 `0`/`false`/`no` 禁用。此项不会禁用更新检查 |
| `PI_CACHE_RETENTION` | 设为 `long` 可使用扩展 Prompt Cache（Anthropic：1 小时，OpenAI：24 小时） |
| `VISUAL`, `EDITOR` | 未设置 `externalEditor` 时，作为 Ctrl+G 的后备外部 Editor；Windows 上默认为 Notepad，其他平台默认为 `nano` |

由 LLM 可调用的 Bash Tool 执行的命令还会收到当前 Session 元数据：

| 变量 | 说明 |
|----------|-------------|
| `PI_SESSION_ID` | 当前 Session ID |
| `PI_SESSION_FILE` | Session JSONL 的绝对路径；临时 Session 不设置 |
| `PI_PROVIDER` | 当前选中 Model 的 Provider |
| `PI_MODEL` | 当前选中的 Model ID |
| `PI_REASONING_LEVEL` | 当前生效的推理 Level |

这些值会在每条命令启动时解析。语义、示例及自定义 Tool 的退出方式请参阅[环境变量](docs/environment-variables.md#bash-tool-session-environment)。

---

## 贡献与开发

贡献规范请参阅 [CONTRIBUTING.md](../../CONTRIBUTING.md)；设置、Fork 和调试方法请参阅 [docs/development.md](docs/development.md)。

## 许可证

MIT

## 另请参阅

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)：核心 LLM Toolkit
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)：Agent Framework
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)：Terminal UI 组件

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下项目慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
