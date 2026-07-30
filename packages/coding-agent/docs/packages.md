> Pi 可以帮助你创建 Pi Package。你可以让它打包自己的 Extension、Skill、Prompt Template 或 Theme。

# Pi Package

Pi Package 将 Extension、Skill、Prompt Template 和 Theme 打包在一起，以便通过 npm 或 git 分享。Package 可以在 `package.json` 的 `pi` key 下声明资源，也可以使用约定目录。

## 目录

- [安装与管理](#安装与管理)
- [Package Source](#package-source)
- [创建 Pi Package](#创建-pi-package)
- [Package 结构](#package-结构)
- [依赖](#依赖)
- [Package 筛选](#package-筛选)
- [启用和禁用资源](#启用和禁用资源)
- [作用域与去重](#作用域与去重)

## 安装与管理

> **安全提示：** Pi Package 运行时拥有完整系统访问权限。Extension 可以执行任意代码，Skill 也可以指示 Model 执行任何操作，包括运行可执行文件。安装第三方 Package 前请检查其源代码。

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # 也支持原始 URL
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # 显示设置中的已安装 Package
pi update                   # 仅更新 Pi
pi update --all             # 更新 Pi 和 Package，并协调固定的 Git ref
pi update --extensions      # 仅更新 Package 并协调固定的 Git ref
pi update --models          # 仅刷新 Model 目录
pi update --self            # 仅更新 Pi
pi update --self --force    # 即使已是当前版本也重新安装 Pi
pi update npm:@foo/bar      # 更新一个 Package
pi update --extension npm:@foo/bar
```

这些命令用于管理 Pi Package，`pi update` 还可以更新 Pi CLI 安装。卸载 Pi 本身的方法请参阅[快速开始](quickstart.md#卸载)。

默认情况下，`install` 和 `remove` 写入用户设置（`~/.pi/agent/settings.json`）。使用 `-l` 可改为写入项目设置（`.pi/settings.json`）。项目设置可以与团队共享；项目受信任后，Pi 会在启动时自动安装缺失的 Package。

如果只想试用 Package 而不正式安装，请使用 `--extension` 或 `-e`。这样只会在本次运行期间安装到临时目录：

```bash
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```

## Package Source

Pi 在设置和 `pi install` 中接受三种 Source 类型。

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- 带版本的 Spec 会固定版本，并在 Package 更新（`pi update --extensions`、`pi update --all`）时跳过。
- 用户安装位于 `~/.pi/agent/npm/`。
- 项目安装位于 `.pi/npm/`。
- 在 `settings.json` 中设置 `npmCommand`，可以让 npm Package 查询和安装操作固定使用 `mise` 或 `asdf` 等特定 Wrapper 命令。

示例：

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- 不带 `git:` 前缀时，只接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）。
- 带 `git:` 前缀时，接受简写格式，包括 `github.com/user/repo` 和 `git@github.com:user/repo`。
- 同时支持 HTTPS 和 SSH URL。
- SSH URL 自动使用已配置的 SSH key（遵循 `~/.ssh/config`）。
- 对于非交互运行（例如 CI），可以设置 `GIT_TERMINAL_PROMPT=0` 禁用凭据提示，并设置 `GIT_SSH_COMMAND`（例如 `ssh -o BatchMode=yes -o ConnectTimeout=5`）以快速失败。
- Ref 是固定的 Tag 或 Commit。`pi update --extensions` 和 `pi update --all` 不会将其移动到更新的 ref，但会把现有 Clone 协调到已配置的 ref。
- 使用 `pi install git:host/user/repo@new-ref` 更新设置，并把现有 Package 移动到新的固定 ref。
- Clone 到 `~/.pi/agent/git/<host>/<path>`（全局）或 `.pi/git/<host>/<path>`（项目）。
- 协调过程改变 Checkout 时，Pi 会重置并清理 Clone；如果存在 `package.json`，随后运行 `npm install`。

**SSH 示例：**
```bash
# git@host:path 简写（需要 git: 前缀）
pi install git:git@github.com:user/repo

# ssh:// 协议格式
pi install ssh://git@github.com/user/repo

# 带版本 ref
pi install git:git@github.com:user/repo@v1.0.0
```

### 本地路径

```
/absolute/path/to/package
./relative/path/to/package
```

本地路径指向磁盘上的文件或目录，添加到设置时不会复制。相对路径根据其所在的设置文件解析。如果路径指向文件，则将其作为单个 Extension 加载；如果指向目录，Pi 会按照 Package 规则加载资源。

## 创建 Pi Package

在 `package.json` 中添加 `pi` Manifest，或使用约定目录。加入 `pi-package` 关键字可以提高可发现性。

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

路径相对于 Package 根目录。数组支持 Glob 模式和 `!排除项`。

### Gallery 元数据

[Package Gallery](https://pi.dev/packages) 会显示带有 `pi-package` 标签的 Package。添加 `video` 或 `image` 字段可以显示预览：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**：仅支持 MP4。在桌面端悬停时自动播放，点击后打开全屏播放器。
- **image**：支持 PNG、JPEG、GIF 或 WebP，显示为静态预览。

同时设置时，Video 优先。

## Package 结构

### 约定目录

如果不存在 `pi` Manifest，Pi 会从以下目录自动发现资源：

- `extensions/` 加载 `.ts` 和 `.js` 文件
- `skills/` 递归查找包含 `SKILL.md` 的文件夹，并将顶层 `.md` 文件作为 Skill 加载
- `prompts/` 加载 `.md` 文件
- `themes/` 加载 `.json` 文件

## 依赖

第三方运行时依赖应放在 `package.json` 的 `dependencies` 中。不注册 Extension、Skill、Prompt Template 或 Theme 的依赖也应放在 `dependencies` 中。当 Pi 从 npm 或 git 安装 Package 时，会运行 `npm install`，因此这些依赖会自动安装。

Pi 为 Extension 和 Skill 随附核心 Package。如果导入其中任何一项，请在 `peerDependencies` 中以 `"*"` 范围列出，不要将其打包：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。

其他 Pi Package 必须包含在 Tarball 中。将它们添加到 `dependencies` 和 `bundledDependencies`，然后通过 `node_modules/` 路径引用其资源。Pi 使用独立的 Module Root 加载 Package，因此单独安装的 Package 不会发生冲突或共享 Module。

示例：

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package 筛选

在设置中使用对象形式，筛选 Package 加载的内容：

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` 和 `-path` 是相对于 Package 根目录的精确路径。

- 省略某个 key 表示加载该类型的全部内容。
- 使用 `[]` 表示不加载该类型的任何内容。
- `!pattern` 排除匹配项。
- `+path` 强制包含精确路径。
- `-path` 强制排除精确路径。
- Filter 叠加在 Manifest 之上，用于缩小已经允许的范围。

## 启用和禁用资源

使用 `pi config` 启用或禁用来自已安装 Package 和本地目录的 Extension、Skill、Prompt Template 与 Theme。`pi config` 默认从全局设置（`~/.pi/agent/settings.json`）启动；按 Tab 可在全局和项目本地模式之间切换。使用 `pi config -l` 可以从项目覆盖设置（`.pi/settings.json`）启动，并将继承的全局资源以暗色显示。

## 作用域与去重

Package 可以同时出现在全局和项目设置中。如果同一个 Package 同时存在，则项目条目优先；但如果项目条目设置了 `autoload: false`，它会作为增量应用到全局条目之上。身份判断规则：

- npm：Package 名称
- git：不含 ref 的仓库 URL
- 本地：解析后的绝对路径
