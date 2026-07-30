# 安全策略

本文用于帮助你理解 Pi 的安全理念及其边界。

总体而言，Pi 是一个在本地运行的 Coding Agent，其安全边界与启动它的用户相同。用户有责任监控其操作，或将其限制在 Container、虚拟机或其他 Sandbox 方案中。

Pi 将本地用户账户及该账户可写的文件视为与 Pi 进程本身处于同一信任边界。如果攻击者能够修改用户主目录、Workspace、Shell 启动文件、环境或 Pi 配置下的文件，通常也就能影响 Pi 或其他本地开发工具。依赖这种预先存在的本地写入权限的报告不属于安全漏洞，除非能够证明 Pi 如何授予了该写入权限，或如何跨越了操作系统权限边界。

Pi 要求用户只安装可信的 Extension、加载可信的 Skill，并且只在可信仓库中使用 Pi。这是因为 `AGENTS.md` 等文件或代码注释中的指令很容易对 Coding Agent 实施 Prompt Injection，而系统无法防止这种情况。

## 报告漏洞

如果你认为在 Pi 或本仓库的其他 Package 中发现了安全漏洞，请通过以下任一方式私下报告：

- 发送邮件至 `security@earendil.com`；或
- 通过本仓库的 GitHub Security Advisories 创建私密报告

请包含：

- 问题及其影响的说明
- 复现步骤、Proof of Concept 或相关日志
- 受影响的 Package、版本、Commit 或配置
- 已知的缓解措施

请勿为安全敏感报告创建公开 Issue。我们会审查报告，并视情况协调披露。

## 范围内事项

分发的 Package、命令行工具、API 和仓库代码中的安全问题属于处理范围，由 Earendil 运营的 `pi.dev` 基础设施也在范围内。

## 范围外事项

- 本地代码执行或 Sandbox 行为（Pi Coding Agent 刻意不内置 Sandbox）
- 用户安装的 Pi Extension 或 Skill 的行为
- 在不可信仓库中工作的风险
- 安装不可信 Extension、Skill、Package 或 Tool 的风险
- 不可信 MITM Proxy 导致的问题
- 将 Pi 安装暴露在公共互联网
- Prompt Injection 攻击
- 属于第三方或由用户控制的凭据泄露
- 要求能够在目标机器上创建、修改、删除或替换文件、目录、符号链接、环境变量、Shell 配置或其他由用户控制的本地状态的报告。这包括 `~/.pi`、`~/.pi/agent/models.json`、Workspace 文件、`AGENTS.md`、Skill、Extension、Extension 配置、Dotfile，以及通过 NFS、Roaming Profile 或 Dotfile Manager 同步的文件；除非报告能够证明 Pi 本身如何授予了该访问权限。
- 用户主动弱化配置导致的问题
- 需要使用可信本地输入或配置攻击 Pi Coding Agent 的资源消耗或 DOS 声明
- 关于恶意 Model 输出的报告
- 将用户批准或主动发起的本地操作描述为漏洞

## 报告者须知

最有价值的报告应展示当前存在、可以复现且具有明确影响的安全边界绕过。仅展示预期本地 Agent 行为、Prompt Injection，或恶意但已被信任的 Extension/Skill 的报告，在此安全模型下不属于安全漏洞。

例如，如果报告只证明写入可信 Pi 配置文件的恶意内容会导致 Pi 执行命令、加载攻击者控制的 Tool、向攻击者控制的 Endpoint 发送凭据，或以其他方式改变行为，则不在处理范围内。

请尽可能提供准确的受影响路径、Package 版本或 Commit SHA、配置，以及针对最新 Release 或最新 `main` 的 Proof of Concept。对于依赖问题，请提供证据证明随产品分发的依赖确实受到影响，并且该问题可以通过 Pi 触发。对于密钥泄露报告，请提供证据证明该凭据归 Earendil 所有，或能够访问由 Earendil 运营的基础设施或服务。
