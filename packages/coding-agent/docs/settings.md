# 设置

Pi 使用 JSON 设置文件，项目设置会覆盖全局设置。

| 位置 | 作用范围 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（当前目录） |

可以直接编辑文件，也可以使用 `/settings` 修改常用选项。

## 项目信任

交互式启动时，如果项目文件夹包含项目本地设置、资源或项目 `.agents/skills`，并且 `~/.pi/agent/trust.json` 中没有针对该文件夹或其父文件夹的已保存决定，Pi 会先询问是否信任。信任项目后，Pi 可以加载 `.pi/settings.json` 和 `.pi` 资源、安装缺失的项目 Package，并执行项目 Extension。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不会显示信任提示。如果没有适用的已保存决定，它们会使用全局设置中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略这些项目资源，`always` 则会信任。传入 `--approve`/`-a` 或 `--no-approve`/`-na` 可以只为本次运行覆盖项目信任。

如果没有适用的 Extension 或已保存决定，回退行为由 `defaultProjectTrust` 控制。可以在 `~/.pi/agent/settings.json` 中将其设为 `"ask"`、`"always"` 或 `"never"`，也可以通过 `/settings` 修改。

`pi config` 和 Package 命令使用相同的项目信任流程，但 `pi update` 永远不会显示提示。传入 `--approve` 可以在单次命令中信任项目本地设置，传入 `--no-approve` 则忽略它们。

在交互模式中使用 `/trust` 保存供以后 Session 使用的项目信任决定，也可以信任直接父文件夹。该命令只写入 `~/.pi/agent/trust.json`，不会重新加载当前 Session，因此需要重启 Pi 才能使更改生效。

## 所有设置

### 模型与 Thinking

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | 默认 Provider（例如 `"anthropic"`、`"openai"`） |
| `defaultModel` | string | - | 默认模型 ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | 在输出中隐藏 Thinking Block |
| `showCacheMissNotices` | boolean | `false` | Prompt Cache 大量 Miss 时在对话中显示提示 |
| `thinkingBudgets` | object | - | 为各 Thinking Level 自定义 Token Budget |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI 与显示

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme 名称（`"dark"`、`"light"` 或自定义值） |
| `externalEditor` | string | `$VISUAL`，然后 `$EDITOR`，再到 Windows 上的 Notepad 或其他平台的 `nano` | Ctrl+G 使用的外部编辑器命令；优先于环境变量 |
| `quietStartup` | boolean | `false` | 隐藏启动 Header |
| `defaultProjectTrust` | string | `"ask"` | 项目信任回退行为：`"ask"`、`"always"` 或 `"never"`；仅限全局设置 |
| `collapseChangelog` | boolean | `false` | 更新后显示精简 Changelog |
| `enableInstallTelemetry` | boolean | `true` | 首次安装或检测到 Changelog 更新后，匿名上报安装/更新版本；不控制更新检查 |
| `enableAnalytics` | boolean | `false` | 选择加入 Analytics 数据分享；目前只在实验性首次设置（`PI_EXPERIMENTAL=1`）中询问 |
| `trackingId` | string | - | Analytics 跟踪标识符，在启用 `enableAnalytics` 时生成 |
| `doubleEscapeAction` | string | `"tree"` | 连按两次 Escape 的操作：`"tree"`、`"fork"` 或 `"none"` |
| `treeFilterMode` | string | `"default"` | `/tree` 的默认 Filter：`"default"`、`"no-tools"`、`"user-only"`、`"labeled-only"`、`"all"` |
| `editorPaddingX` | number | `0` | 输入编辑器的水平 Padding（0-3） |
| `outputPad` | number | `1` | 用户消息、Assistant 消息和 Thinking 的水平 Padding（0 或 1） |
| `autocompleteMaxVisible` | number | `5` | 自动补全下拉列表最大可见项数（3-20） |
| `showHardwareCursor` | boolean | `false` | TUI 为支持 IME 定位光标时，显示终端硬件光标 |

使用 VS Code 时加入 `--wait`，使 Pi 在编辑器退出后继续：

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry 与更新检查

`enableInstallTelemetry` 只控制发送到 `https://pi.dev/api/report-install` 的匿名安装/更新 Ping。退出 Telemetry 不会禁用更新检查；Pi 仍可请求 `https://pi.dev/api/latest-version` 查询最新版本。

设置 `PI_SKIP_VERSION_CHECK=1` 可禁用 Pi 版本更新检查。使用 `--offline` 或 `PI_OFFLINE=1` 可以禁用这里描述的所有启动网络操作，包括版本更新检查、Package 更新检查和安装/更新 Telemetry。

### 网络

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `httpProxy` | string | - | 同时应用为 `HTTP_PROXY` 和 `HTTPS_PROXY` 的 HTTP Proxy URL；仅限全局设置 |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### 警告

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Anthropic 订阅认证可能产生额外付费用量时显示警告 |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### 上下文压缩

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | 启用自动压缩 |
| `compaction.strategy` | string | `"local"` | 压缩策略：`"local"`、`"remote"` 或 `"auto"`；Remote 与 Auto 当前为实验能力 |
| `compaction.reserveTokens` | number | `16384` | 为 LLM 响应预留的 Token |
| `compaction.keepRecentTokens` | number | `20000` | 保留且不进行摘要的近期 Token |

```json
{
  "compaction": {
    "enabled": true,
    "strategy": "local",
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`local` 生成可读且可跨 Provider 使用的本地摘要；`remote` 强制使用受支持 Provider 的 Opaque Context；`auto` 先尝试 Remote，失败时最多执行一次 Local Fallback。无 Flag 的 `/compact` 使用该设置；`/compact --local` 和 `/compact --remote` 只覆盖本次操作。`/compact <自定义指令>` 为保持兼容始终使用 Local。完整行为、Binding 限制和恢复方式参阅 [compaction.md](compaction.md)。

### 分支摘要

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | 为分支摘要预留的 Token |
| `branchSummary.skipPrompt` | boolean | `false` | `/tree` 导航时跳过“是否总结分支？”提示（默认不生成摘要） |

### Retry

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | 发生暂时性错误时启用 Agent 级自动重试 |
| `retry.maxRetries` | number | `3` | Agent 级最大重试次数 |
| `retry.baseDelayMs` | number | `2000` | Agent 级指数退避基础延迟（2s、4s、8s） |
| `retry.provider.timeoutMs` | number | SDK 默认值 | Provider/SDK 请求超时，单位为毫秒 |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK 重试次数 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 服务器要求的最大可接受延迟（60s），超过后立即失败 |

当 Provider 要求的重试延迟超过 `retry.provider.maxRetryDelayMs` 时，请求会立即失败并返回说明性错误，而不是静默等待。设为 `0` 可禁用该限制。

除非明确需要 Provider 级重试，否则请将 `retry.provider.maxRetries` 保持为 `0`。将其设为大于 `0` 可能导致 SDK/Provider 在 Pi 看到用量超限错误前自行重试；某些情况下，这会阻塞 Agent，直到 Provider Quota 重置。

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### 消息投递

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | Steering 消息发送方式：`"all"` 或 `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | Follow-up 消息发送方式：`"all"` 或 `"one-at-a-time"` |
| `transport` | string | `"auto"` | 对支持多种 Transport 的 Provider，优先使用：`"sse"`、`"websocket"`、`"websocket-cached"` 或 `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP Header/Body 空闲超时，单位为毫秒；也用于具有显式 Stream 空闲超时的 Provider。设为 `0` 可禁用 |
| `websocketConnectTimeoutMs` | number | `15000` | 支持 WebSocket Transport 的 Provider 建立连接/打开握手的超时，单位为毫秒。设为 `0` 可禁用 |

### 终端与图片

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | 如果终端支持，则显示图片 |
| `terminal.imageWidthCells` | number | `60` | Inline 图片宽度，单位为终端 Cell |
| `terminal.clearOnShrink` | boolean | `false` | 内容缩小时清除空行（可能导致闪烁） |
| `images.autoResize` | boolean | `true` | 将图片尺寸调整到最大 2000x2000 |
| `images.blockImages` | boolean | `false` | 阻止向 LLM 发送任何图片 |

### Shell

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `shellPath` | string | - | 自定义 Shell 路径（例如 Windows 上的 Cygwin）；支持用开头的 `~` 表示 Home 目录 |
| `shellCommandPrefix` | string | - | 每条 Bash 命令使用的前缀（例如 `"shopt -s expand_aliases"`） |
| `npmCommand` | string[] | - | npm Package 查询/安装操作所用的命令 argv（例如 `["mise", "exec", "node@20", "--", "npm"]`） |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` 用于所有 npm Package Manager 操作，包括安装、卸载，以及 Git Package 内部的依赖安装。用户范围的 npm Package 安装到 `~/.pi/agent/npm/`；项目范围的 npm Package 安装到 `.pi/npm/`。请按照进程实际启动方式填写 argv 风格条目。配置 `npmCommand` 后，Git Package 依赖安装会使用普通 `install`，避免向 Wrapper 或其他 Package Manager 传入 npm 特有 Flag。

### Session

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Session 文件存储目录；支持绝对路径、相对路径和 `~` |

```json
{ "sessionDir": ".pi/sessions" }
```

多个来源同时指定 Session 目录时，优先级依次为 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR`、settings.json 中的 `sessionDir`。

### 模型循环切换

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Ctrl+P 循环切换使用的模型 Pattern（格式与 `--models` CLI Flag 相同） |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Code Block 缩进 |

### 资源

以下设置定义从何处加载 Extension、Skill、Prompt 和 Theme。

`~/.pi/agent/settings.json` 中的路径相对于 `~/.pi/agent` 解析；`.pi/settings.json` 中的路径相对于 `.pi` 解析。支持绝对路径和 `~`。

| 设置 | 类型 | 默认值 | 说明 |
|---------|------|---------|-------------|
| `packages` | array | `[]` | 要从中加载资源的 npm/Git Package |
| `extensions` | string[] | `[]` | 本地 Extension 文件路径或目录 |
| `skills` | string[] | `[]` | 本地 Skill 文件路径或目录 |
| `prompts` | string[] | `[]` | 本地 Prompt Template 文件路径或目录 |
| `themes` | string[] | `[]` | 本地 Theme 文件路径或目录 |
| `enableSkillCommands` | boolean | `true` | 将 Skill 注册为 `/skill:name` 命令 |

数组支持 Glob Pattern 和排除项。使用 `!pattern` 排除；使用 `+path` 强制包含精确路径，使用 `-path` 强制排除精确路径。

#### packages

字符串形式会加载 Package 中的所有资源：

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

对象形式可以筛选要加载的资源：

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

Package 管理详情参阅 [packages.md](packages.md)。

## 示例

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "strategy": "local",
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## 项目覆盖

项目设置（`.pi/settings.json`）会覆盖全局设置。嵌套对象会被合并：

```json
// ~/.pi/agent/settings.json（全局）
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json（项目）
{
  "compaction": { "reserveTokens": 8192 }
}

// 结果
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
