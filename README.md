<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi 标志" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的 Issue 和 PR 默认会被自动关闭。维护者每天都会检查这些自动关闭的内容。详情参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

# Pi Agent Harness

这里是 Pi Agent Harness 项目的代码仓库，其中包括可自我扩展的 Coding Agent。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式 Coding Agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：支持工具调用和状态管理的 Agent 运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多 Provider LLM API（OpenAI、Anthropic、Google 等）

进一步了解 Pi：

* [访问 pi.dev](https://pi.dev)，查看项目网站和演示
* [阅读文档](https://pi.dev/docs/latest)，也可以直接让 Agent 介绍自身能力

## 所有 Package

| Package | 说明 |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | 统一的多 Provider LLM API（OpenAI、Anthropic、Google 等） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 支持工具调用和状态管理的 Agent 运行时 |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式 Coding Agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | 支持差量渲染的终端 UI 库 |

Slack/聊天自动化与工作流请参阅 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat)。

## 权限与容器化

Pi 不内置限制文件系统、进程、网络或凭据访问的权限系统。默认情况下，Pi 拥有启动它的用户和进程所具备的权限。

如果需要更严格的边界，请在容器或 Sandbox 中运行 Pi。三种可选模式参阅 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md)：

- **Gondolin Extension**：将 `pi` 和 Provider 认证保留在宿主机上，同时把内置工具和 `!` 命令路由到本地 Linux micro-VM。
- **普通 Docker**：在本地容器中运行整个 `pi` 进程，实现简单隔离。
- **OpenShell**：在受策略控制的 Sandbox 中运行整个 `pi` 进程。

## 参与贡献

贡献指南请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，面向开发者和 Agent 的项目规则请参阅 [AGENTS.md](AGENTS.md)。Pi 的长期规划还可以在 [RFC](https://rfc.earendil.com/keyword/pi/) 中查看。

## 开发

```bash
npm install --ignore-scripts  # 安装所有依赖，但不运行 lifecycle script
npm run build         # 刷新模型数据，然后构建所有 Package
npm run build:offline # 使用现有模型数据离线重新构建
npm run check         # 执行 lint、格式化和类型检查
./test.sh             # 运行测试（没有 API key 时跳过依赖 LLM 的测试）
./pi-test.sh          # 从源码运行 Pi（可在任意目录调用）
```

## 从发布源码构建独立二进制文件

GitHub Release 包含带版本的源码归档，并由该 Release 中的 `SHA256SUMS` 文件提供校验。解压后，运行官方独立二进制文件所使用的同一构建脚本：

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

源码归档包含该版本使用的已生成 Provider 模型数据。`--offline-model-data` 会使用这一数据快照构建，而不是从在线 Provider Catalog 刷新。脚本仍会安装依赖、构建 monorepo、编译 Bun 可执行文件，并整理其运行时资源。由其他方式提供依赖的 Package 维护者可以传入 `--skip-install --skip-deps`。

## 供应链加固

我们将 npm 依赖变更视为需要审查的代码变更。

- 直接外部依赖固定到精确版本；内部 workspace Package 仍使用版本范围。
- `.npmrc` 设置 `save-exact=true` 和 `min-release-age=2`，避免 npm 解析依赖时采用当天刚发布的版本。
- `package-lock.json` 是依赖关系的权威来源。除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`，否则 pre-commit 会阻止意外提交 lockfile。
- `npm run check` 会检查直接依赖是否固定版本、原生 TypeScript import 兼容性，以及生成的 Coding Agent shrinkwrap。
- 发布的 CLI Package 包含由根 lockfile 生成的 `packages/coding-agent/npm-shrinkwrap.json`，用于为 npm 用户固定传递依赖。
- Release smoke test 使用 `npm run release:local` 构建和打包，并在仓库外创建隔离的 npm 与 Bun 安装，然后才创建 Release Tag。
- 本地 Release 安装、文档中的 npm 安装命令以及 `pi update --self` 会在支持时使用 `--ignore-scripts`。
- CI 使用 `npm ci --ignore-scripts` 安装；定时 GitHub Workflow 会运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- Shrinkwrap 生成过程为依赖 lifecycle script 设置了显式 allowlist；包含新 lifecycle script 的依赖在完成审查前无法通过检查。

## 分享你的开源 Coding Agent Session

如果你使用 Pi 或其他 Coding Agent 参与开源工作，欢迎分享你的 Session。

公开的开源 Session 数据可以通过真实任务、工具使用、失败和修复过程帮助改进 Coding Agent，而不是只依赖玩具式 Benchmark。

完整说明参阅 [X 上的这篇帖子](https://x.com/badlogicgames/status/2037811643774652911)。

发布 Session 可使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。设置方法参阅其 README.md；你只需要 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

也可以观看[这段视频](https://x.com/badlogicgames/status/2041151967695634619)，其中演示了如何发布 `pi-mono` Session。

我会定期在此发布自己的 `pi-mono` 工作 Session：

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 许可证

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下机构慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy 吉祥物" width="48" /><br />exe.dev</a>
</p>
