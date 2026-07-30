# Session

Pi 将对话保存为 Session，便于继续工作、从较早的 Turn 创建分支，以及重新访问之前的路径。

## Session 存储

Session 会自动保存到 `~/.pi/agent/sessions/`，并按工作目录组织。每个 Session 都是具有树形结构的 JSONL 文件。

```bash
pi -c                  # 继续最近的 Session
pi -r                  # 浏览并选择以前的 Session
pi --no-session        # 临时模式，不保存
pi --name "我的任务"   # 启动时设置 Session 显示名称
pi --session <path|id> # 使用指定 Session 文件或部分 Session ID
pi --fork <path|id>    # 从 Session 文件或部分 Session ID 创建新 Session
```

在交互模式中使用 `/session` 查看当前 Session 文件、Session ID、消息数量、Token 和费用。

JSONL 文件格式和 SessionManager API 参阅 [Session 格式](session-format.md)。

## Session 命令

| 命令 | 说明 |
|---------|-------------|
| `/resume` | 浏览并选择以前的 Session |
| `/new` | 启动新 Session |
| `/name <name>` | 设置当前 Session 的显示名称 |
| `/session` | 显示 Session 信息 |
| `/tree` | 浏览当前 Session Tree |
| `/fork` | 从以前的用户消息创建新 Session |
| `/clone` | 将当前活动分支复制到新 Session |
| `/compact [prompt]` | 总结较早的上下文；参阅[上下文压缩](compaction.md) |
| `/export [file]` | 将 Session 导出为 HTML |
| `/share` | 上传为私有 GitHub Gist，并生成可分享的 HTML 链接 |

## 恢复和删除 Session

`/resume` 会为当前项目打开交互式 Session Picker。`pi -r` 会在启动时打开同一个 Picker。

可以在 Picker 中：

- 直接输入文字进行搜索
- 使用 Ctrl+P 切换路径显示
- 使用 Ctrl+S 切换排序模式
- 使用 Ctrl+N 只显示已命名 Session
- 使用 Ctrl+R 重命名
- 使用 Ctrl+D 删除，然后确认

如果系统提供 `trash` CLI，Pi 会使用它删除文件，而不是永久移除。

## 命名 Session

使用 `/name <name>` 设置便于阅读的 Session 名称：

```text
/name 重构认证模块
```

使用 `--name` 或 `-n` 在启动时设置名称：

```bash
pi --name "重构认证模块"
pi --name "CI 审计" -p "审查这次构建失败"
```

已命名 Session 更容易在 `/resume` 和 `pi -r` 中找到。

## 使用 `/tree` 创建分支

Session 以树形结构存储。每个 Entry 都有 `id` 和 `parentId`，当前位置是活动叶节点。`/tree` 允许跳转到之前的任意位置并从那里继续，而无需创建新文件。

<p align="center"><img src="images/tree-view.png" alt="Tree 视图" width="600"></p>

结构示例：

```text
├─ user: "你好，可以帮我……"
│  └─ assistant: "当然可以……"
│     ├─ user: "试试方案 A……"
│     │  └─ assistant: "对于方案 A……"
│     │     └─ user: "成功了……"  ← 活动节点
│     └─ user: "还是试试方案 B……"
│        └─ assistant: "对于方案 B……"
```

### Tree 操作

| 按键 | 操作 |
|-----|--------|
| ↑/↓ | 浏览可见 Entry |
| ←/→ | 向上/向下翻页 |
| Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ | 折叠/展开，或在分支区段之间跳转 |
| Shift+L | 设置或清除选中 Entry 的 Label |
| Shift+T | 切换 Label 时间戳 |
| Enter | 选择 Entry |
| Escape/Ctrl+C | 取消 |
| Ctrl+O | 循环切换 Filter 模式 |

Filter 模式包括：default、no-tools、user-only、labeled-only 和 all。可以在[设置](settings.md)中通过 `treeFilterMode` 配置默认值。

### 选择行为

选择用户消息或自定义消息时：

1. 将叶节点移动到所选消息的父节点。
2. 把所选消息文本放入编辑器。
3. 允许编辑并重新提交，从而创建新分支。

选择 Assistant、Tool、Compaction 或其他非用户 Entry 时：

1. 将叶节点移动到该 Entry。
2. 保持编辑器为空。
3. 允许从该位置继续。

选择根用户消息会把叶节点重置为空对话，并将原始 Prompt 放入编辑器。

## `/tree`、`/fork` 与 `/clone`

| 特性 | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| 输出 | 同一个 Session 文件 | 新 Session 文件 | 新 Session 文件 |
| 视图 | 完整 Tree | 用户消息 Selector | 当前活动分支 |
| 典型用途 | 在原处探索不同方案 | 从较早的 Prompt 启动新 Session | 继续前复制当前工作 |
| 摘要 | 可选的分支摘要 | 无 | 无 |

希望将不同方案保存在一起时使用 `/tree`；希望使用单独的 Session 文件时使用 `/fork` 或 `/clone`。

## 分支摘要

当 `/tree` 从一个分支切换到另一个分支时，Pi 可以总结被放弃的分支，并把摘要附加到新位置。这样无需重放整个分支，也能保留原路径中的重要上下文。

出现提示时，可以选择：

1. 不生成摘要
2. 使用默认 Prompt 生成摘要
3. 使用自定义重点指令生成摘要

分支摘要的内部机制和 Extension Hook 参阅[上下文压缩](compaction.md)。

## Session 格式

Session 文件采用 JSONL 格式，包含消息 Entry、模型变更、Thinking Level 变更、Label、Compaction、分支摘要和 Extension Entry。

Parser、Extension、SDK 用法和完整 SessionManager API 参阅 [Session 格式](session-format.md)。
