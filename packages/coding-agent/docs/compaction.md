# 上下文压缩与分支摘要

LLM 的 Context Window 有限。对话过长时，Pi 会压缩较早的内容，同时保留最近的工作。本页说明 Local、Remote、Auto 三种压缩策略、自动压缩、恢复方式和分支摘要。

> [!IMPORTANT]
> Remote 和 Auto 当前是 `fixture-verified experimental`：离线 Fixture 与 Faux Provider 已通过，但尚未调用真实 OpenAI 或 ChatGPT Codex 服务。默认策略仍为 Local。

主要实现文件：

- [`compaction.ts`](../src/core/compaction/compaction.ts)：Local 压缩准备、摘要和序列化
- [`metadata.ts`](../src/core/compaction/metadata.ts)：公开的压缩 Metadata 和错误边界
- [`portable-local-recovery.ts`](../src/core/compaction/portable-local-recovery.ts)：从 Remote Checkpoint 恢复为 Local
- [`branch-summarization.ts`](../src/core/compaction/branch-summarization.ts)：分支摘要
- [`session-manager.ts`](../src/core/session-manager.ts)：`CompactionEntry`、`RemoteCompactionEntry` 和 `BranchSummaryEntry`
- [`extensions/types.ts`](../src/core/extensions/types.ts)：Extension Event 与 `ctx.compact()` 类型

项目中的 TypeScript 定义也可以从 `node_modules/@earendil-works/pi-coding-agent/dist/` 查看。

## 两类摘要机制

| 机制 | 触发方式 | 作用 |
|---|---|---|
| 上下文压缩 | 接近 Context Window、发生 Overflow 或执行 `/compact` | 缩小当前活动分支要发送给模型的上下文 |
| 分支摘要 | 使用 `/tree` 切换分支 | 把离开分支的重要信息带到目标分支 |

两者都使用结构化 Summary Format，并累计跟踪文件操作。一次性摘要请求使用新的 Routing Session ID；Provider 支持时会禁用 Prompt Cache 写入，因为这类请求通常不会复用。

## 压缩策略

`compaction.strategy` 接受三个值：

| 策略 | 行为 | 失败处理 | 可移植性 |
|---|---|---|---|
| `local` | 由当前模型生成可读的文本摘要 | 失败即保持原分支不变 | 可跨 Provider、Model、Endpoint 和账号使用 |
| `remote` | 由受支持的 Provider 生成 Opaque Context | 显式失败，不自动降级 | 只允许原 Binding 继续消费 |
| `auto` | 先尝试 Remote；失败时最多执行一次 Local Fallback | Abort/Cancel 不 Fallback；其他 Remote 失败记录安全 `fallbackCode` 后转 Local | Fallback 后可移植 |

默认值是 `local`。可以在 `/settings` 中修改，也可以写入 `settings.json`：

```json
{
  "compaction": {
    "enabled": true,
    "strategy": "local",
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

全局位置是 `~/.pi/agent/settings.json`，项目位置是 `<project-dir>/.pi/settings.json`。项目设置会覆盖全局设置。非法的持久化策略不会改写原文件，Pi 会报告固定错误并按 Local 运行。

### 手动命令

```text
/compact
/compact --local
/compact --local 只关注关键决定
/compact --remote
/compact 只关注关键决定
```

规则如下：

- 无参数 `/compact` 使用当前 `compaction.strategy`。
- `--local` 只覆盖本次操作，不修改持久设置；后面可以带自定义指令。
- `--remote` 只覆盖本次操作，不修改持久设置；Remote 不接受自定义指令。
- 历史形式 `/compact <自定义指令>` 始终使用 Local，即使当前设置是 `remote` 或 `auto`。
- 当前没有 `/compact --auto`；要使用 Auto，请设置 `compaction.strategy: "auto"` 后执行无参数 `/compact`。
- 同一时间只允许一个压缩事务。重复触发会返回 `in_progress`，不会产生第二个 Checkpoint。

### 当前支持的 Remote Adapter

| API | 认证方式 | Protocol | 状态 |
|---|---|---|---|
| OpenAI Responses | API Key | `openai-responses-compact` | Fixture 已验证 |
| ChatGPT Codex Responses | ChatGPT OAuth | `openai-codex-remote-v2` | Fixture 已验证 |

Codex Legacy `/responses/compact` 尚未启用。当前实现不会根据模糊错误、HTTP Status 或消息文本自动发送第二次 Legacy 认证请求；只有取得官方或真实受控的 Unsupported Error Shape 证据后，才会单独设计和验证该兼容路径。

Anthropic、Google、Azure 自定义 Responses API 和未声明完整 Native Capability 的 Provider 不会伪装成 Remote Compaction。

## Remote Context 与 Exact Binding

Remote 结果是 Provider 生成的 Opaque Canonical Context。Pi 不解密、不解释，也不会把 `encrypted_content` 当成普通 Message。它只能由创建它的精确 Binding 继续消费。

Binding 包括：

- Provider
- API
- Model ID
- 解析后的 Endpoint
- Context Format 与 Version
- Producer Protocol
- 匿名 Credential Scope

API Key Scope 由完整 Key 的 SHA-256 派生；ChatGPT OAuth Scope 使用 Provider 提供的稳定账号 Subject。短期 Access Token 刷新不会让对话消失：只要账号 Subject 不变，新的 Token 可以继续消费同一个 Remote Context。切换账号、API Key、Provider、API、Model 或 Endpoint 时会在 Provider 请求前返回 `binding_mismatch`。

这种阻止不会删除 Session。原始对话仍保存在本地 JSONL 中，只有当前 Opaque Checkpoint 不能发送给新的 Binding。

## 从 Remote 恢复为 Local

要把当前分支变回 Provider 无关的 Local Summary，请执行：

```text
/compact --local
```

也可以加入 Local 自定义指令：

```text
/compact --local 保留关键决定、未完成工作和已修改文件
```

恢复流程：

1. 只沿当前 Leaf 的 Ancestor Chain 读取本地原始语义 Entry。
2. 排除所有 Local/Remote Checkpoint、Opaque Payload、管理 Entry、Sibling 和已经登记的 Overflow Error Entry。
3. 使用当前可用模型生成可读 Local Summary。
4. 成功后追加一个新的 Local `CompactionEntry`，重建 Agent Context，并清除活动 `providerContext`。
5. 如果摘要、Branch Guard、Append 或 Rebuild 失败，恢复原 Leaf；原 Remote Checkpoint 仍保持活动状态。

如果 Resume 后当前 Model 与 Remote Binding 不兼容，不要先发送普通 Prompt。直接运行 `/compact --local`，或者先恢复创建该 Checkpoint 时的原 Model、Endpoint 和账号。Local 恢复只依赖当前 Leaf 的本地 Raw Ancestry，不会把 Opaque Payload 交给摘要模型。

## 自动触发

### Threshold

上下文满足下式时触发 Threshold 压缩：

```text
contextTokens > contextWindow - reserveTokens
```

`reserveTokens` 默认是 16384，为下一次 LLM 响应留出空间。Threshold 只在完整 Provider Turn 结束后评估；同一个 Assistant Message 不会因一次失败而立刻重复压缩。压缩期间到达的 Follow-up 会继续按原队列顺序处理。

### Overflow

Provider 返回 Context Overflow 时，Pi 会：

1. 把原始 Assistant Error Entry 保留在 JSONL Audit 中。
2. 按 Entry ID 从压缩 Input 排除该 Error，而不是按时间戳或文本猜测。
3. 按当前策略执行一次压缩。
4. 只有成功 Commit 并 Rebuild 后，才重试原 Pending User/Tool Turn 一次。
5. 如果唯一一次重试仍然 Overflow，固定以 `capacity` 结束，不递归压缩。

压缩失败、Abort、Stale Branch 或 Commit 后 Rebuild 失败都不会重试 Pending Turn。已经持久化的 User Message 和 Tool Result 不会重复追加或重复执行。

## Local 压缩的工作方式

### 选择 Cut Point

Pi 从最新消息向前累计 Token Estimate，直到达到 `keepRecentTokens`（默认 20000），然后选择合法 Cut Point：

- User Message
- Assistant Message
- BashExecution Message
- Custom Message（`custom_message`、`branch_summary`）

Tool Result 不能单独作为 Cut Point，它必须与对应 Tool Call 一起保留。会话末尾是 Tool Result 时，Cut Point 会回到发起它的 Assistant Tool Call。

### 生成与提交

1. 从上一个保留边界或 Session 起点收集要摘要的消息。
2. 通过 `serializeConversation()` 转成文本。
3. 调用模型生成结构化摘要；存在旧 Local Summary 时，将其作为迭代上下文。
4. 追加包含 `summary`、`firstKeptEntryId`、`tokensBefore` 和可选 `usage` 的 `CompactionEntry`。
5. 从已提交 Session 重建为“Summary + Kept Messages”。

```text
压缩前：

  [较早的完整 Turn] [较新的完整 Turn] [最近消息]
          └──── messagesToSummarize ────┘ ↑
                                  firstKeptEntryId

压缩后实际发送给模型：

  [System Prompt] [Local Summary] [从 firstKeptEntryId 开始的消息]
```

连续 Local 压缩从上一个 Checkpoint 的 `firstKeptEntryId` 开始重新汇总，避免遗漏上次仍被保留的消息。`tokensBefore` 在提交前按实际重建 Context 重新计算。

### Split Turn

一个 User Turn 包含 User Message，以及下一个 User Message 前的 Assistant 回复和 Tool 调用。如果单个 Turn 本身超过 `keepRecentTokens`，Cut Point 可能落在 Turn 中部，这称为 Split Turn。

Pi 会分别生成：

1. History Summary：更早的完整上下文。
2. Turn Prefix Summary：被切开的当前 Turn 前半段。

两者随后合并。一次 Split Turn 因此可能产生两次摘要模型调用，测试和用量统计不能假设 Local 压缩永远只有一次 Provider 调用。

### Message 序列化

摘要前的消息会转成文本，例如：

```text
[User]: 用户输入
[Assistant thinking]: 内部 Thinking
[Assistant]: 回复文本
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Tool 输出
```

这能避免摘要模型把内容误认为需要继续的实时对话。Tool Result 在序列化时最多保留 2000 个字符，超出部分替换为包含截断字符数的标记。

## Session 持久化、Resume、Fork 与 Clone

Session JSONL 是 Append-only 的本地事实来源：

- 原始 User、Assistant 和 Tool Entry 不会因压缩而删除或改写。
- Local 使用 `compaction` Entry；Remote 使用独立的 `remote_compaction` Entry。
- Remote Entry 内部保存继续请求所需的 `providerContext`，因此 Session 文件本身应按敏感本地数据保护。
- Resume 会恢复当前 Leaf 上最新有效 Checkpoint。
- `/fork`、`/clone` 和 Branch Session 只沿所选 Leaf 的 Parent Chain 构建 Context，不读取 Sibling。
- Portable Local Recovery 同样只使用所选 Leaf 的 Raw Ancestry。

旧版 Reader 遇到未知的 Remote Entry 时会保持 Parent Chain 并恢复 Raw 或最近的旧 Local Context。当前格式中损坏的 Remote Entry、环、Orphan 或非法排除项会 Fail-closed，并返回可诊断的 Session Error，而不是静默截断历史。

## 隐私与可观察性

TUI、Tree、RPC、Extension Event 和 HTML Export 只输出白名单 Metadata，例如：

- `attemptId`、`operationId`
- `reason`
- `requestedStrategy`、`effectiveStrategy`
- `protocol`
- `provider`、`model`
- `tokensBefore`、`estimatedTokensAfter`、安全 Usage
- `fallbackCode`、`errorCode`
- `experimental: true`

这些边界不会输出：

- `providerContext` 或 `encrypted_content`
- Resolved Endpoint
- Credential Scope Hash
- Request/Response Body
- 原始 Provider Error/Cause/Stack

Remote 在 TUI 中只显示固定的 Opaque 提示，不把 Entry 中的 `summary` 当成可读 Provider 摘要。HTML Export 也只嵌入净化后的 External Entry。

受信 Extension 仍然是本地代码，可以自行使用 Node 文件 API 读取 Session JSONL；这种显式文件级权限不属于自动 DTO Privacy Gate。不要运行不可信 Extension，也不要公开上传包含 Remote Entry 的原始 Session 文件。

## Extension Hook

### `session_before_compact`

该 Event 在 `/compact`、Threshold 或 Overflow 压缩前触发：

```typescript
pi.on("session_before_compact", async (event) => {
  const {
    preparation,
    branchEntries,
    customInstructions,
    reason,
    requestedStrategy,
    willRetry,
    signal,
  } = event;

  // 任意策略都可以取消。
  if (shouldCancel()) return { cancel: true };

  // 只有 Local 或 Auto 可以提供自定义 Local 摘要。
  if (requestedStrategy !== "remote") {
    return {
      compaction: {
        summary: "自定义摘要",
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { source: "my-extension" },
      },
    };
  }
});
```

Hook 规则：

- `branchEntries` 已经过 External Privacy Gate，不包含 Remote Payload。
- `signal` 应传给 Hook 自己发起的异步模型调用。
- 显式 Remote 只接受 Cancel；返回自定义 Compaction 会得到 `invalid_hook_result`，不会偷偷转 Local。
- Local 和 Auto 可以采用 Hook 提供的 Local Result。
- Hook Result 会校验 Summary、Token、Usage 和 `firstKeptEntryId`，非法值不会提交。

### `ctx.compact()`

Extension 可以异步触发同一套事务：

```typescript
ctx.compact({
  requestedStrategy: "remote",
  onComplete: (result) => {
    // result 是 SanitizedCompactionResult，不包含 Provider Payload。
  },
  onError: (error) => {
    // error 已按公共边界净化。
  },
});
```

兼容规则与 TUI 相同：旧 Extension 的 `ctx.compact({ customInstructions: "..." })` 始终强制 Local，空字符串也按“已提供自定义指令字段”处理。`onComplete` 或 `onError` 自身抛错不会反向改变已经提交的压缩结果，也不会形成未处理的 Promise Rejection。

### 自定义 Local 摘要

要使用自己的模型生成摘要，可以调用 `convertToLlm()` 和 `serializeConversation()`：

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event) => {
  if (event.requestedStrategy === "remote") return;

  const conversationText = serializeConversation(
    convertToLlm(event.preparation.messagesToSummarize),
  );
  const { summary, usage } = await myModel.summarize(conversationText);

  return {
    compaction: {
      summary,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      usage,
    },
  };
});
```

完整示例见 [`custom-compaction.ts`](../examples/extensions/custom-compaction.ts)。

## RPC

RPC 的 `get_state` 包含 `compactionStrategy`。设置默认策略：

```json
{"type":"set_compaction_strategy","strategy":"auto"}
```

无 `customInstructions` 的 `compact` 使用当前配置：

```json
{"type":"compact"}
```

为了兼容旧客户端，只要 `customInstructions` 字段存在且是 string（包括空字符串），本次操作就使用 Local：

```json
{"type":"compact","customInstructions":"只保留关键决定"}
```

非 string 值会在调用 Session 或 Provider 前被拒绝。RPC Response 和 `compaction_start`/`compaction_end` Event 只返回 Sanitized Result 与固定错误信息。

## 分支摘要

### 触发方式

使用 `/tree` 导航到不同分支时，Pi 会询问是否摘要即将离开的分支。该摘要把旧分支的重要信息注入目标分支。

### 工作方式

1. 找到旧 Leaf 与目标位置的最深共同 Ancestor。
2. 收集共同 Ancestor 到旧 Leaf 之间的 Entry。
3. 从最新内容开始按 Token Budget 准备输入。
4. 调用模型生成结构化摘要。
5. 在导航位置追加 `BranchSummaryEntry`。

```text
导航前：

         ┌─ B ─ C ─ D（旧 Leaf）
    A ───┤
         └─ E ─ F（目标）

共同 Ancestor：A
要摘要的 Entry：B、C、D
```

### 累计文件跟踪

Local 压缩和分支摘要都会从以下来源累计提取文件操作：

- 本次摘要消息中的 Tool Call
- 之前 `CompactionEntry` 或 `BranchSummaryEntry` 的 `details`

因此，多次压缩或嵌套分支摘要仍能保留完整的已读与已修改文件列表。Extension 可以在 `details` 中保存自己的 JSON-serializable 数据。

### `session_before_tree`

该 Event 在 `/tree` 导航前触发，不论用户是否选择生成摘要：

```typescript
pi.on("session_before_tree", async (event) => {
  const { preparation } = event;

  // 取消导航。
  if (shouldCancel()) return { cancel: true };

  // 用户选择摘要时提供自定义摘要。
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "自定义分支摘要",
        details: { source: "my-extension" },
      },
    };
  }
});
```

## Summary Format

Local 压缩和分支摘要默认使用相同的结构化格式。字段名是摘要 Prompt 的稳定组成部分，因此保留英文；内容可以使用中文：

```markdown
## Goal
[用户要完成的目标]

## Constraints & Preferences
- [约束与偏好]

## Progress
### Done
- [x] [已完成内容]

### In Progress
- [ ] [进行中内容]

### Blocked
- [阻塞项]

## Key Decisions
- **[决定]**：[原因]

## Next Steps
1. [下一步]

## Critical Context
- [继续工作所需的信息]

<read-files>
path/to/file1.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

## 当前验证状态与限制

已完成的离线证据：

- Public Responses 与 Codex V2 Adapter 的 Request、Canonical Result、Replay、Retry、Abort 和错误矩阵。
- Manual、Threshold 和 Overflow 共用的 Single-flight Attempt/Commit Pipeline。
- Remote → Continue → Remote → Portable Local → Provider Switch → Continue。
- Codex V2 Compact → Continue → Close → Resume → Continue。
- API Key、OAuth Account、Endpoint 和 Model 变化的 0 Provider Dispatch Guard；同账号 Token Rotation 允许继续。
- Resume、Fork、Clone 只读取所选 Leaf，不读取 Sibling。
- TUI、Tree、RPC、Extension 和 HTML 的隐私标记审计。
- 全部组合链只使用 Faux Provider、固定 SSE/JSON 和临时 Session。

离线测试不能证明：

- 真实 OpenAI 或 ChatGPT Account 当前是否拥有远端压缩权限。
- 真实服务的 Header、Event Shape、错误 Shape 或计费是否与 Fixture 完全一致。
- 真实长对话中的压缩质量和 Token 收益。
- Codex Legacy Fallback 的 Unsupported 判定。

因此，在完成单独授权的真实用途 R1 测试前：

- 保持 `compaction.strategy: "local"` 作为默认值。
- 不要把 Remote 或 Auto 当作已正式发布的稳定能力。
- 测试 Remote 时优先使用隔离 Session，并保留本地 JSONL。
- 遇到 Binding 变化时使用 `/compact --local` 恢复，不要复制或解密 Opaque Payload。
