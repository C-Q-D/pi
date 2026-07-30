# 容器化

Pi 默认以完整权限运行，但在某些场景下，你可能希望更严格地控制 Pi 可以写入哪些目录，以及它能够访问哪些资源。

通常有两种方案：

1. 在隔离环境中运行整个 `pi` 进程；或者
2. 在宿主机上运行 `pi`，并把工具执行路由到隔离环境。

## 选择隔离模式

| 模式 | 隔离内容 | 适用场景 | 说明 |
| --- | --- | --- | --- |
| Gondolin Extension | 内置工具和 `!` 命令 | 将认证保留在宿主机，同时使用本地 micro-VM 隔离 | 参阅 [`examples/extensions/gondolin/`](../examples/extensions/gondolin/)。 |
| 普通 Docker | 本地 Container 中的整个 `pi` 进程 | 简单的本地隔离 | Provider API key 会进入 Container。 |
| OpenShell | 受策略控制的 Sandbox 中的整个 `pi` 进程 | 本地或远程托管 Sandbox | 需要 OpenShell Gateway |

Extension 会在 `pi` 进程所在的位置运行。如果在宿主机上运行 `pi` 并使用工具路由 Extension，其他自定义 Extension 工具仍会在宿主机运行，除非它们也把操作委派到隔离环境。

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) 是本地 Linux micro-VM。
如果希望在宿主机上运行 `pi`，同时把所有内置工具路由到 VM，请使用[示例 Extension](../examples/extensions/gondolin)。

设置：

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.pi/agent/extensions/gondolin
cd ~/.pi/agent/extensions/gondolin
npm install --ignore-scripts
```

在需要挂载的项目中运行：

```bash
cd /path/to/project
pi -e ~/.pi/agent/extensions/gondolin
```

该 Extension 把宿主机当前工作目录挂载到 VM 的 `/workspace`，并覆盖 `read`、`write`、`edit`、`bash`、`grep`、`find` 和 `ls`。
用户执行的 `!` 命令也会被路由到 VM。
对 `/workspace` 下文件的修改会同步写入宿主机。

要求：`@earendil-works/gondolin` 需要 Node.js >= 23.6.0，此外还需要通过 Package Manager 安装 QEMU。

## 普通 Docker

如果需要最简单的本地 Container 边界，可以在 Docker 中运行整个 `pi` 进程。

`Dockerfile.pi`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["pi"]
```

构建并运行：

```bash
docker build -t pi-sandbox -f Dockerfile.pi .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

`-v "$PWD:/workspace"` 会把当前目录挂载到 Container 的 `/workspace`。因此，与 Gondolin 示例一样，Docker 内对 `/workspace` 的读写会直接影响宿主机文件。

如果希望设置和 Session 只存在于 Container 中，请为 `/root/.pi/agent` 使用 Named Volume。挂载宿主机的 `~/.pi/agent` 会把宿主机认证和 Session 文件暴露给 Container。

## OpenShell

如果需要能够控制文件系统、进程、网络、凭据和推理的策略化 Sandbox，请使用 [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview)。
OpenShell 可以通过由 Docker、Podman 或 VM Runtime 支持的本地 Gateway 运行 Sandbox，也可以使用远程 Kubernetes Gateway。

每个 Sandbox 都需要一个活动 Gateway。
创建 Sandbox 前，先注册并选择 Gateway：

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

在 OpenShell Sandbox 中启动 `pi`：

```bash
openshell sandbox create --name pi-sandbox --from pi -- pi
```

在这种模式下，整个 `pi` 进程都运行在 Sandbox 内。
内置工具、`!` 命令和 Extension 工具都在 OpenShell 边界内执行。

如果 Gateway 位于远程，项目文件不会从宿主机 bind mount，因此 Sandbox 中的写入不会反映到本机。
请在 Sandbox 内克隆仓库，或使用 OpenShell 文件传输命令：

```bash
openshell sandbox upload pi-sandbox ./repo /workspace
openshell sandbox download pi-sandbox /workspace/repo ./repo-out
```

OpenShell Provider 可以把原始模型 API key 保留在 Sandbox 外。
配置 Inference Routing 后，Sandbox 内的代码可以调用 `https://inference.local`，Gateway 会向上游注入已配置的 Provider 凭据。
如果希望模型流量使用该路由，请将 Pi 配置为使用相应的 OpenAI-compatible 或 Anthropic-compatible Endpoint。
