# 终端设置

Pi 使用 [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 来可靠检测修饰键。大多数现代终端都支持该协议，但部分终端需要额外配置。

## Kitty, iTerm2

无需配置即可使用。

## Apple 终端

Pi 会在可用时启用增强按键报告。如果 Terminal.app 仍然把 `Shift+Enter` 作为普通 Return 发送，Pi 会使用本地 macOS 修饰键回退机制，将该 Return 视为 `Shift+Enter`。

该回退机制仅在 Pi 与 Terminal.app 运行于同一台 Mac 时有效，无法通过远程 SSH 检测本地键盘。

## Ghostty

在 Ghostty 配置中添加以下内容（macOS：`~/Library/Application Support/com.mitchellh.ghostty/config`；Linux：`~/.config/ghostty/config`）：

```
keybind = alt+backspace=text:\x1b\x7f
```

较早版本的 Claude Code 可能添加过以下 Ghostty 映射：

```
keybind = shift+enter=text:\n
```

该映射发送原始换行字节。在 Pi 内部，这与 `Ctrl+J` 无法区分，因此 tmux 和 Pi 都无法再接收到真正的 `shift+enter` 按键事件。

如果只是为了 Claude Code 2.x 或更高版本而添加该映射，可以将其删除；但如果需要在 tmux 中使用 Claude Code，则仍然需要保留该 Ghostty 映射。

Pi 默认把 `Ctrl+J` 绑定为换行 Alias，因此通过该重映射，`Shift+Enter` 在 tmux 中仍可正常使用，无需额外配置 Pi。

## WezTerm

WezTerm 通常可以通过 xterm modifyOtherKeys 直接支持 `Shift+Enter`。如需显式使用 Kitty keyboard protocol，请创建 `~/.wezterm.lua`：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

在 macOS 上，WezTerm 默认将 `Option+Enter` 绑定为全屏。若要使用 `Option+Enter` 将消息加入 Pi Follow-up Queue，请添加以下按键覆盖：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

如果已有 `config.keys` 表，请将该条目加入其中。

在 WSL 上，WezTerm 可能需要可见的硬件光标才能定位 IME 候选窗口。如果中文等 CJK IME 候选项没有跟随文本光标，请在运行 Pi 前设置 `PI_HARDWARE_CURSOR=1`，或在设置中将 `showHardwareCursor` 设为 `true`。

## Alacritty

Alacritty 通常无需配置即可支持 `Shift+Enter`。在 macOS 上，`Option+Enter` 可能会被作为普通 `Enter` 发送。若要使用 `Option+Enter` 将消息加入 Pi Follow-up Queue，请在 `~/.config/alacritty/alacritty.toml` 中添加：

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

修改配置后重启 Alacritty。

## VS Code（集成终端）

VS Code 1.109.5 及更高版本默认在集成终端中启用 Kitty keyboard protocol，因此 `Shift+Enter` 应当无需配置即可使用。

低于 1.109.5 的 VS Code 版本需要为 `Shift+Enter` 显式配置终端 Keybinding。

`keybindings.json` 的位置：

- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

在 `keybindings.json` 中添加：

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Windows Terminal

在 `settings.json` 中添加以下内容（按 Ctrl+Shift+,，或依次选择 Settings → Open JSON file），以转发 Pi 使用的带修饰键 Enter：

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `Shift+Enter` 插入新行。
- Windows Terminal 默认将 `Alt+Enter` 绑定为全屏，这会阻止 Pi 接收用于 Follow-up Queue 的 `Alt+Enter`。
- 将 `Alt+Enter` 重映射到 `sendInput` 后，会把真实的组合键转发给 Pi。

如果已有 `actions` 数组，请将这些对象加入其中。如果旧的全屏行为仍然存在，请完全关闭并重新打开 Windows Terminal。

## xfce4-terminal, terminator

这些终端对 Escape Sequence 的支持有限，无法区分 `Ctrl+Enter`、`Shift+Enter` 等带修饰键的 Enter 和普通 `Enter`，因此 `submit: ["ctrl+enter"]` 等自定义 Keybinding 无法工作。

为获得最佳体验，请使用支持 Kitty keyboard protocol 的终端：

- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty)（编译时需要启用 Kitty protocol 支持）

## IntelliJ IDEA（集成终端）

内置终端对 Escape Sequence 的支持有限。在 IntelliJ 终端中，无法区分 Shift+Enter 和 Enter。

如需显示硬件光标，请在运行 Pi 前设置 `PI_HARDWARE_CURSOR=1`（为保持兼容性，默认禁用）。

建议使用独立的 Terminal Emulator，以获得最佳体验。
