> Pi 可以创建 Prompt Template。你可以让它为自己的工作流构建一个。

# Prompt Template

Prompt Template 是可以展开为完整 Prompt 的 Markdown 片段。在 Editor 中输入 `/name` 即可调用 Template，其中 `name` 是不含 `.md` 的文件名。

## 位置

Pi 从以下位置加载 Prompt Template：

- 全局：`~/.pi/agent/prompts/*.md`
- 项目：`.pi/prompts/*.md`（仅在项目受信任后）
- Package：`prompts/` 目录或 `package.json` 中的 `pi.prompts` 条目
- 设置：包含文件或目录的 `prompts` 数组
- CLI：`--prompt-template <path>`（可重复使用）

使用 `--no-prompt-templates` 禁用自动发现。

## 格式

```markdown
---
description: 检查已暂存的 Git 更改
---
检查已暂存的更改（`git diff --cached`），重点关注：
- Bug 和逻辑错误
- 安全问题
- 错误处理缺口
```

- 文件名会成为命令名称。`review.md` 对应 `/review`。
- `description` 可选。如果缺少该字段，则使用第一个非空行。
- `argument-hint` 可选。设置后，提示会显示在自动补全下拉列表的说明之前。

### 参数提示

在 Frontmatter 中使用 `argument-hint`，可以在自动补全中显示预期参数。必填参数使用 `<尖括号>`，可选参数使用 `[方括号]`：

```markdown
---
description: 根据 URL 检查 PR，并进行结构化 Issue 与代码分析
argument-hint: "<PR-URL>"
---
```

在自动补全下拉列表中显示为：

```
→ pr   <PR-URL>       — 根据 URL 检查 PR，并进行结构化 Issue 与代码分析
  is   <issue>        — 分析 GitHub Issue（Bug 或功能请求）
  wr   [instructions] — 端到端完成当前任务
  cl   — 发布前审计 Changelog 条目
```

## 使用

在 Editor 中输入 `/`，然后输入 Template 名称。自动补全会显示可用 Template 及其说明。

```
/review                           # 展开 review.md
/component Button                 # 带参数展开
/component Button "click handler" # 多个参数
```

## 参数

Template 支持位置参数、默认值和简单切片：

- `$1`、`$2`……表示位置参数
- `$@` 或 `$ARGUMENTS` 表示拼接后的全部参数
- `${1:-default}` 在参数 1 存在且非空时使用该参数，否则使用 `default`
- `${@:-default}` 或 `${ARGUMENTS:-default}` 在参数存在且非空时使用全部参数，否则使用 `default`
- `${@:N}` 表示从第 N 个位置开始的参数（从 1 开始计数）
- `${@:N:L}` 表示从 N 开始的 `L` 个参数

示例：

```markdown
---
description: 创建组件
---
创建名为 $1 的 React 组件，并包含以下功能：$@
```

默认值适用于可选参数：

```markdown
使用 ${1:-7} 个要点总结当前状态。
```

用法：`/component Button "onClick handler" "disabled support"`

## 加载规则

- `prompts/` 中的 Template 自动发现不会递归。
- 如果需要加载子目录中的 Template，请通过 `prompts` 设置或 Package Manifest 显式添加。
