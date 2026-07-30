# 自定义 Model

通过 `~/.pi/agent/models.json` 添加自定义 Provider 和 Model（Ollama、vLLM、LM Studio、Proxy 等）。

## 目录

- [最小示例](#最小示例)
- [完整示例](#完整示例)
- [Google AI Studio 示例](#google-ai-studio-示例)
- [支持的 API](#支持的-api)
- [Provider 配置](#provider-配置)
- [Model 配置](#model-配置)
- [覆盖内置 Provider](#覆盖内置-provider)
- [针对单个 Model 的覆盖配置](#针对单个-model-的覆盖配置)
- [Anthropic Messages 兼容性](#anthropic-messages-兼容性)
- [OpenAI 兼容性](#openai-兼容性)

## 最小示例

对于本地 Model（Ollama、LM Studio、vLLM），每个 Model 只需要提供 `id`：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

由于 Ollama 会忽略 `apiKey`，这里的值只是占位符。Pi 仍然认为 Model 需要完成认证后才能出现在 `/model` 中，因此不需要 key 的本地 Server 应保留一个虚拟值、使用 `/login` 为该 Provider 保存 key，或在选择 Model 时传入 `--api-key`。

某些兼容 OpenAI 的 Server 无法识别具备推理能力的 Model 所使用的 `developer` role。对于这些 Provider，请将 `compat.supportsDeveloperRole` 设为 `false`，使 Pi 改为以 `system` 消息发送 System Prompt。如果 Server 也不支持 `reasoning_effort`，还需将 `compat.supportsReasoningEffort` 设为 `false`。

可以在 Provider 层级设置 `compat`，使其应用于所有 Model；也可以在 Model 层级设置，以覆盖特定 Model 的配置。这通常适用于 Ollama、vLLM、SGLang 等兼容 OpenAI 的 Server。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

## 完整示例

需要指定具体值时，可以覆盖默认配置：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

每次打开 `/model` 时都会重新加载该文件，因此可以在 Session 期间修改，无需重启。

## Google AI Studio 示例

使用 `google-generative-ai` 并设置 `baseUrl`，可以添加 Google AI Studio 中的 Model，包括自定义 Gemma 4 条目：

```json
{
  "providers": {
    "my-google": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        {
          "id": "gemma-4-31b-it",
          "name": "Gemma 4 31B",
          "input": ["text", "image"],
          "contextWindow": 262144,
          "reasoning": true
        }
      ]
    }
  }
}
```

为 `google-generative-ai` API 类型添加自定义 Model 时，必须提供 `baseUrl`。

## 支持的 API

| API | 说明 |
|-----|-------------|
| `openai-completions` | OpenAI Chat Completions（兼容性最好） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

可以在 Provider 层级设置 `api`（作为所有 Model 的默认值），也可以在 Model 层级设置（按 Model 覆盖）。

## Provider 配置

| 字段 | 说明 |
|-------|-------------|
| `baseUrl` | API Endpoint URL |
| `api` | API 类型（见上文） |
| `apiKey` | 可选的 API key 配置（见下文“值解析”）。当认证由 `/login`、`auth.json` 或 CLI `--api-key` 提供时可省略。 |
| `oauth` | 动态 OAuth Provider 类型。目前支持 `"radius"`，并要求提供 Gateway `baseUrl`。 |
| `headers` | 自定义 Header（见下文“值解析”） |
| `authHeader` | 设为 `true` 时，自动添加 `Authorization: Bearer <apiKey>` |
| `models` | Model 配置数组 |
| `modelOverrides` | 针对此 Provider 中内置或由 Extension 注册的 Model，按 Model 覆盖配置 |

对于包含 `models` 的 Provider，非内置 Provider 配置必须提供 `baseUrl`，并在 Provider 或 Model 层级提供 `api`。加载文件并不要求设置 `apiKey`：通过 `/login`、`auth.json`、CLI `--api-key` 或 Provider 的 `apiKey` 完成认证后，Model 即可使用。如果未配置认证，Model 仍会加载，但不会出现在 `/model` 和 `--list-models` 的可用列表中。

### 值解析

`apiKey` 和 `headers` 字段支持执行命令、环境变量插值和字面值：

- **Shell 命令：** 以 `"!command"` 开头时，会把整个值作为命令执行并使用 stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **环境变量插值：** `"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用对应变量的值。插值也可出现在更长的字面值中。
  ```json
  "apiKey": "$MY_API_KEY"
  "apiKey": "${KEY_PREFIX}_${KEY_SUFFIX}"
  ```
  `$FOO_BAR` 表示变量 `FOO_BAR`；当 `BAR` 是字面文本时，请使用 `${FOO}_BAR`。缺少环境变量会导致该值无法解析。
- **转义：** `"$$"` 生成字面量 `"$"`；`"$!"` 生成字面量 `"!"`，且不会触发命令执行。
  ```json
  "apiKey": "$$literal-dollar-prefix"
  "apiKey": "$!literal-bang-prefix"
  ```
- **字面值：** 直接使用。`MY_API_KEY` 等纯大写字符串是字面值；引用环境变量时应使用 `$MY_API_KEY`。
  ```json
  "apiKey": "sk-..."
  ```

在 `models.json` 中，Shell 命令会在发出请求时解析。Pi 刻意不为任意命令内置 TTL、旧值复用或恢复逻辑，因为不同命令需要不同的缓存和失败处理策略，Pi 无法推断正确方案。

如果命令执行缓慢、成本较高、受到速率限制，或需要在暂时失败时继续使用旧值，请使用自己的脚本或命令封装它，并实现所需的缓存或 TTL 行为。

`/model` 的可用性检查仅判断是否存在已配置的认证信息，不会执行 Shell 命令。

### 自定义 Header

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "$PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

## Model 配置

| 字段 | 必填 | 默认值 | 说明 |
|-------|----------|---------|-------------|
| `id` | 是 | — | Model 标识符（传给 API） |
| `name` | 否 | `id` | 便于阅读的 Model 标签。用于匹配（`--model` 模式），并显示为 Model 的次要详情文本。 |
| `api` | 否 | Provider 的 `api` | 为当前 Model 覆盖 Provider 的 API |
| `reasoning` | 否 | `false` | 是否支持扩展思考 |
| `thinkingLevelMap` | 否 | 省略 | 将 Pi 的 Thinking Level 映射到 Provider 值，并标记不支持的 Level（见下文） |
| `input` | 否 | `["text"]` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | Context Window 大小（token 数） |
| `maxTokens` | 否 | `16384` | 最大输出 token 数 |
| `cost` | 否 | 全部为零 | 每百万 token 的费率，可包含作用于整个请求的输入定价层级 |
| `compat` | 否 | Provider 的 `compat` | Provider 兼容性覆盖配置。Provider 和 Model 层级同时设置时会合并。 |

费用层级提供一套完整的替代费率。当总输入用量（`input + cacheRead + cacheWrite`）超过 `inputTokensAbove` 时，该费率应用于整个请求。如果多个层级匹配，则采用阈值最高的层级。

```json
{
  "cost": {
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite": 6.25,
    "tiers": [
      {
        "inputTokensAbove": 272000,
        "input": 10,
        "output": 45,
        "cacheRead": 1,
        "cacheWrite": 12.5
      }
    ]
  }
}
```

当前行为：

- `/model`、`--list-models` 和交互界面 Footer 都按 Model `id` 显示条目。
- 配置的 `name` 用于 Model 匹配和次要详情文本，不会替换 Footer/Status Bar 中的 Model ID。

### Thinking Level 映射

在 Model 上使用 `thinkingLevelMap` 描述其专属的思考控制。Key 是 Pi 的 Thinking Level：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。映射可以不连续；例如，Model 可以提供 `high` 和 `max`，但不提供 `xhigh`。

值有三种状态：

| 值 | 含义 |
|-------|---------|
| 省略 | 从标准 Level 到 `high` 使用 Provider 的默认映射；不支持扩展的 `xhigh` 和 `max` |
| 字符串 | 支持该 Level，并将此值发送给 Provider |
| `null` | 不支持该 Level，界面会将其隐藏、跳过或限制到其他值 |

以下示例表示 Model 只支持关闭、high 和 max 推理：

```json
{
  "id": "deepseek-v4-pro",
  "reasoning": true,
  "thinkingLevelMap": {
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}
```

以下示例表示 Model 无法关闭思考：

```json
{
  "id": "always-thinking-model",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null
  }
}
```

迁移说明：使用 `compat.reasoningEffortMap` 的旧配置应将该映射移至 Model 层级的 `thinkingLevelMap`。不应出现在 UI 中的 Level 请设为 `null`。

## 覆盖内置 Provider

可以通过 Proxy 路由内置 Provider，而无需重新定义 Model：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

所有内置 Anthropic Model 仍然可用，现有 OAuth 或 API key 认证也会继续生效。

若要把自定义 Model 合并到内置 Provider 中，请加入 `models` 数组：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "$ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

合并规则：

- 保留内置 Model。
- 在 Provider 内按 `id` 插入或更新自定义 Model。
- 如果自定义 Model 的 `id` 与内置 Model 的 `id` 相同，自定义 Model 会替换该内置 Model。
- 如果自定义 Model 的 `id` 是新的，则将其添加到内置 Model 旁边。

## 针对单个 Model 的覆盖配置

使用 `modelOverrides` 可以自定义内置 Model 和匹配的 Extension 注册 Model，而无需替换 Provider 的完整 Model 列表。

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` 为每个 Model 支持以下字段：`name`、`reasoning`、`thinkingLevelMap`、`input`、`cost`（可部分设置）、`contextWindow`、`maxTokens`、`headers`、`compat`。

直接使用 OpenAI GPT-5.6 Sol、Terra 和 Luna 时，Context Window 默认为 `272000`，以使请求处于 OpenAI 的短上下文定价层级。如果要启用 OpenAI 的 1.05M Context Window，请分别增大所用 Model 的该配置：

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "contextWindow": 1050000
        }
      }
    }
  }
}
```

覆盖配置会保留内置定价元数据。当请求的总输入超过 272K token 时，整个请求都会采用 GPT-5.6 的长上下文费率。需要时，也请对 `gpt-5.6-terra` 或 `gpt-5.6-luna` 应用相同覆盖配置。

行为说明：

- `modelOverrides` 会应用于内置 Provider Model，以及匹配的 Extension 注册 Provider Model。
- 未知 Model ID 会被忽略。
- 可以组合使用 Provider 层级的 `baseUrl`/`headers` 与 `modelOverrides`。
- 覆盖 `name` 只会改变 Model 匹配和次要详情文本；Footer 和主要 Model 列表仍显示 Model `id`。
- 如果 Provider 同时定义了 `models`，自定义 Model 会在内置覆盖配置之后合并。具有相同 `id` 的自定义 Model 会替换已覆盖的内置 Model 条目。

## Anthropic Messages 兼容性

对于使用 `api: "anthropic-messages"` 的 Provider 或 Proxy，可以使用 `compat` 控制 Anthropic 专属的请求兼容性。

Pi 默认会为每个 Tool 发送 `eager_input_streaming: true`。如果 Proxy 或兼容 Anthropic 的 Backend 拒绝该字段，请将 `supportsEagerToolInputStreaming` 设为 `false`。Pi 将省略 `tools[].eager_input_streaming`，并改为在启用 Tool 的请求中发送旧版 `fine-grained-tool-streaming-2025-05-14` beta Header。

某些 Anthropic Model 要求使用 adaptive thinking（`thinking.type: "adaptive"` 加 `output_config.effort`），而不是旧版基于预算的 thinking payload。内置 Model 会自动设置。对于路由到这些 Model 的自定义 Provider 或别名，请将 `forceAdaptiveThinking` 设为 `true`。

某些兼容 Anthropic 的 Provider 会生成签名为空的 thinking block，并且仍要求在重放时包含这些 block。只有这类 Provider 才应将 `allowEmptySignature` 设为 `true`；真正的 Anthropic 会拒绝空的 thinking signature。

内置 Anthropic Model 会在 Model 元数据中启用 `supportsStrictTools`。如果自定义的 Anthropic 兼容 Model Endpoint 接受严格的 JSON Schema Tool 定义，则必须将其设为 `true`。

```json
{
  "providers": {
    "anthropic-proxy": {
      "baseUrl": "https://proxy.example.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_PROXY_KEY",
      "compat": {
        "supportsEagerToolInputStreaming": false,
        "supportsLongCacheRetention": true,
        "forceAdaptiveThinking": true,
        "allowEmptySignature": true
      },
      "models": [
        {
          "id": "claude-opus-4-7",
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

| 字段 | 说明 |
|-------|-------------|
| `supportsEagerToolInputStreaming` | Provider 是否接受每个 Tool 上的 `eager_input_streaming`。默认值：`true`。设为 `false` 时省略该字段，并在启用 Tool 的请求中使用旧版 fine-grained tool streaming beta Header。 |
| `supportsLongCacheRetention` | 当 cache retention 为 `long` 时，Provider 是否接受 Anthropic 长缓存保留（`cache_control.ttl: "1h"`）。默认值：`true`。 |
| `sendSessionAffinityHeaders` | 启用缓存时，是否根据 Session ID 发送 `x-session-affinity`。默认值：对已知 Provider 自动检测。 |
| `supportsCacheControlOnTools` | Provider 是否接受 Tool 定义上的 Anthropic 风格 `cache_control` 标记。默认值：`true`。 |
| `forceAdaptiveThinking` | 是否为当前 Model 发送 adaptive thinking（`thinking.type: "adaptive"` 加 `output_config.effort`）。内置 adaptive Model 会自动设置。默认值：`false`。 |
| `allowEmptySignature` | 是否将空 thinking signature 重放为 `signature: ""`，而不是把 thinking 转为文本。默认值：`false`。 |
| `supportsStrictTools` | Provider 是否接受严格的 JSON Schema Tool 定义。默认值：`false`；内置 Anthropic Model 会在生成的元数据中启用它。 |

## OpenAI 兼容性

对于只具备部分 OpenAI 兼容性的 Provider，请使用 `compat` 字段。

- Provider 层级的 `compat` 为该 Provider 下的所有 Model 提供默认值。
- Model 层级的 `compat` 为当前 Model 覆盖 Provider 层级的值。

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| 字段 | 说明 |
|-------|-------------|
| `supportsStore` | Provider 是否支持 `store` 字段 |
| `supportsDeveloperRole` | 使用 `developer` 还是 `system` role |
| `supportsReasoningEffort` | 是否支持 `reasoning_effort` 参数 |
| `supportsUsageInStreaming` | 是否支持 `stream_options: { include_usage: true }`（默认值：`true`） |
| `maxTokensField` | 使用 `max_completion_tokens` 还是 `max_tokens` |
| `requiresToolResultName` | 是否在 Tool Result 消息中包含 `name` |
| `requiresAssistantAfterToolResult` | 是否在 Tool Result 之后、User 消息之前插入 Assistant 消息 |
| `requiresThinkingAsText` | 是否将 thinking block 转为纯文本 |
| `requiresReasoningContentOnAssistantMessages` | 启用推理时，是否在所有重放的 Assistant 消息中包含空的 `reasoning_content` |
| `thinkingFormat` | 使用 `reasoning_effort`、`openrouter`、`deepseek`、`together`、`zai`、`qwen`、`chat-template` 或 `qwen-chat-template` thinking 参数 |
| `chatTemplateKwargs` | `thinkingFormat: "chat-template"` 的 `chat_template_kwargs` 值；使用 `{ "$var": "thinking.enabled" }` 或 `{ "$var": "thinking.effort" }` 表示由 Pi 控制的 thinking 值 |
| `cacheControlFormat` | 在 System Prompt、最后一个 Tool 定义，以及最后一段 User、Assistant 或 Tool Result 文本内容上使用 Anthropic 风格的 `cache_control` 标记。目前仅支持 `anthropic`。 |
| `sendSessionAffinityHeaders` | 对 `openai-completions`，启用缓存时是否根据 Session ID 发送 session-affinity Header。默认值：`false`。 |
| `sessionAffinityFormat` | 对 `openai-completions` 和 `openai-responses`，指定 session-affinity Header 格式：`openai` 发送 `session_id`/`x-client-request-id`（Completions 还发送 `x-session-affinity`）；`openai-nosession` 省略含下划线的 `session_id` Header；`openrouter` 发送 `x-session-id`。不影响 Body 中的 `prompt_cache_key` 参数。默认值：自动检测。 |
| `supportsStrictMode` | Provider 是否接受严格的 JSON Schema Function Tool 定义。默认值取决于 API；内置 OpenAI Model 带有明确的能力元数据。 |
| `supportsOpenAIGrammarTools` | 兼容 OpenAI 的 API 是否生成自定义 Lark/regex grammar Tool。设为 `false` 时，受 grammar 约束的 Tool 会回退为普通 Function Tool。默认值：`false`；内置 Model 目录会为 OpenAI、OpenAI Codex、Azure OpenAI、GitHub Copilot、opencode 和 Cloudflare AI Gateway 上的 GPT-5+ Model 启用它。 |
| `deferredToolsMode` | 使用 Provider 专属的 deferred Tool 序列化。目前仅支持 Kimi 的 OpenAI 兼容 Chat Completions 格式 `"kimi"`。 |
| `supportsLongCacheRetention` | 当 cache retention 为 `long` 时，Provider 是否接受长缓存保留：OpenAI Prompt caching 使用 `prompt_cache_retention: "24h"`；当 `cacheControlFormat` 为 `anthropic` 时使用 `cache_control.ttl: "1h"`。默认值：`true`。 |
| `openRouterRouting` | OpenRouter Provider 路由偏好。此对象会原样作为 [OpenRouter API 请求](https://openrouter.ai/docs/guides/routing/provider-selection)中的 `provider` 字段发送。 |
| `vercelGatewayRouting` | 用于选择 Provider 的 Vercel AI Gateway 路由配置（`only`、`order`） |

`openrouter` 使用 `reasoning: { effort }`。`together` 使用 `reasoning: { enabled }`，并在启用 `supportsReasoningEffort` 时同时使用 `reasoning_effort`。`qwen` 使用顶层的 `enable_thinking`。对于要求 `chat_template_kwargs.enable_thinking` 和 `preserve_thinking` 的本地 Qwen 兼容 Server，请使用 `qwen-chat-template`。对于需要可配置 `chat_template_kwargs` 的 vLLM/Hugging Face chat template，请使用 `chat-template`；例如，DeepSeek V3.x template 可使用 `chatTemplateKwargs: { "thinking": { "$var": "thinking.enabled" } }`。

`cacheControlFormat: "anthropic"` 适用于兼容 OpenAI、并通过文本内容和 Tool 定义上的 `cache_control` 标记提供 Anthropic 风格 Prompt caching 的 Provider。

示例：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "allow_fallbacks": true,
              "require_parameters": false,
              "data_collection": "deny",
              "zdr": true,
              "enforce_distillable_text": false,
              "order": ["anthropic", "amazon-bedrock", "google-vertex"],
              "only": ["anthropic", "amazon-bedrock"],
              "ignore": ["gmicloud", "friendli"],
              "quantizations": ["fp16", "bf16"],
              "sort": {
                "by": "price",
                "partition": "model"
              },
              "max_price": {
                "prompt": 10,
                "completion": 20
              },
              "preferred_min_throughput": {
                "p50": 100,
                "p90": 50
              },
              "preferred_max_latency": {
                "p50": 1,
                "p90": 3,
                "p99": 5
              }
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway 示例：

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "$AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
