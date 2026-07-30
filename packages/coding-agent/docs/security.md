# 安全

Pi 是本地 Coding Agent。它以启动它的用户账号权限运行，并将该用户可写的文件视为处于同一个本地信任边界内。

## 项目信任

项目信任控制 Pi 是否加载项目本地的设置、资源、Package 和 Extension。它不是 Sandbox，也不会限制开始在某个目录中工作后，模型可以要求工具执行哪些操作。

从当前工作目录发现以下任一内容时，Pi 会认为该项目包含需要信任的资源：

- `.pi/settings.json`
- `.pi/extensions`, `.pi/skills`, `.pi/prompts`, or `.pi/themes`
- `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md`
- 当前目录或祖先目录中的项目 `.agents/skills`

仅存在一个空的 `.pi` 目录，不会被视为需要信任的项目资源。

在包含受保护资源的项目中启动交互式 Session 时，如果当前目录及其父目录没有已保存的决定，Pi 会采用全局设置中的 `defaultProjectTrust`。默认值是 `"ask"`，即在 UI 可用时询问是否信任该项目。已保存的决定按照规范化目录存储在 `~/.pi/agent/trust.json` 中；当前路径或父路径上距离最近的已保存决定优先于全局默认值。

信任项目后，Pi 可以加载需要信任的项目资源，包括：

- `.pi/settings.json`
- `.pi` 中的 Extension、Skill、Prompt Template、Theme 和 System Prompt 文件等资源
- 通过项目设置配置、但本地尚未安装的项目 Package
- 项目本地 Extension，以及由项目 Package 管理的 Extension

拒绝信任会跳过受保护资源。除非禁用上下文加载，否则无论项目是否受信任，都会加载 `AGENTS.md` 和 `CLAUDE.md` 上下文文件。在信任状态确定前，Pi 只加载上下文文件、用户/全局 Extension，以及 CLI `-e` Extension。用户/全局和 CLI Extension 可以处理 `project_trust` 事件；第一个返回“是/否”决定的 Extension 将拥有该次决定权。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不会显示信任提示。如果没有适用的已保存决定，`defaultProjectTrust: "ask"` 和 `"never"` 会忽略这些资源，而 `"always"` 会信任它们。使用 `--approve`/`-a` 或 `--no-approve`/`-na` 可以只为本次运行覆盖项目信任设置。

## 不内置 Sandbox

Pi 不包含内置 Sandbox。内置工具能够以 Pi 进程的权限读取、写入和编辑文件，并运行 Shell 命令。Extension 是以相同权限运行的 TypeScript 模块。Package 安装、Shell 命令、Language Server、测试命令和其他开发工具的行为都与普通本地进程相同。

这是有意为之。Pi 的设计目标是在本地源码树中工作、调用项目工具链，并与用户现有的开发环境集成。如果只在进程内部实现部分 Sandbox，人们很容易误以为它构成了安全边界，但它实际上仍依赖宿主机的 Shell、文件系统、Package Manager、凭据和 Extension 代码。真正的隔离必须由操作系统或虚拟化/容器边界提供。

项目信任只是一道输入加载保护。它可以防止仓库在你批准前静默更改 Pi 的设置或 Extension，但不能让不受信任的代码、Prompt 或模型输出变得安全。来自仓库文件、注释、文档、上下文文件或构建输出的 Prompt Injection，是本地 Agent 的预期风险，Pi 无法可靠地阻止它。

## 运行不受信任或无人监督的任务

对于不受信任的仓库、你不准备密切监督的代码生成任务，或无人值守的自动化，请在受控环境中运行 Pi。可以使用 Container、VM、micro-VM、远程 Sandbox 或受策略控制的 Sandbox，并且只提供任务所需的文件和凭据。

常见模式参阅[容器化](containerization.md)：

- 在 Container/Sandbox 内运行整个 `pi` 进程
- 在宿主机运行 Pi，同时把内置工具执行路由到 Gondolin micro-VM
- 只挂载 Agent 应当访问的 workspace 路径
- 除非 Container 确实需要访问宿主机的 Session、设置和凭据，否则不要挂载宿主机的 `~/.pi/agent`
- 只传入最低限度的 API key，或使用短期凭据
- 任务不需要网络时限制网络访问
- 将结果复制回受信任系统前审查 Diff 和输出

如果以读写方式 bind mount 宿主机 workspace，Container 或 VM 内的写入仍然可以修改宿主机文件。需要更强的意外写入防护时，请使用只读挂载，或手动在 Sandbox 内外复制文件。

## 报告安全问题

报告安全问题时，请遵循仓库的[安全策略](https://github.com/earendil-works/pi-mono/blob/main/SECURITY.md)。涉及敏感安全信息时，不要创建公开 Issue。

预期的本地 Agent 行为、不内置 Sandbox、来自不受信任内容的 Prompt Injection，以及用户安装的 Extension 或 Skill 的行为，通常不属于安全边界。只有当报告证明存在真实的权限边界绕过，或证明 Pi 获得了本地用户原本不具备的访问权限时，才属于例外。
