# Provider

Pi 通过 OAuth 支持基于订阅的 Provider，也通过环境变量或认证文件支持使用 API key 的 Provider。Pi 随附内置目录；已配置的 Provider 可以刷新较新的目录，并将其缓存在 `~/.pi/agent/models-store.json` 中以供离线使用。

## 目录

- [订阅](#订阅)
- [API Key](#api-key)
- [认证文件](#认证文件)
- [云 Provider](#云-provider)
- [llama.cpp](#llamacpp)
- [自定义 Provider](#自定义-provider)
- [解析顺序](#解析顺序)

## 订阅

在交互模式中使用 `/login`，然后选择一个 Provider：

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- xAI（Grok/X 订阅）
- OpenRouter（通过 OAuth 创建 API key，并从 OpenRouter 余额中计费）
- Radius

使用 `/logout` 清除凭据。Token 存储在 `~/.pi/agent/auth.json` 中，并会在过期时自动刷新。OpenRouter 则会创建一个由用户控制、不会自动过期的 API key。

### OpenAI Codex

- 需要 ChatGPT Plus 或 Pro 订阅
- 获得 OpenAI 官方认可：[Codex for OSS](https://developers.openai.com/community/codex-for-oss)

### Claude Pro/Max

Claude Pro/Max 账户可以使用 Anthropic 订阅认证。第三方 Harness 的用量来自 [extra usage](https://claude.ai/settings/usage)，按 token 计费，不占用 Claude 套餐限额。

### GitHub Copilot

- 直接按 Enter 使用 github.com，或输入你的 GitHub Enterprise Server 域名
- 如果出现 “model not supported”，请在 VS Code 中启用该 Model：Copilot Chat → Model 选择器 → 选择 Model → “Enable”

### xAI（Grok/X 订阅）

- 运行 `/login xai`，然后选择 **Use a subscription**
- 仍可通过 **Use an API key** 使用 `XAI_API_KEY`

### OpenRouter

- 运行 `/login openrouter`，然后选择 **Sign in with OpenRouter**，打开 OpenRouter PKCE 授权流程
- 授权会创建一个由用户控制的 OpenRouter API key，并从你的 OpenRouter 余额中计费
- 在远程或无头设备上（例如通过 SSH 连接），浏览器无法访问 loopback 回调；请改为把最终重定向 URL（或授权码）粘贴到登录提示中
- 仍可通过 **Use an API key** 使用 `OPENROUTER_API_KEY`

### Radius

Radius 是一个动态 `pi-messages` Gateway。`/login radius` 会将 OAuth token 存入 `auth.json`；Gateway 目录独立刷新，并缓存在 `models-store.json` 中。可以在 `models.json` 中通过 `"oauth": "radius"` 和 Gateway 的 `baseUrl` 声明自定义 Radius Gateway。

## API Key

### 环境变量或认证文件

在交互模式中使用 `/login` 并选择 Provider，可将 API key 存入 `auth.json`；也可以通过环境变量设置凭据：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

| Provider | 环境变量 | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Radius | `RADIUS_API_KEY` | `radius` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Qwen Token Plan | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen-token-plan-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

环境变量和 `auth.json` key 的参考定义：[`packages/ai/src/env-api-keys.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts) 中的 [`const envMap`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/env-api-keys.ts)。

#### 认证文件

将凭据存入 `~/.pi/agent/auth.json`：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "ant-ling": { "type": "api_key", "key": "..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "nvidia": { "type": "api_key", "key": "nvapi-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "qwen-token-plan":  { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

该文件创建时使用 `0600` 权限（仅用户可读写）。认证文件中的凭据优先于环境变量。

API key 凭据还可以包含仅作用于当前 Provider 的环境变量值。在解析凭据 key、Provider/Model Header，以及 Cloudflare account ID、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY` 等 Provider 配置时，这些值优先于进程环境变量。

```json
{
  "cloudflare-ai-gateway": {
    "type": "api_key",
    "key": "$CLOUDFLARE_API_KEY",
    "env": {
      "CLOUDFLARE_API_KEY": "...",
      "CLOUDFLARE_ACCOUNT_ID": "account-id",
      "CLOUDFLARE_GATEWAY_ID": "gateway-id"
    }
  }
}
```

当 Pi 需要使用不同于项目 Shell 环境的 Provider 设置时，请使用这种方式。

### Key 解析

`key` 字段支持执行命令、环境变量插值和字面值：

- **Shell 命令：** 以 `"!command"` 开头时，会把整个值作为命令执行并使用 stdout（在进程生命周期内缓存）
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **环境变量插值：** `"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用对应变量的值。插值也可出现在更长的字面值中。
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` 表示变量 `FOO_BAR`；当 `BAR` 是字面文本时，请使用 `${FOO}_BAR`。缺少环境变量会导致该值无法解析。
- **转义：** `"$$"` 生成字面量 `"$"`；`"$!"` 生成字面量 `"!"`，且不会触发命令执行。
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **字面值：** 直接使用。`MY_API_KEY` 等纯大写字符串是字面值；引用环境变量时应使用 `$MY_API_KEY`。
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

通过 `/login` 获得的 OAuth 凭据也会存储在这里并自动管理。

## 云 Provider

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# 同样支持：https://your-resource.cognitiveservices.azure.com
# 同样支持：https://your-resource.openai.azure.com
# 根端点会自动规范化为 /openai/v1
# 也可以使用资源名称代替 base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# 可选
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock

使用 `/login amazon-bedrock` 存储 Bedrock API key，或配置以下任一种 AWS 环境凭据来源：

```bash
# 方式 1：AWS Profile
export AWS_PROFILE=your-profile

# 方式 2：IAM Key
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# 方式 3：Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# 可选区域（默认为 us-east-1）
export AWS_REGION=us-west-2
```

此外还支持 ECS task role（`AWS_CONTAINER_CREDENTIALS_*`）和 IRSA（`AWS_WEB_IDENTITY_TOKEN_FILE`）。

```bash
pi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

对于 ID 中包含可识别 Model 名称的 Claude Model（基础 Model 和系统定义的 inference profile），Prompt caching 会自动启用。对于 application inference profile（其 ARN 不包含 Model 名称），请设置 `AWS_BEDROCK_FORCE_CACHE=1` 以启用缓存点：

```bash
export AWS_BEDROCK_FORCE_CACHE=1
pi --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

如果连接到 Bedrock API Proxy，可以使用以下环境变量：

```bash
# 设置 Bedrock Proxy 的 URL（标准 AWS SDK 环境变量）
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# 如果 Proxy 不需要认证，请设置此项
export AWS_BEDROCK_SKIP_AUTH=1

# 如果 Proxy 仅支持 HTTP/1.1，请设置此项
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway

可以通过 `/login` 设置 `CLOUDFLARE_API_KEY`。Account ID 和 Gateway slug 可以通过环境变量设置，也可以写入 `auth.json` 中 API key 凭据的 `env` 对象。

```bash
export CLOUDFLARE_API_KEY=...           # 或使用 /login
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # 在 dash.cloudflare.com → AI → AI Gateway 中创建
pi --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

通过 Cloudflare AI Gateway 将请求路由到 OpenAI、Anthropic 和 Workers AI。Workers AI 使用 Unified API（`/compat`）和带前缀的 Model ID（`workers-ai/@cf/...`）。OpenAI 使用 OpenAI passthrough 路由（`/openai`）以及 `gpt-5.1` 等原生 OpenAI Model ID。Anthropic 使用 Anthropic passthrough 路由（`/anthropic`）以及 `claude-sonnet-4-5` 等原生 Anthropic Model ID。

AI Gateway 认证使用 `CLOUDFLARE_API_KEY` 作为 `cf-aig-authorization`。上游认证可以采用以下方式之一：

| 模式 | 请求认证 | 上游认证 |
|------|--------------|---------------|
| Workers AI | 仅 Cloudflare token | Cloudflare 原生认证 |
| Unified billing | 仅 Cloudflare token | Cloudflare 处理上游认证并扣减余额 |
| Stored BYOK | 仅 Cloudflare token | Cloudflare 注入存储在 AI Gateway 控制台中的 Provider key |
| Inline BYOK | Cloudflare token 加上游 `Authorization` Header | 请求提供上游 Provider key |

一般使用 Pi 时，建议选择 unified billing 或 stored BYOK。Inline BYOK 需要为 Cloudflare AI Gateway Provider 配置额外的上游 `Authorization` Header，例如通过 `models.json` 中的 Provider/Model 覆盖配置。

### Cloudflare Workers AI

可以通过 `/login` 设置 `CLOUDFLARE_API_KEY`。`CLOUDFLARE_ACCOUNT_ID` 可以通过环境变量设置，也可以写入 `auth.json` 中 API key 凭据的 `env` 对象。

```bash
export CLOUDFLARE_API_KEY=...           # 或使用 /login
export CLOUDFLARE_ACCOUNT_ID=...
pi --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

Pi 会自动设置 `x-session-affinity`，以获得 [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) 优惠。

### Google Vertex AI

使用 Application Default Credentials：

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

也可以将 `GOOGLE_APPLICATION_CREDENTIALS` 指向 service account key 文件。

## llama.cpp

Pi 支持 llama.cpp router server。使用 `/login llama.cpp` 配置它，通过 `/llama` 管理已加载的 Model，并使用 `/model` 选择已加载的 Model。

有关 Server 设置、Model 目录结构、环境变量和命令用法，请参阅 [llama.cpp](llama-cpp.md)。

## 自定义 Provider

**通过 models.json：** 添加 Ollama、LM Studio、vLLM，或任何兼容受支持 API（OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI）的 Provider。请参阅 [models.md](models.md)。

**通过 Extension：** 对于需要自定义 API 实现或 OAuth 流程的 Provider，请创建 Extension。请参阅 [custom-provider.md](custom-provider.md) 和 [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/)。

## 解析顺序

解析 Provider 凭据时，优先级如下：

1. CLI 的 `--api-key` 参数
2. `auth.json` 条目（API key 或 OAuth token）
3. 环境变量
4. `models.json` 中的自定义 Provider key
