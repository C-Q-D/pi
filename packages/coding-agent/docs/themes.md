> Pi 可以创建 Theme。你可以让它针对自己的环境构建一个。

# Theme

Theme 是定义 TUI 颜色的 JSON 文件。

## 目录

- [位置](#位置)
- [选择 Theme](#选择-theme)
- [创建自定义 Theme](#创建自定义-theme)
- [Theme 格式](#theme-格式)
- [颜色 Token](#颜色-token)
- [颜色值](#颜色值)
- [使用建议](#使用建议)

## 位置

Pi 从以下位置加载 Theme：

- 内置：`dark`、`light`
- 全局：`~/.pi/agent/themes/*.json`
- 项目：`.pi/themes/*.json`（仅在项目受信任后）
- Package：`themes/` 目录或 `package.json` 中的 `pi.themes` 条目
- 设置：包含文件或目录的 `themes` 数组
- CLI：`--theme <path>`（可重复使用）

使用 `--no-themes` 禁用自动发现。

## 选择 Theme

通过 `/settings` 或在 `settings.json` 中选择 Theme：

```json
{
  "theme": "my-theme"
}
```

首次运行时，Pi 会检测 Terminal 背景，并默认选择 `dark` 或 `light`。

## 创建自定义 Theme

1. 创建 Theme 文件：

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

2. 定义 Theme 所需的全部颜色（参阅[颜色 Token](#颜色-token)）：

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

3. 通过 `/settings` 选择 Theme。

**热重载：** 编辑当前启用的自定义 Theme 文件时，Pi 会自动重新加载，以便立即查看视觉效果。

## Theme 格式

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` 必填，必须唯一，且不能包含 `/`。
- `vars` 可选。可以在这里定义可复用的颜色，然后在 `colors` 中引用。
- `colors` 必须定义全部 51 个必需 Token。`thinkingMax` 可选，未提供时回退到 `thinkingXhigh`。

`$schema` 字段用于启用 Editor 自动补全和验证。

## 颜色 Token

每个 Theme 都必须定义全部 51 个必需颜色 Token。为兼容现有 Theme，`thinkingMax` 是可选项；省略时使用 `thinkingXhigh`。

### 核心 UI（11 种颜色）

| Token | 用途 |
|-------|---------|
| `accent` | 主要强调色（Logo、选中项、光标） |
| `border` | 普通边框 |
| `borderAccent` | 高亮边框 |
| `borderMuted` | 弱化边框（Editor） |
| `success` | 成功状态 |
| `error` | 错误状态 |
| `warning` | 警告状态 |
| `muted` | 次要文本 |
| `dim` | 第三级文本 |
| `text` | 默认文本（通常为 `""`） |
| `thinkingText` | Thinking Block 文本 |

### 背景与内容（11 种颜色）

| Token | 用途 |
|-------|---------|
| `selectedBg` | 选中行背景 |
| `userMessageBg` | User 消息背景 |
| `userMessageText` | User 消息文本 |
| `customMessageBg` | Extension 消息背景 |
| `customMessageText` | Extension 消息文本 |
| `customMessageLabel` | Extension 消息标签 |
| `toolPendingBg` | Tool 框（等待中） |
| `toolSuccessBg` | Tool 框（成功） |
| `toolErrorBg` | Tool 框（错误） |
| `toolTitle` | Tool 标题 |
| `toolOutput` | Tool 输出文本 |

### Markdown（10 种颜色）

| Token | 用途 |
|-------|---------|
| `mdHeading` | 标题 |
| `mdLink` | 链接文本 |
| `mdLinkUrl` | 链接 URL |
| `mdCode` | 行内代码 |
| `mdCodeBlock` | 代码块内容 |
| `mdCodeBlockBorder` | 代码块边界 |
| `mdQuote` | 引用文本 |
| `mdQuoteBorder` | 引用边框 |
| `mdHr` | 水平分隔线 |
| `mdListBullet` | 列表项目符号 |

### Tool Diff（3 种颜色）

| Token | 用途 |
|-------|---------|
| `toolDiffAdded` | 新增行 |
| `toolDiffRemoved` | 删除行 |
| `toolDiffContext` | 上下文行 |

### 语法高亮（9 种颜色）

| Token | 用途 |
|-------|---------|
| `syntaxComment` | 注释 |
| `syntaxKeyword` | 关键字 |
| `syntaxFunction` | Function 名称 |
| `syntaxVariable` | 变量 |
| `syntaxString` | 字符串 |
| `syntaxNumber` | 数字 |
| `syntaxType` | 类型 |
| `syntaxOperator` | 运算符 |
| `syntaxPunctuation` | 标点 |

### Thinking Level 边框（6 个必需，1 个可选）

表示 Thinking Level 的 Editor 边框颜色（视觉层级从弱到强）：

| Token | 用途 |
|-------|---------|
| `thinkingOff` | 关闭 Thinking |
| `thinkingMinimal` | Minimal Thinking |
| `thinkingLow` | Low Thinking |
| `thinkingMedium` | Medium Thinking |
| `thinkingHigh` | High Thinking |
| `thinkingXhigh` | Extra High Thinking |
| `thinkingMax` | Maximum Thinking；可选，回退到 `thinkingXhigh` |

### Bash 模式（1 种颜色）

| Token | 用途 |
|-------|---------|
| `bashMode` | Bash 模式（`!` 前缀）下的 Editor 边框 |

### HTML 导出（可选）

`export` 部分控制 `/export` HTML 输出的颜色。如果省略，则根据 `userMessageBg` 推导颜色。

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## 颜色值

支持四种格式：

| 格式 | 示例 | 说明 |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6 位十六进制 RGB |
| 256 色 | `39` | xterm 256 色调色板索引（0–255） |
| 变量 | `"primary"` | 引用 `vars` 条目 |
| 默认 | `""` | Terminal 默认颜色 |

### 256 色调色板

- `0-15`：基础 ANSI 颜色（取决于 Terminal）
- `16-231`：6×6×6 RGB 色彩立方体（`16 + 36×R + 6×G + B`，其中 R、G、B 为 0–5）
- `232-255`：灰度渐变

### Terminal 兼容性

Pi 使用 24 位 RGB 颜色。大多数现代 Terminal 都支持这种格式（iTerm2、Kitty、WezTerm、Windows Terminal、VS Code）。对于只支持 256 色的旧 Terminal，Pi 会回退到最接近的颜色。

检查 True Color 支持：

```bash
echo $COLORTERM  # 应输出 "truecolor" 或 "24bit"
```

## 使用建议

**深色 Terminal：** 使用明亮、饱和且对比度较高的颜色。

**浅色 Terminal：** 使用较暗、柔和且对比度较低的颜色。

**色彩协调：** 从基础调色板（Nord、Gruvbox、Tokyo Night）开始，在 `vars` 中定义，并保持引用方式一致。

**测试：** 使用不同消息类型、Tool 状态、Markdown 内容和长段换行文本检查 Theme。

**VS Code：** 将 `terminal.integrated.minimumContrastRatio` 设为 `1`，以获得准确颜色。

## 示例

请参阅内置 Theme：
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)
