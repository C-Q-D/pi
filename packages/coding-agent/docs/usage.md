# 使用 Pi

本页汇总未在“快速开始”页面展开的日常使用细节。

## 交互模式

<p align="center"><img src="images/interactive-mode.png" alt="交互模式" width="600"></p>

界面包含四个主要区域：

- **启动 Header**——快捷键、已加载的上下文文件、Prompt Template、Skill 和 Extension
- **消息区**——用户消息、Assistant 响应、工具调用、Tool Result、通知、错误和 Extension UI
- **编辑器**——输入内容的区域；边框颜色表示当前 Thinking Level
- **Footer**——工作目录、Session 名称、Token/Cache 用量、费用、上下文用量和当前模型。总计包括 Assistant 响应、工具报告的用量和摘要生成。

编辑器可能被 `/settings` 等内置 UI 或自定义 Extension UI 临时替换。

### 编辑器功能

| 功能 | 使用方式 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter；Windows Terminal 上也可使用 Ctrl+Enter |
| 复制响应 | Ctrl+X 复制最后一条 Assistant 消息；在 `/tree` 中复制选中消息 |
| 图片 | 使用 Ctrl+V 粘贴，Windows 上使用 Alt+V，或将图片拖入终端 |
| Shell 命令 | `!command` 运行命令并把输出发送给模型 |
| 隐藏 Shell 命令 | `!!command` 运行命令但不把输出发送给模型 |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR`、Windows 上的 Notepad，或其他平台的 `nano` |

所有快捷键和自定义方式参阅[快捷键](keybindings.md)。

## Slash Command

在编辑器中输入 `/` 打开命令补全。Extension 可以注册自定义命令，Skill 以 `/skill:name` 的形式提供，Prompt Template 则通过 `/templatename` 展开。

| 命令 | 说明 |
|---------|-------------|
| `/login`, `/logout` | 管理 OAuth 或 API key 凭据 |
| [`/llama`](llama-cpp.md) | 下载、加载和卸载 llama.cpp Router 模型 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用参与 Ctrl+P 循环切换的模型 |
| `/settings` | Thinking Level、Theme、消息投递和 Transport |
| `/resume` | 从以前的 Session 中选择 |
| `/new` | 启动新 Session |
| `/name <name>` | 设置 Session 显示名称 |
| `/session` | 显示 Session 文件、ID、消息、Token 和费用 |
| `/tree` | 跳转到 Session 中的任意位置并从那里继续 |
| `/trust` | 保存项目信任决定，供以后 Session 使用 |
| `/fork` | 从以前的用户消息创建新 Session |
| `/clone` | 将当前活动分支复制到新 Session |
| `/compact [prompt]` | 手动压缩上下文，可选择提供自定义指令 |
| `/copy` | 将最后一条 Assistant 消息复制到剪贴板 |
| `/export [file]` | 将 Session 导出为 HTML 或 JSONL |
| `/import <file>` | 从 JSONL 文件导入并恢复 Session |
| `/share` | 上传为私有 GitHub Gist，并生成可分享的 HTML 链接 |
| `/reload` | 重新加载 Keybinding、Extension、Skill、Prompt、Theme 和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 Pi |

## 消息队列

Agent 仍在工作时也可以提交消息：

- **Enter** 将 Steering 消息加入队列，在当前 Assistant Turn 执行完工具调用后投递。
- **Alt+Enter** 将 Follow-up 消息加入队列，在 Agent 完成全部工作后投递。
- **Escape** 中止执行，并把队列中的消息恢复到编辑器。
- **Alt+Up** 将队列中的消息取回编辑器。

Windows Terminal 默认使用 Alt+Enter 切换全屏。如果希望 Pi 接收该快捷键，请按照[终端设置](terminal-setup.md)中的说明重新映射。

在[设置](settings.md)中使用 `steeringMode` 和 `followUpMode` 配置投递方式。

## Session

Session 会自动保存到 `~/.pi/agent/sessions/`，并按工作目录组织。

```bash
pi -c                  # 继续最近的 Session
pi -r                  # 浏览并选择 Session
pi --no-session        # 临时模式，不保存
pi --name "我的任务"   # 启动时设置 Session 显示名称
pi --session <path|id> # 使用指定 Session 文件或 Session ID
pi --fork <path|id>    # Fork Session，创建新 Session 文件
```

常用 Session 命令：

- `/session` 显示当前 Session 文件和 ID。
- `/tree` 浏览文件内的 Session Tree，并可以总结被放弃的分支。
- `/fork` 从较早的用户消息创建新 Session。
- `/clone` 将当前活动分支复制到新 Session 文件。
- `/compact` 总结较早的消息，释放上下文空间。

详情参阅 [Session](sessions.md) 和[上下文压缩](compaction.md)。

## 上下文文件

Pi 启动时会从以下位置加载 `AGENTS.md` 或 `CLAUDE.md`：

- 包含全局指令的 `~/.pi/agent/AGENTS.md`
- 从当前工作目录向上遍历的父目录
- 当前目录

使用上下文文件记录项目约定、命令、安全规则和偏好。通过 `--no-context-files` 或 `-nc` 禁用加载。

### System Prompt 文件

使用以下文件替换默认 System Prompt：

- 项目级 `.pi/SYSTEM.md`
- 全局 `~/.pi/agent/SYSTEM.md`

在任一位置使用 `APPEND_SYSTEM.md`，可以追加默认 Prompt 而不替换它。

### 项目信任

交互式启动时，如果项目文件夹包含项目本地设置、资源或项目 `.agents/skills`，并且 `~/.pi/agent/trust.json` 中没有针对该文件夹或其父文件夹的已保存决定，Pi 会先询问是否信任。信任项目后，Pi 可以加载 `.pi/settings.json` 和 `.pi` 资源、安装缺失的项目 Package，并执行项目 Extension。

作出信任决定前，Pi 只加载上下文文件、用户/全局 Extension 和 CLI `-e` Extension，以便它们处理 `project_trust` 事件。只有信任项目后，才会加载项目本地 Extension、由项目 Package 管理的 Extension 和项目设置。如果切换到其他 cwd 的 Session，而当前进程尚未确定该目录的信任状态，也会采用同样的分阶段加载方式。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不会显示信任提示。如果没有适用的已保存决定，它们会使用全局设置中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略这些项目资源，`always` 则会信任。传入 `--approve`/`-a` 或 `--no-approve`/`-na` 可以只为本次运行覆盖项目信任。

如果没有适用的 Extension 或已保存决定，回退行为由 `defaultProjectTrust` 控制。可以在 `~/.pi/agent/settings.json` 中将其设为 `"ask"`、`"always"` 或 `"never"`，也可以通过 `/settings` 修改。

`pi config` 和 Package 命令使用相同的项目信任流程，但 `pi update` 永远不会显示提示。传入 `--approve` 可以在单次命令中信任项目本地设置，传入 `--no-approve` 则忽略它们。

在交互模式中使用 `/trust` 保存供以后 Session 使用的项目信任决定，也可以信任直接父文件夹。该命令只写入 `~/.pi/agent/trust.json`，不会重新加载当前 Session，因此需要重启 Pi 才能使更改生效。

## 导出和分享 Session

使用 `/export [file]` 将 Session 写入 HTML。

使用 `/share` 上传私有 GitHub Gist，并生成可分享的 HTML 链接。

如果使用 Pi 参与开源工作，并希望发布 Session 用于模型、Prompt、工具和评估研究，请参阅 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。该工具会把 Session 发布到 Hugging Face Dataset。

## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

### Package 命令

```bash
pi install <source> [-l]     # 安装 Package，-l 表示项目本地
pi remove <source> [-l]      # 移除 Package
pi uninstall <source> [-l]   # remove 的 Alias
pi update [source|self|pi]   # 只更新 Pi，或更新一个 Package Source
pi update --all              # 更新 Pi 和 Package；对齐固定的 Git Ref
pi update --extensions       # 只更新 Package；对齐固定的 Git Ref
pi update --models           # 只刷新 Model Catalog
pi update --self             # 只更新 Pi
pi update --extension <src>  # 更新一个 Package
pi list                      # 列出已安装的 Package
pi config                    # 启用/禁用 Package 资源
```

这些命令用于管理 Pi Package，`pi update` 还可以更新 Pi CLI 安装。卸载 Pi 参阅[快速开始](quickstart.md#卸载)。`pi config` 和项目 Package 命令接受 `--approve`/`--no-approve`，用于在单次命令中信任或忽略项目本地设置。`pi update` 永远不会询问项目信任。

Package Source 和安全说明参阅 [Pi Package](packages.md)。

### 模式

| Flag | 说明 |
|------|-------------|
| 默认 | 交互模式 |
| `-p`, `--print` | 输出响应并退出 |
| `--mode json` | 以 JSON Line 输出所有事件；参阅 [JSON 模式](json.md) |
| `--mode rpc` | 通过 stdin/stdout 运行 RPC 模式；参阅 [RPC 模式](rpc.md) |
| `--export <in> [out]` | 将 Session 导出为 HTML |

在 Print 模式中，Pi 还会读取 Pipe 传入的 stdin，并合并到初始 Prompt：

```bash
cat README.md | pi -p "总结这段文本"
```

### 模型选项

| 选项 | 说明 |
|--------|-------------|
| `--provider <name>` | Provider，例如 `anthropic`、`openai` 或 `google` |
| `--model <pattern>` | 模型 Pattern 或 ID；支持 `provider/id` 和可选的 `:<thinking>` |
| `--api-key <key>` | API key，覆盖环境变量 |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `--models <patterns>` | 以逗号分隔、供 Ctrl+P 循环切换的 Pattern |
| `--list-models [search]` | 列出可用模型 |

### Session 选项

| 选项 | 说明 |
|--------|-------------|
| `-c`, `--continue` | 继续最近的 Session |
| `-r`, `--resume` | 浏览并选择 Session |
| `--session <path\|id>` | 使用指定 Session 文件或部分 UUID |
| `--fork <path\|id>` | 从 Session 文件或部分 UUID 创建新 Session |
| `--session-dir <dir>` | 自定义 Session 存储目录 |
| `--no-session` | 临时模式，不保存 |
| `--name <name>`, `-n <name>` | 启动时设置 Session 显示名称 |

### 工具选项

| 选项 | 说明 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 只允许指定的内置、Extension 和自定义工具 |
| `--exclude-tools <list>`, `-xt <list>` | 禁用指定的内置、Extension 和自定义工具 |
| `--no-builtin-tools`, `-nbt` | 禁用内置工具，但保持 Extension/自定义工具启用 |
| `--no-tools`, `-nt` | 禁用所有工具 |

内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。

### 资源选项

| 选项 | 说明 |
|--------|-------------|
| `-e`, `--extension <source>` | 从路径、npm 或 Git 加载 Extension；可重复传入 |
| `--no-extensions` | 禁用 Extension 发现 |
| `--skill <path>` | 加载 Skill；可重复传入 |
| `--no-skills` | 禁用 Skill 发现 |
| `--prompt-template <path>` | 加载 Prompt Template；可重复传入 |
| `--no-prompt-templates` | 禁用 Prompt Template 发现 |
| `--theme <path>` | 加载 Theme；可重复传入 |
| `--no-themes` | 禁用 Theme 发现 |
| `--no-context-files`, `-nc` | 禁用 `AGENTS.md` 和 `CLAUDE.md` 发现 |

将 `--no-*` 与显式 Flag 组合，可以忽略设置并只加载所需内容。例如：

```bash
pi --no-extensions -e ./my-extension.ts
```

### 其他选项

| 选项 | 说明 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 Prompt；仍会追加上下文文件和 Skill |
| `--append-system-prompt <text>` | 追加到 System Prompt |
| `--verbose` | 强制显示详细启动信息 |
| `-a`, `--approve` | 本次运行信任项目本地文件 |
| `-na`, `--no-approve` | 本次运行忽略项目本地文件 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

### 文件参数

在文件前加 `@`，将其加入消息：

```bash
pi @prompt.md "回答这个问题"
pi -p @screenshot.png "这张图片中有什么？"
pi @code.ts @test.ts "审查这些文件"
```

### 示例

```bash
# 使用初始 Prompt 进入交互模式
pi "列出 src/ 中的所有 .ts 文件"

# 非交互模式
pi -p "总结这个代码库"

# 通过 Pipe 传入 stdin 的非交互模式
cat README.md | pi -p "总结这段文本"

# 已命名的一次性 Session
pi --name "发布审计" -p "审计这个仓库"

# 使用其他模型
pi --provider openai --model gpt-4o "帮我重构"

# 带 Provider 前缀的模型
pi --model openai/gpt-4o "帮我重构"

# 带 Thinking Level 简写的模型
pi --model sonnet:high "解决这个复杂问题"

# 限制模型循环范围
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "审查代码"

# 禁用一个 Extension 或内置工具，同时保持其余工具可用
pi --exclude-tools ask_question
```

## 设计原则

Pi 保持核心小巧，并将工作流特定行为放到 Extension、Skill、Prompt Template 和 Package 中。

Pi 有意不内置 MCP、Sub-agent、权限弹窗、Plan Mode、To-do 或后台 Bash。你可以将这些工作流构建或安装为 Extension/Package，也可以使用 Container 和 tmux 等外部工具。

完整设计理由参阅[这篇博客文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。
