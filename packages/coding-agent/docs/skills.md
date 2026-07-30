> Pi 可以创建 Skill。你可以让它针对自己的使用场景构建一个。

# Skill

Skill 是由 Agent 按需加载的自包含能力包。Skill 为特定任务提供专业工作流、设置说明、辅助脚本和参考文档。

Pi 实现了 [Agent Skills 标准](https://agentskills.io/specification)。对于大多数违规情况，Pi 会发出警告但仍保持宽松。虽然标准不允许 Skill 名称与父目录不同，但 Pi 允许这样做，因为该限制不适合在多个 Agent Harness 之间共享的 Skill 目录。

## 目录

- [位置](#位置)
- [Skill 的工作方式](#skill-的工作方式)
- [Skill 命令](#skill-命令)
- [Skill 结构](#skill-结构)
- [Frontmatter](#frontmatter)
- [验证](#验证)
- [示例](#示例)
- [Skill 仓库](#skill-仓库)

## 位置

> **安全提示：** Skill 可以指示 Model 执行任何操作，也可能包含由 Model 调用的可执行代码。使用前请检查 Skill 内容。

Pi 从以下位置加载 Skill：

- 全局：
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- 项目（仅在项目受信任后）：
  - `.pi/skills/`
  - `cwd` 及其祖先目录中的 `.agents/skills/`（最多查找到 Git 仓库根目录；不在仓库中时查找到文件系统根目录）
- Package：`skills/` 目录或 `package.json` 中的 `pi.skills` 条目
- 设置：包含文件或目录的 `skills` 数组
- CLI：`--skill <path>`（可重复使用；即使指定 `--no-skills` 也会追加加载）

自动发现规则：

- 在 `~/.pi/agent/skills/` 和 `.pi/skills/` 中，根目录下直接存在的 `.md` 文件会被发现为独立 Skill
- 在所有 Skill 位置中，会递归发现包含 `SKILL.md` 的目录
- 在 `~/.agents/skills/` 和项目 `.agents/skills/` 中，根目录的 `.md` 文件会被忽略

使用 `--no-skills` 禁用自动发现（通过 `--skill` 显式指定的路径仍会加载）。

### 使用其他 Harness 的 Skill

若要使用 Claude Code 或 OpenAI Codex 的 Skill，请将其目录添加到设置：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

对于项目级 Claude Code Skill，请添加到 `.pi/settings.json`：

```json
{
  "skills": ["../.claude/skills"]
}
```

## Skill 的工作方式

1. Pi 启动时扫描 Skill 位置，并提取名称和说明
2. System Prompt 按照[规范](https://agentskills.io/integrate-skills)，以 XML 格式列出可用 Skill
3. 任务匹配时，Agent 使用 `read` 加载完整 SKILL.md（Model 不一定总会这样做；可以通过 Prompt 或 `/skill:name` 强制加载）
4. Agent 按照指令执行，并使用相对路径引用脚本和 Asset

这就是渐进式披露：只有说明始终位于上下文中，完整指令按需加载。

## Skill 命令

Skill 会注册为 `/skill:name` 命令：

```bash
/skill:brave-search           # 加载并执行 Skill
/skill:pdf-tools extract      # 带参数加载 Skill
```

命令后的参数会以 `User: <args>` 的形式追加到 Skill 内容。

在交互模式中通过 `/settings`，或在 `settings.json` 中启用或禁用 Skill 命令：

```json
{
  "enableSkillCommands": true
}
```

## Skill 结构

Skill 是包含 `SKILL.md` 文件的目录，其他内容不限制形式。

```
my-skill/
├── SKILL.md              # 必需：Frontmatter + 指令
├── scripts/              # 辅助脚本
│   └── process.sh
├── references/           # 按需加载的详细文档
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md 格式

````markdown
---
name: my-skill
description: 此 Skill 的功能及使用时机。请具体说明。
---

# 我的 Skill

## 设置

首次使用前运行一次：
```bash
cd /path/to/skill && npm install
```

## 使用

```bash
./scripts/process.sh <input>
```
````

请使用相对于 Skill 目录的路径：

```markdown
详情请参阅[参考指南](references/REFERENCE.md)。
```

## Frontmatter

根据 [Agent Skills 规范](https://agentskills.io/specification#frontmatter-required)：

| 字段 | 必填 | 说明 |
|-------|----------|-------------|
| `name` | 是 | 最多 64 个字符。只能使用小写 a-z、数字 0-9 和连字符。与标准不同，Pi 不要求名称与父目录相同，因为该要求不适合共享 Skill 目录。 |
| `description` | 是 | 最多 1024 个字符。说明 Skill 的功能和使用时机。 |
| `license` | 否 | 许可证名称，或对随附文件的引用。 |
| `compatibility` | 否 | 最多 500 个字符。说明环境要求。 |
| `metadata` | 否 | 任意 key-value 映射。 |
| `allowed-tools` | 否 | 以空格分隔的预批准 Tool 列表（实验性）。 |
| `disable-model-invocation` | 否 | 设为 `true` 时，Skill 不会出现在 System Prompt 中，用户必须使用 `/skill:name`。 |

### 名称规则

- 长度为 1–64 个字符
- 只能包含小写字母、数字和连字符
- 不能以连字符开头或结尾
- 不能包含连续的连字符

Pi 不要求名称与父目录相同。Agent Skills 标准有此要求，但它不适合由多个 Tool 共用的共享 Skill 目录。

有效：`pdf-processing`、`data-analysis`、`code-review`

无效：`PDF-Processing`、`-pdf`、`pdf--processing`

### Description 最佳实践

Description 决定 Agent 何时加载 Skill，因此应具体说明。

良好示例：
```yaml
description: 从 PDF 文件中提取文本和表格、填写 PDF 表单并合并多个 PDF。处理 PDF 文档时使用。
```

不良示例：
```yaml
description: 帮助处理 PDF。
```

## 验证

Pi 按照 Agent Skills 标准验证 Skill。大多数问题只会产生警告，Skill 仍会加载：

- 名称超过 64 个字符或包含无效字符
- 名称以连字符开头/结尾，或包含连续连字符
- Description 超过 1024 个字符

未知 Frontmatter 字段会被忽略。

**例外：** 缺少 Description 的 Skill 不会加载。

名称冲突（不同位置存在同名 Skill）时会发出警告，并保留最先发现的 Skill。

## 示例

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md：**
````markdown
---
name: brave-search
description: 通过 Brave Search API 搜索网页并提取内容。搜索文档、事实或其他网页内容时使用。
---

# Brave Search

## 设置

```bash
cd /path/to/brave-search && npm install
```

## 搜索

```bash
./search.js "query"              # 基础搜索
./search.js "query" --content    # 包含页面内容
```

## 提取页面内容

```bash
./content.js https://example.com
```
````

## Skill 仓库

- [Anthropic Skills](https://github.com/anthropics/skills) — 文档处理（docx、pdf、pptx、xlsx）和 Web 开发
- [Pi Skills](https://github.com/badlogic/pi-skills) — Web 搜索、浏览器自动化、Google API 和转录
