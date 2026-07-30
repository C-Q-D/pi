# 快捷键

所有键盘快捷键都可以通过 `~/.pi/agent/keybindings.json` 自定义。每个操作可以绑定一个或多个按键。

配置文件使用带 Namespace 的 Keybinding ID，与 Pi 内部以及 Extension 作者在 `keyHint()` 和注入的 `keybindings` Manager 中使用的 ID 相同。

使用 `cursorUp` 或 `expandTools` 等旧式非 Namespace ID 的配置，会在启动时自动迁移为带 Namespace 的 ID。

编辑 `keybindings.json` 后，在 Pi 中运行 `/reload` 即可应用更改，无需重启 Session。

## 按键格式

格式为 `modifier+key`。修饰键可以是 `ctrl`、`shift`、`alt`（可组合），按键包括：

- **字母：** `a-z`
- **数字：** `0-9`
- **特殊键：** `escape`、`esc`、`enter`、`return`、`tab`、`space`、`backspace`、`delete`、`insert`、`clear`、`home`、`end`、`pageUp`、`pageDown`、`up`、`down`、`left`、`right`
- **功能键：** `f1`-`f12`
- **符号：** `` ` ``、`-`、`=`、`[`、`]`、`\`、`;`、`'`、`,`、`.`、`/`、`!`、`@`、`#`、`$`、`%`、`^`、`&`、`*`、`(`、`)`、`_`、`+`、`|`、`~`、`{`、`}`、`:`、`<`、`>`、`?`

修饰键组合示例：`ctrl+shift+x`、`alt+ctrl+x`、`ctrl+shift+alt+x`、`ctrl+1` 等。

## 所有操作

### TUI 编辑器光标移动

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `tui.editor.cursorUp` | `up` | 光标上移 |
| `tui.editor.cursorDown` | `down` | 光标下移 |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | 光标左移 |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | 光标右移 |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | 光标向左移动一个单词 |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | 光标向右移动一个单词 |
| `tui.editor.cursorLineStart` | `home`, `ctrl+a` | 移动到行首 |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+e` | 移动到行尾 |
| `tui.editor.jumpForward` | `ctrl+]` | 向前跳转到字符 |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | 向后跳转到字符 |
| `tui.editor.pageUp` | `pageUp` | 向上滚动一页 |
| `tui.editor.pageDown` | `pageDown` | 向下滚动一页 |

### TUI 编辑器删除

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `tui.editor.deleteCharBackward` | `backspace` | 向后删除字符 |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | 向前删除字符 |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | 向后删除单词 |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | 向前删除单词 |
| `tui.editor.deleteToLineStart` | `ctrl+u` | 删除到行首 |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | 删除到行尾 |

### TUI 输入

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | 插入新行 |
| `tui.input.submit` | `enter` | 提交输入 |
| `tui.input.tab` | `tab` | Tab / 自动补全 |

### TUI Kill Ring

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `tui.editor.yank` | `ctrl+y` | 粘贴最近删除的文本 |
| `tui.editor.yankPop` | `alt+y` | Yank 后循环选择已删除文本 |
| `tui.editor.undo` | `ctrl+-` | 撤销上一次编辑 |

### TUI 剪贴板和选择

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `tui.input.copy` | `ctrl+c` | 复制选中内容 |
| `tui.select.up` | `up` | 选择项上移 |
| `tui.select.down` | `down` | 选择项下移 |
| `tui.select.pageUp` | `pageUp` | 列表向上翻页 |
| `tui.select.pageDown` | `pageDown` | 列表向下翻页 |
| `tui.select.confirm` | `enter` | 确认选择 |
| `tui.select.cancel` | `escape`, `ctrl+c` | 取消选择 |

### 应用

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `app.interrupt` | `escape` | 取消 / 中止 |
| `app.clear` | `ctrl+c` | 清空编辑器 |
| `app.exit` | `ctrl+d` | 退出（编辑器为空时） |
| `app.suspend` | `ctrl+z`（Windows 上无默认值） | 挂起到后台 |
| `app.editor.external` | `ctrl+g` | 在外部编辑器中打开（`externalEditor`、`$VISUAL`、`$EDITOR`、Windows 上的 Notepad，或其他平台的 `nano`） |
| `app.clipboard.pasteImage` | `ctrl+v`（Windows 上为 `alt+v`） | 从剪贴板粘贴图片 |

### Session

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `app.session.new` | *（无）* | 启动新 Session（`/new`） |
| `app.session.tree` | *（无）* | 打开 Session Tree Navigator（`/tree`） |
| `app.session.fork` | *（无）* | Fork 当前 Session（`/fork`） |
| `app.session.resume` | *（无）* | 打开 Session Resume Picker（`/resume`） |
| `app.session.togglePath` | `ctrl+p` | 切换路径显示 |
| `app.session.toggleSort` | `ctrl+s` | 切换排序模式 |
| `app.session.toggleNamedFilter` | `ctrl+n` | 切换仅显示已命名 Session 的 Filter |
| `app.session.rename` | `ctrl+r` | 重命名 Session |
| `app.session.delete` | `ctrl+d` | 删除 Session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Query 为空时删除 Session |

### 模型和 Thinking

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | 打开模型 Selector |
| `app.model.cycleForward` | `ctrl+p` | 循环切换到下一个模型 |
| `app.model.cycleBackward` | `shift+ctrl+p` | 循环切换到上一个模型 |
| `app.thinking.cycle` | `shift+tab` | 循环切换 Thinking Level |
| `app.thinking.toggle` | `ctrl+t` | 折叠或展开 Thinking Block |

### 显示和消息队列

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | 折叠或展开工具输出 |
| `app.message.copy` | `ctrl+x` | 复制最后一条 Assistant 消息，或 `/tree` 中选中的消息 |
| `app.message.followUp` | `alt+enter` | 将 Follow-up 消息加入队列 |
| `app.message.dequeue` | `alt+up` | 把队列中的消息恢复到编辑器 |

### Tree 导航

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | 折叠当前分支区段，或跳转到上一区段起点 |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | 展开当前分支区段，或跳转到下一区段起点或分支末尾 |
| `app.tree.editLabel` | `shift+l` | 编辑选中 Tree Node 的 Label |
| `app.tree.toggleLabelTimestamp` | `shift+t` | 切换 Tree 中的 Label 时间戳 |
| `app.tree.filter.default` | `ctrl+d` | 将 Tree Filter 设为默认视图 |
| `app.tree.filter.noTools` | `ctrl+t` | 切换隐藏 Tool Result 的 Tree Filter |
| `app.tree.filter.userOnly` | `ctrl+u` | 切换只显示用户消息的 Tree Filter |
| `app.tree.filter.labeledOnly` | `ctrl+l` | 切换只显示带 Label Entry 的 Tree Filter |
| `app.tree.filter.all` | `ctrl+a` | 切换显示所有 Entry 的 Tree Filter |
| `app.tree.filter.cycleForward` | `ctrl+o` | 向前循环切换 Tree Filter |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | 向后循环切换 Tree Filter |

### Scoped Model Selector

以下操作用于 Scoped Model Selector（通过 `/scoped-models` 打开）。

| Keybinding ID | 默认值 | 说明 |
|--------|---------|-------------|
| `app.models.save` | `ctrl+s` | 将当前模型选择保存到设置 |
| `app.models.enableAll` | `ctrl+a` | 启用所有模型（或当前搜索匹配的所有模型） |
| `app.models.clearAll` | `ctrl+x` | 清除所有模型（或当前搜索匹配的所有模型） |
| `app.models.toggleProvider` | `ctrl+p` | 切换当前 Provider 的所有模型 |
| `app.models.reorderUp` | `alt+up` | 在循环顺序中上移选中模型 |
| `app.models.reorderDown` | `alt+down` | 在循环顺序中下移选中模型 |

## 自定义配置

创建 `~/.pi/agent/keybindings.json`：

```json
{
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.editor.cursorDown": ["down", "ctrl+n"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

每个操作可以配置单个按键或按键数组。用户配置会覆盖默认值。

在原生 Windows 上，`app.suspend` 没有默认绑定，因为 Windows 终端不支持 Unix Job Control。如果手动绑定，Pi 会显示状态消息而不是挂起。在 WSL 中，仍采用正常的 Linux `ctrl+z`/`fg` 行为。

### Emacs 示例

```json
{
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.editor.cursorDown": ["down", "ctrl+n"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+f"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

### Vim 示例

```json
{
  "tui.editor.cursorUp": ["up", "alt+k"],
  "tui.editor.cursorDown": ["down", "alt+j"],
  "tui.editor.cursorLeft": ["left", "alt+h"],
  "tui.editor.cursorRight": ["right", "alt+l"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+w"]
}
```
