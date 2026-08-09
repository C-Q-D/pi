import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const _os: typeof NodeOs | null = loadNodeOs();

import { parseOpenAICodexAccountId } from "../auth/oauth/openai-codex-jwt.ts";
import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	JsonObject,
	JsonValue,
	Model,
	NativeCompactionProviderRequest,
	NativeCompactionResult,
	NativeCompactionUsage,
	ProviderContextEnvelope,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import {
	cloneAndFreezeJson,
	createNativeCompactionError,
	sanitizeNativeCompactionError,
	validateNativeCompactionResult,
} from "../utils/native-compaction.ts";
import { assertNativeCompactionProviderRequest } from "../utils/native-request.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { resolveOpenAICodexCompactionRoutes, resolveOpenAICodexResponsesUrl } from "./openai-codex-responses-shared.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";
const CODEX_REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
const CODEX_REMOTE_COMPACTION_MAX_RETRIES = 2;
const CODEX_REMOTE_COMPACTION_RETAINED_TOKENS = 64_000;
const CODEX_REMOTE_COMPACTION_PAYLOAD_KEYS = new Set([
	"model",
	"store",
	"stream",
	"instructions",
	"input",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"temperature",
	"reasoning",
	"service_tier",
	"text",
	"include",
	"prompt_cache_key",
]);
const CODEX_REMOTE_COMPACTION_RETRYABLE_CODES = new Set([
	"server_error",
	"internal_server_error",
	"rate_limit_exceeded",
]);
const CODEX_REMOTE_COMPACTION_CAPACITY_CODES = new Set(["context_length_exceeded"]);
const CODEX_REMOTE_COMPACTION_TERMINAL_CODES = new Set([
	"insufficient_quota",
	"usage_not_included",
	"invalid_prompt",
	"bio_policy",
	"cyber_policy",
	"server_is_overloaded",
	"slow_down",
]);
const CODEX_REMOTE_COMPACTION_SERVICE_TIERS = new Set(["auto", "default", "flex", "scale", "priority"]);
const CODEX_REMOTE_COMPACTION_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const AUTHORIZED_CODEX_REPLAY_CONTEXTS = new WeakSet<object>();

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}

type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

type NativeCodexRequestBody = Readonly<RequestBody> & { readonly input: readonly JsonValue[] };

interface CodexCompactionAttemptResult {
	readonly item: JsonObject;
	readonly usage?: NativeCompactionUsage;
}

const CODEX_COMPACTION_RETRY_ERRORS = new WeakSet<object>();

/** 只向共享退避器传递延迟信息，避免响应头改写 Codex 固定重试分类。 */
function selectCodexCompactionRetryHeaders(headers: Headers | undefined): Headers | undefined {
	if (!headers) return undefined;
	const selected = new Headers();
	for (const key of ["retry-after", "retry-after-ms"]) {
		const value = headers.get(key);
		if (value !== null) selected.set(key, value);
	}
	return selected;
}

/** 只携带固定文本、供共享重试器识别的内部瞬态失败。 */
class CodexCompactionRetryError extends Error {
	readonly status: number | undefined;
	readonly headers: Headers | undefined;

	constructor(status?: number, headers?: Headers) {
		super("Codex remote compaction retryable failure");
		this.name = "CodexCompactionRetryError";
		this.status = status;
		this.headers = selectCodexCompactionRetryHeaders(headers);
		CODEX_COMPACTION_RETRY_ERRORS.add(this);
	}
}

/** Native 路径的 Abort 必须优先于 Provider 或 Protocol 错误。 */
function throwIfNativeCompactionAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw createNativeCompactionError("aborted");
}

/** 递归复制 Codex Wire JSON；与公共 Provider Context 不同，这里允许受控 Trigger。 */
function cloneCodexWireJsonValue(value: unknown, active: WeakSet<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw createNativeCompactionError("protocol");
		return value;
	}
	if (typeof value !== "object" || active.has(value)) throw createNativeCompactionError("protocol");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) throw createNativeCompactionError("protocol");
			const keys = Reflect.ownKeys(value);
			for (const key of keys) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
					throw createNativeCompactionError("protocol");
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) throw createNativeCompactionError("protocol");
			}
			const clone: JsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor)) throw createNativeCompactionError("protocol");
				clone.push(cloneCodexWireJsonValue(descriptor.value, active));
			}
			return Object.freeze(clone);
		}
		if (Object.getPrototypeOf(value) !== Object.prototype) throw createNativeCompactionError("protocol");
		const clone: Record<string, JsonValue> = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string" || CODEX_REMOTE_COMPACTION_DANGEROUS_KEYS.has(key)) {
				throw createNativeCompactionError("protocol");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw createNativeCompactionError("protocol");
			clone[key] = cloneCodexWireJsonValue(descriptor.value, active);
		}
		return Object.freeze(clone) as JsonObject;
	} finally {
		active.delete(value);
	}
}

/** 把未知 Callback 或 SSE 数据净化为冻结的 Plain JSON。 */
function cloneCodexWireJson(value: unknown): JsonValue {
	try {
		return cloneCodexWireJsonValue(value, new WeakSet());
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "protocol");
	}
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonValuesEqual(value, right[index]));
	}
	if (!isJsonObject(left) || !isJsonObject(right)) return false;
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
	return leftKeys.every((key) => jsonValuesEqual(left[key], right[key]));
}

function containsCompactionTrigger(value: JsonValue): boolean {
	if (Array.isArray(value)) return value.some(containsCompactionTrigger);
	if (!isJsonObject(value)) return false;
	if (value.type === "compaction_trigger") return true;
	return Object.values(value).some(containsCompactionTrigger);
}

function assertCanonicalPrefix(input: readonly JsonValue[], prefix: readonly JsonValue[]): void {
	if (input.length < prefix.length) throw createNativeCompactionError("protocol");
	for (let index = 0; index < prefix.length; index += 1) {
		if (!jsonValuesEqual(input[index], prefix[index])) throw createNativeCompactionError("protocol");
	}
}

function validateOptionalString(value: JsonValue | undefined): value is string | undefined {
	return value === undefined || typeof value === "string";
}

/** 校验 Callback 后的 V2/Replay Wire Body，并锁定 Canonical Prefix 与 Trigger。 */
function validateNativeCodexPayload(
	value: unknown,
	modelId: string,
	prefix: readonly JsonValue[],
	requireTrigger: boolean,
): NativeCodexRequestBody {
	const cloned = cloneCodexWireJson(value);
	if (!isJsonObject(cloned) || Object.keys(cloned).some((key) => !CODEX_REMOTE_COMPACTION_PAYLOAD_KEYS.has(key))) {
		throw createNativeCompactionError("protocol");
	}
	if (cloned.model !== modelId || cloned.store !== false || cloned.stream !== true || !Array.isArray(cloned.input)) {
		throw createNativeCompactionError("protocol");
	}
	if (!validateOptionalString(cloned.instructions) || !validateOptionalString(cloned.prompt_cache_key)) {
		throw createNativeCompactionError("protocol");
	}
	if (
		cloned.tools !== undefined &&
		(!Array.isArray(cloned.tools) || cloned.tools.some((tool) => !isJsonObject(tool)))
	) {
		throw createNativeCompactionError("protocol");
	}
	if (
		cloned.include !== undefined &&
		(!Array.isArray(cloned.include) || cloned.include.some((item) => typeof item !== "string"))
	) {
		throw createNativeCompactionError("protocol");
	}
	if (
		cloned.tool_choice !== undefined &&
		cloned.tool_choice !== "auto" &&
		cloned.tool_choice !== "none" &&
		cloned.tool_choice !== "required"
	) {
		throw createNativeCompactionError("protocol");
	}
	if (cloned.parallel_tool_calls !== undefined && typeof cloned.parallel_tool_calls !== "boolean") {
		throw createNativeCompactionError("protocol");
	}
	if (
		cloned.temperature !== undefined &&
		(typeof cloned.temperature !== "number" || !Number.isFinite(cloned.temperature))
	) {
		throw createNativeCompactionError("protocol");
	}
	if (cloned.reasoning !== undefined) {
		if (
			!isJsonObject(cloned.reasoning) ||
			Object.keys(cloned.reasoning).some((key) => key !== "effort" && key !== "summary")
		) {
			throw createNativeCompactionError("protocol");
		}
		if (!validateOptionalString(cloned.reasoning.effort) || !validateOptionalString(cloned.reasoning.summary)) {
			throw createNativeCompactionError("protocol");
		}
	}
	if (
		cloned.service_tier !== undefined &&
		cloned.service_tier !== null &&
		(typeof cloned.service_tier !== "string" || !CODEX_REMOTE_COMPACTION_SERVICE_TIERS.has(cloned.service_tier))
	) {
		throw createNativeCompactionError("protocol");
	}
	if (cloned.text !== undefined) {
		if (!isJsonObject(cloned.text) || Object.keys(cloned.text).some((key) => key !== "verbosity")) {
			throw createNativeCompactionError("protocol");
		}
		if (cloned.text.verbosity !== "low" && cloned.text.verbosity !== "medium" && cloned.text.verbosity !== "high") {
			throw createNativeCompactionError("protocol");
		}
	}
	assertCanonicalPrefix(cloned.input, prefix);
	let triggerCount = 0;
	for (const [index, item] of cloned.input.entries()) {
		if (isJsonObject(item) && item.type === "compaction_trigger") {
			triggerCount += 1;
			if (Object.keys(item).length !== 1 || index !== cloned.input.length - 1) {
				throw createNativeCompactionError("protocol");
			}
		} else if (containsCompactionTrigger(item)) {
			throw createNativeCompactionError("protocol");
		}
	}
	if ((requireTrigger && triggerCount !== 1) || (!requireTrigger && triggerCount !== 0)) {
		throw createNativeCompactionError("protocol");
	}
	return cloned as unknown as NativeCodexRequestBody;
}

/** Trusted Adapter Body 先按 JSON Wire 语义投影，去掉 TypeBox 内部 Descriptor。 */
function projectNativeCodexPayload(
	value: RequestBody,
	modelId: string,
	prefix: readonly JsonValue[],
	requireTrigger: boolean,
): NativeCodexRequestBody {
	try {
		return validateNativeCodexPayload(JSON.parse(JSON.stringify(value)), modelId, prefix, requireTrigger);
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "protocol");
	}
}

/** Canonical Codex Context 必须是 User Messages 后跟唯一 Compaction Item。 */
function validateCodexCanonicalItems(value: unknown): readonly JsonValue[] {
	let cloned: JsonValue;
	try {
		cloned = cloneAndFreezeJson(value);
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "protocol");
	}
	if (!Array.isArray(cloned) || cloned.length === 0) throw createNativeCompactionError("protocol");
	for (let index = 0; index < cloned.length; index += 1) {
		const item = cloned[index];
		if (!isJsonObject(item)) throw createNativeCompactionError("protocol");
		if (index === cloned.length - 1) {
			if (
				item.type !== "compaction" ||
				typeof item.encrypted_content !== "string" ||
				item.encrypted_content.length === 0
			) {
				throw createNativeCompactionError("protocol");
			}
		} else if (item.type !== "message" || item.role !== "user" || !Array.isArray(item.content)) {
			throw createNativeCompactionError("protocol");
		}
	}
	return cloned;
}

function readCodexReplayProviderContext(context: Context): ProviderContextEnvelope | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(context, "providerContext");
		if (descriptor === undefined) {
			if ("providerContext" in context) throw createNativeCompactionError("protocol");
			return undefined;
		}
		if (!descriptor.enumerable || !("value" in descriptor)) throw createNativeCompactionError("protocol");
		if (descriptor.value === undefined) return undefined;
		if (typeof descriptor.value !== "object" || descriptor.value === null) {
			throw createNativeCompactionError("protocol");
		}
		return descriptor.value as ProviderContextEnvelope;
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "protocol");
	}
}

type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
	if (output.stopReason === "pending") {
		throw new Error("Codex stream ended without a stop reason");
	}
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

// ============================================================================
// Retry Helpers
// ============================================================================

function isTerminalRateLimitError(errorText: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		errorText,
	);
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalRateLimitError(errorText)) {
		return false;
	}
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}

	return undefined;
}

class RetryDelayExceededError extends Error {}

function validateRetryDelayMs(delayMs: number, options?: StreamOptions): number {
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		throw new RetryDelayExceededError(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}

// ============================================================================
// Request Compression
// ============================================================================

type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function loadNodeZlib(): typeof NodeZlib | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib") ?? null;
}

// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
function compressRequestBodyZstd(bodyJson: string): Uint8Array | null {
	const zlib = loadNodeZlib();
	if (!zlib || typeof zlib.zstdCompressSync !== "function") {
		return null;
	}
	try {
		const compressed = zlib.zstdCompressSync(bodyJson, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
	} catch {
		return null;
	}
}

function approximateCodexTokens(text: string): number {
	return Math.ceil(new TextEncoder().encode(text).byteLength / 4);
}

/** 与 Codex Baseline 相同：按 UTF-8 Byte Budget 保留首尾并在中间插入 Marker。 */
function truncateCodexTextMiddle(text: string, maxTokens: number): string {
	if (text.length === 0) return "";
	const encoder = new TextEncoder();
	const totalBytes = encoder.encode(text).byteLength;
	const byteBudget = maxTokens * 4;
	if (maxTokens > 0 && totalBytes <= byteBudget) return text;
	if (byteBudget === 0) return `…${approximateCodexTokens(text)} tokens truncated…`;
	const leftBudget = Math.floor(byteBudget / 2);
	const rightBudget = byteBudget - leftBudget;
	const tailStartTarget = Math.max(0, totalBytes - rightBudget);
	let byteIndex = 0;
	let prefix = "";
	let suffix = "";
	for (const character of text) {
		const characterBytes = encoder.encode(character).byteLength;
		const characterEnd = byteIndex + characterBytes;
		if (characterEnd <= leftBudget) prefix += character;
		else if (byteIndex >= tailStartTarget) suffix += character;
		byteIndex = characterEnd;
	}
	const removedTokens = Math.ceil(Math.max(0, totalBytes - byteBudget) / 4);
	return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
}

function isCodexTextContent(item: JsonValue): item is JsonObject & { readonly text: string } {
	return (
		isJsonObject(item) && (item.type === "input_text" || item.type === "output_text") && typeof item.text === "string"
	);
}

function isRetainableCodexUserMessage(
	item: JsonValue,
): item is JsonObject & { readonly content: readonly JsonValue[] } {
	return (
		isJsonObject(item) &&
		(item.type === undefined || item.type === "message") &&
		item.role === "user" &&
		Array.isArray(item.content)
	);
}

function normalizeCodexUserMessage(item: JsonObject & { readonly content: readonly JsonValue[] }): JsonObject {
	return Object.freeze({ type: "message", role: "user", content: item.content });
}

function codexMessageTextTokenCount(item: JsonObject & { readonly content: readonly JsonValue[] }): number {
	return item.content.reduce<number>((total, contentItem) => {
		return total + (isCodexTextContent(contentItem) ? approximateCodexTokens(contentItem.text) : 0);
	}, 0);
}

/** 在单条 User Message 内按 Content 顺序消费预算，Image/Audio 永远保留。 */
function truncateCodexUserMessage(
	item: JsonObject & { readonly content: readonly JsonValue[] },
	maxTokens: number,
): JsonObject | undefined {
	let remaining = maxTokens;
	const content: JsonValue[] = [];
	for (const contentItem of item.content) {
		if (isCodexTextContent(contentItem)) {
			if (remaining === 0) continue;
			const tokens = approximateCodexTokens(contentItem.text);
			if (tokens <= remaining) {
				content.push(contentItem);
				remaining -= tokens;
			} else {
				content.push(Object.freeze({ ...contentItem, text: truncateCodexTextMiddle(contentItem.text, remaining) }));
				remaining = 0;
			}
		} else if (
			isJsonObject(contentItem) &&
			(contentItem.type === "input_image" || contentItem.type === "input_audio")
		) {
			content.push(contentItem);
		}
	}
	if (content.length === 0) return undefined;
	return Object.freeze({ type: "message", role: "user", content: Object.freeze(content) });
}

/** 固定 64k 预算，从最新向最旧保留真实 User Message。 */
function retainCodexCompactionMessages(input: readonly JsonValue[]): readonly JsonValue[] {
	const candidates = input.filter(isRetainableCodexUserMessage);
	let remaining = CODEX_REMOTE_COMPACTION_RETAINED_TOKENS;
	const retainedReversed: JsonValue[] = [];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		if (remaining === 0) continue;
		const item = candidates[index];
		const tokens = Math.max(codexMessageTextTokenCount(item), 1);
		if (tokens <= remaining) {
			retainedReversed.push(normalizeCodexUserMessage(item));
			remaining -= tokens;
		} else {
			const truncated = truncateCodexUserMessage(item, remaining);
			if (truncated) retainedReversed.push(truncated);
			remaining = 0;
		}
	}
	return Object.freeze(retainedReversed.reverse());
}

function mapCodexCompactionUsage(value: JsonValue | undefined): NativeCompactionUsage | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isJsonObject(value)) throw createNativeCompactionError("protocol");
	const readCount = (key: "input_tokens" | "output_tokens" | "total_tokens"): number => {
		const count = value[key];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
			throw createNativeCompactionError("protocol");
		}
		return count;
	};
	return Object.freeze({
		inputTokens: readCount("input_tokens"),
		outputTokens: readCount("output_tokens"),
		totalTokens: readCount("total_tokens"),
	});
}

function readCodexCompactionErrorCode(event: JsonObject): string | undefined {
	if (typeof event.code === "string") return event.code;
	if (isJsonObject(event.error) && typeof event.error.code === "string") return event.error.code;
	if (
		isJsonObject(event.response) &&
		isJsonObject(event.response.error) &&
		typeof event.response.error.code === "string"
	) {
		return event.response.error.code;
	}
	return undefined;
}

function throwCodexCompactionEventFailure(event: JsonObject, headers: Headers): never {
	const code = readCodexCompactionErrorCode(event);
	if (code && CODEX_REMOTE_COMPACTION_CAPACITY_CODES.has(code)) {
		throw createNativeCompactionError("capacity");
	}
	if (code && CODEX_REMOTE_COMPACTION_RETRYABLE_CODES.has(code)) {
		throw new CodexCompactionRetryError(undefined, headers);
	}
	if (code && CODEX_REMOTE_COMPACTION_TERMINAL_CODES.has(code)) {
		throw createNativeCompactionError("provider_error");
	}
	throw createNativeCompactionError("provider_error");
}

/** 只收集唯一 Compaction Output，并严格要求 response.completed。 */
async function collectCodexCompactionSSE(response: Response, signal: AbortSignal | undefined) {
	const iterator = parseSSE(response, signal, true)[Symbol.asyncIterator]();
	let compactionItem: JsonObject | undefined;
	try {
		for (;;) {
			let next: IteratorResult<Record<string, unknown>>;
			try {
				next = await iterator.next();
			} catch (error) {
				throwIfNativeCompactionAborted(signal);
				if (CODEX_COMPACTION_RETRY_ERRORS.has(error as object)) throw error;
				const sanitized = sanitizeNativeCompactionError(error, "provider_error");
				if (sanitized.code !== "provider_error") throw sanitized;
				throw new CodexCompactionRetryError(undefined, response.headers);
			}
			throwIfNativeCompactionAborted(signal);
			if (next.done) throw new CodexCompactionRetryError(undefined, response.headers);
			const event = cloneCodexWireJson(next.value);
			if (!isJsonObject(event) || typeof event.type !== "string") {
				throw createNativeCompactionError("protocol");
			}
			if (event.type === "error" || event.type === "response.failed") {
				throwCodexCompactionEventFailure(event, response.headers);
			}
			if (event.type === "response.incomplete") {
				throw new CodexCompactionRetryError(undefined, response.headers);
			}
			if (
				event.type === "response.output_item.done" &&
				isJsonObject(event.item) &&
				event.item.type === "compaction"
			) {
				if (
					Object.keys(event.item).some((key) => key !== "type" && key !== "id" && key !== "encrypted_content") ||
					(event.item.id !== undefined && (typeof event.item.id !== "string" || event.item.id.length === 0)) ||
					typeof event.item.encrypted_content !== "string" ||
					event.item.encrypted_content.length === 0
				) {
					throw createNativeCompactionError("protocol");
				}
				if (compactionItem) throw createNativeCompactionError("protocol");
				compactionItem = event.item;
				continue;
			}
			if (event.type !== "response.completed") continue;
			if (!compactionItem || !isJsonObject(event.response)) throw createNativeCompactionError("protocol");
			if (event.response.status !== undefined && event.response.status !== "completed") {
				throw createNativeCompactionError("protocol");
			}
			const usage = mapCodexCompactionUsage(event.response.usage);
			return Object.freeze({ item: compactionItem, ...(usage ? { usage } : {}) });
		}
	} finally {
		try {
			await iterator.return?.(undefined);
		} catch {}
	}
}

function addCodexCompactionFeature(headers: Headers): void {
	const features = new Set(
		(headers.get("x-codex-beta-features") ?? "")
			.split(",")
			.map((feature) => feature.trim())
			.filter((feature) => feature.length > 0 && feature !== CODEX_REMOTE_COMPACTION_V2_FEATURE),
	);
	features.add(CODEX_REMOTE_COMPACTION_V2_FEATURE);
	headers.set("x-codex-beta-features", [...features].join(","));
}

function isRetryableCodexCompactionHttpStatus(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalRateLimitError(errorText)) return false;
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function executeCodexCompactionAttempt(
	request: NativeCompactionProviderRequest<"openai-codex-responses">,
	body: Uint8Array | string,
	headers: Headers,
): Promise<CodexCompactionAttemptResult> {
	throwIfNativeCompactionAborted(request.options.signal);
	const headerTimeoutSignal =
		request.options.timeoutMs !== undefined && request.options.timeoutMs > 0
			? AbortSignal.timeout(request.options.timeoutMs)
			: undefined;
	const combinedSignal = combineAbortSignals([request.options.signal, headerTimeoutSignal]);
	let response: Response;
	try {
		try {
			response = await (request.options.fetch ?? globalThis.fetch)(request.binding.endpoint, {
				method: "POST",
				headers: new Headers(headers),
				body: body instanceof Uint8Array ? body.slice() : body,
				signal: combinedSignal.signal,
			});
		} catch {
			throwIfNativeCompactionAborted(request.options.signal);
			throw new CodexCompactionRetryError();
		}
	} finally {
		combinedSignal.cleanup();
	}
	throwIfNativeCompactionAborted(request.options.signal);
	try {
		await request.options.onResponse?.(
			{ status: response.status, headers: headersToRecord(response.headers) },
			request.model,
		);
	} catch (error) {
		throwIfNativeCompactionAborted(request.options.signal);
		throw sanitizeNativeCompactionError(error, "provider_error");
	}
	throwIfNativeCompactionAborted(request.options.signal);
	if (!response.ok) {
		let errorText: string;
		try {
			errorText = await response.text();
		} catch {
			throwIfNativeCompactionAborted(request.options.signal);
			throw new CodexCompactionRetryError();
		}
		throwIfNativeCompactionAborted(request.options.signal);
		if (isRetryableCodexCompactionHttpStatus(response.status, errorText)) {
			throw new CodexCompactionRetryError(response.status, response.headers);
		}
		throw createNativeCompactionError("provider_error");
	}
	if (!response.body) throw new CodexCompactionRetryError();
	return collectCodexCompactionSSE(response, request.options.signal);
}

function buildCodexCompactionPayload(
	request: NativeCompactionProviderRequest<"openai-codex-responses">,
	prefix: readonly JsonValue[],
): NativeCodexRequestBody {
	const grammarToolInputProperties = createGrammarToolInputProperties(
		request.context.tools,
		request.model.compat?.supportsOpenAIGrammarTools ?? false,
	);
	const cacheSessionId = request.options.cacheRetention === "none" ? undefined : request.options.sessionId;
	const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
	const body = buildRequestBody(
		request.model,
		request.context,
		request.options,
		codexSessionId,
		grammarToolInputProperties,
	);
	body.input = [
		...prefix,
		...((body.input ?? []) as unknown as readonly JsonValue[]),
		{ type: "compaction_trigger" },
	] as unknown as ResponseInput;
	return projectNativeCodexPayload(body, request.model.id, prefix, true);
}

export const resolveNativeCompactionRoutes = resolveOpenAICodexCompactionRoutes;

/** Models Preflight 后登记一次性 Replay Handoff。 */
export async function canConsumeProviderContext(
	request: NativeCompactionProviderRequest<"openai-codex-responses">,
): Promise<boolean> {
	assertNativeCompactionProviderRequest(request);
	throwIfNativeCompactionAborted(request.options.signal);
	if (request.providerContext === undefined) return false;
	if (request.binding.protocol !== "openai-codex-remote-v2") throw createNativeCompactionError("protocol");
	validateCodexCanonicalItems(request.providerContext.items);
	AUTHORIZED_CODEX_REPLAY_CONTEXTS.add(request.providerContext);
	return true;
}

/** 调用 Codex Remote Compaction V2，并返回可持久化的 Canonical Envelope。 */
export async function compact(
	request: NativeCompactionProviderRequest<"openai-codex-responses">,
): Promise<NativeCompactionResult> {
	assertNativeCompactionProviderRequest(request);
	try {
		throwIfNativeCompactionAborted(request.options.signal);
		const routes = resolveOpenAICodexCompactionRoutes(request.model, request.options);
		if (
			routes.primary.endpoint !== request.binding.endpoint ||
			routes.primary.protocol !== request.binding.protocol
		) {
			throw createNativeCompactionError("binding_mismatch");
		}
		const prefix = request.providerContext ? validateCodexCanonicalItems(request.providerContext.items) : [];
		let payload = buildCodexCompactionPayload(request, prefix);
		let nextPayload: unknown;
		try {
			nextPayload = await request.options.onPayload?.(payload, request.model);
		} catch (error) {
			throwIfNativeCompactionAborted(request.options.signal);
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
		throwIfNativeCompactionAborted(request.options.signal);
		if (nextPayload !== undefined) {
			payload = validateNativeCodexPayload(nextPayload, request.model.id, prefix, true);
		}
		const token = request.options.apiKey;
		const accountId = token ? parseOpenAICodexAccountId(token) : undefined;
		if (!token || !accountId) throw createNativeCompactionError("unsupported");
		const cacheSessionId = request.options.cacheRetention === "none" ? undefined : request.options.sessionId;
		const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
		const headers = buildSSEHeaders(request.model.headers, request.options.headers, accountId, token, codexSessionId);
		addCodexCompactionFeature(headers);
		const bodyJson = JSON.stringify(payload);
		const compressedBody = compressRequestBodyZstd(bodyJson);
		if (compressedBody) headers.set("content-encoding", "zstd");
		const body = compressedBody ?? bodyJson;
		const maxRetries = Math.min(request.options.maxRetries ?? CODEX_REMOTE_COMPACTION_MAX_RETRIES, 2);
		const attempt = await retryProviderRequest(() => executeCodexCompactionAttempt(request, body, headers), {
			maxRetries,
			maxRetryDelayMs: request.options.maxRetryDelayMs,
			signal: request.options.signal,
		});
		throwIfNativeCompactionAborted(request.options.signal);
		const retained = retainCodexCompactionMessages((payload.input as readonly JsonValue[]).slice(0, -1));
		return validateNativeCompactionResult({
			providerContext: {
				format: "openai-responses-compaction",
				version: 1,
				binding: request.binding,
				items: [...retained, attempt.item],
			},
			...(attempt.usage ? { usage: attempt.usage } : {}),
		});
	} catch (error) {
		throwIfNativeCompactionAborted(request.options.signal);
		throw sanitizeNativeCompactionError(error, "provider_error");
	}
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		let nativeReplay = false;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const providerContext = readCodexReplayProviderContext(context);
			let replayItems: readonly JsonValue[] | undefined;
			if (providerContext !== undefined) {
				nativeReplay = true;
				throwIfNativeCompactionAborted(options?.signal);
				if (!AUTHORIZED_CODEX_REPLAY_CONTEXTS.delete(providerContext)) {
					throw createNativeCompactionError("unsupported");
				}
				replayItems = validateCodexCanonicalItems(providerContext.items);
			}
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
			const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
			let body = buildRequestBody(model, context, options, codexSessionId, grammarToolInputProperties);
			if (replayItems !== undefined) {
				body.input = [
					...replayItems,
					...((body.input ?? []) as unknown as readonly JsonValue[]),
				] as unknown as ResponseInput;
				body = projectNativeCodexPayload(body, model.id, replayItems, false);
			}
			const nextBody = await options?.onPayload?.(body, model);
			if (nativeReplay) throwIfNativeCompactionAborted(options?.signal);
			if (nextBody !== undefined) {
				body = replayItems
					? validateNativeCodexPayload(nextBody, model.id, replayItems, false)
					: (nextBody as RequestBody);
			}
			const websocketRequestId = codexSessionId || uuidv7();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, codexSessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			const transport = nativeReplay ? "sse" : options?.transport || "auto";
			let startEmitted = false;
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(cacheSessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							resolveCodexWebSocketUrl(model.baseUrl),
							body,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							httpTimeoutMs,
							websocketConnectTimeoutMs,
							cacheSessionId,
							grammarToolInputProperties,
							options,
						);

						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						assertSuccessfulOutput(output);
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
							retriedMissingWebSocketContinuation = true;
							continue;
						}
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								fallbackTransport: websocketStarted ? undefined : "sse",
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						recordWebSocketFailure(cacheSessionId, error);
						if (websocketStarted) {
							throw error;
						}
						recordWebSocketSseFallback(cacheSessionId);
						break;
					}
				}
			}

			// Compress the request body once for the SSE path. The Codex backend
			// decodes Content-Encoding: zstd; the WebSocket transport above sends the
			// uncompressed JSON frame, matching the official Codex client.
			const compressedBody = compressRequestBodyZstd(bodyJson);
			if (compressedBody) {
				sseHeaders.set("content-encoding", "zstd");
			}
			const sseBody: Uint8Array | string = compressedBody ?? bodyJson;

			// Fetch with retry logic for rate limits and transient errors
			let response: Response | undefined;
			let lastError: Error | undefined;
			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					const headerTimeoutSignal =
						httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					try {
						response = await (options?.fetch ?? globalThis.fetch)(
							nativeReplay && providerContext
								? providerContext.binding.endpoint
								: resolveOpenAICodexResponsesUrl(model.baseUrl),
							{
								method: "POST",
								headers: sseHeaders,
								body: sseBody,
								signal: combinedSignal.signal,
							},
						);
					} catch (error) {
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
						}
						throw error;
					} finally {
						combinedSignal.cleanup();
					}
					if (nativeReplay) throwIfNativeCompactionAborted(options?.signal);
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
					if (nativeReplay) throwIfNativeCompactionAborted(options?.signal);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
						const delayMs =
							retryAfterDelayMs === undefined
								? BASE_DELAY_MS * 2 ** attempt
								: validateRetryDelayMs(retryAfterDelayMs, options);

						await sleep(delayMs, options?.signal);
						continue;
					}

					// Parse error for friendly message on final attempt or non-retryable error
					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new Error(info.friendlyMessage || info.message);
				} catch (error) {
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors are retryable
					if (
						attempt < maxRetries &&
						!(lastError instanceof RetryDelayExceededError) &&
						!lastError.message.includes("usage limit")
					) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			if (!startEmitted) {
				startEmitted = true;
				stream.push({ type: "start", partial: output });
			}
			await processStream(response, output, stream, model, grammarToolInputProperties, options);
			if (nativeReplay) throwIfNativeCompactionAborted(options?.signal);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			assertSuccessfulOutput(output);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = nativeReplay
				? sanitizeNativeCompactionError(error, "provider_error").message
				: formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
): RequestBody {
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	const toolPlacement = splitDeferredTools(context, model.compat?.supportsToolSearch ?? false);
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		toolOptions: {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		},
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: cacheSessionId,
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		body.tools = convertResponsesTools(toolPlacement.immediate, {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		});
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	}

	return body;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveOpenAICodexResponsesUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	await processResponsesStream(mapCodexEvents(parseSSE(response, options?.signal)), output, stream, model, {
		serviceTier: options?.serviceTier,
		grammarToolInputProperties,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
	});
}

class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function extractCodexEventError(event: Record<string, unknown>): { code?: string; message?: string } {
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

async function* mapCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const { code, message } = extractCodexEventError(event);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			});
		}

		if (type === "response.failed") {
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown } }).response;
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

async function* parseSSE(
	response: Response,
	signal?: AbortSignal,
	nativeCompaction: boolean = false,
): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				const dataLines = chunk
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							if (nativeCompaction) throw createNativeCompactionError("protocol");
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								cause,
								payload: data,
							});
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		const entry = websocketSessionCache.get(sessionId);
		if (entry) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const entry of websocketSessionCache.values()) {
		closeEntry(entry);
	}
	websocketSessionCache.clear();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

let _cachedWebsocket: WebSocketConstructor | null = null;
async function getWebSocketConstructor(env?: ProviderEnv): Promise<WebSocketConstructor | null> {
	if (!env && _cachedWebsocket) return _cachedWebsocket;

	// bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
	// TODO: remove this when bun supports proxy envs in websocket.
	if (typeof process !== "undefined" && process.versions?.bun) {
		const WebSocketWithProxy = class extends WebSocket {
			constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
				let _opts: Record<string, unknown> = {};
				if (Array.isArray(options) || typeof options === "string") {
					_opts = { protocols: options };
				} else {
					_opts = { ...options };
				}

				const proxyUrl = resolveHttpProxyUrlForTarget(
					url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
					env,
				);
				super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) } as any);
			}
		};
		if (!env) {
			_cachedWebsocket = WebSocketWithProxy;
		}
		return WebSocketWithProxy;
	}

	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	// If readyState is unavailable, assume the runtime keeps it open/reusable.
	return readyState === undefined || readyState === 1;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
	env?: ProviderEnv,
): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor(env);
	if (!WebSocketCtor) {
		throw new Error("WebSocket transport is not available in this runtime");
	}

	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			reject(error);
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			fail(extractWebSocketError(event));
		};
		const onClose: WebSocketListener = (event) => {
			fail(extractWebSocketCloseError(event));
		};
		const onAbort = () => {
			fail(new Error("Request was aborted"), "aborted");
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);

		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
			}, connectTimeoutMs);
		}
		if (signal?.aborted) {
			onAbort();
		}
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
	connectTimeoutMs?: number,
	env?: ProviderEnv,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
		return {
			socket,
			reused: false,
			release: () => closeWebSocketSilently(socket),
		};
	}

	const cached = websocketSessionCache.get(sessionId);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && isWebSocketSessionExpired(cached)) {
			closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
			websocketSessionCache.delete(sessionId);
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(sessionId);
		}
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
	const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
	websocketSessionCache.set(sessionId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				if (websocketSessionCache.get(sessionId) === entry) {
					websocketSessionCache.delete(sessionId);
				}
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		},
	};
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

async function* parseWebSocket(
	socket: WebSocketLike,
	signal?: AbortSignal,
	idleTimeoutMs?: number,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
					cause,
					payload: text,
				});
				done = true;
				wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) {
			failed = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
					timeout = setTimeout(() => {
						const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
						failed = error;
						done = true;
						pending = null;
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						reject(error);
					}, idleTimeoutMs);
				}
			}).finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
			});
		}

		if (failed) {
			throw failed;
		}
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
		}
		yield event;
	}
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	idleTimeoutMs: number | undefined,
	websocketConnectTimeoutMs: number | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(
		url,
		headers,
		cacheSessionId,
		options?.signal,
		websocketConnectTimeoutMs,
		options?.env,
	);
	let keepConnection = true;
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
	// WebSocket continuation still works via connection-scoped previous_response_id state.
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs)),
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			},
		);
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
				includeSystemPrompt: false,
				grammarToolInputProperties,
			}).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			};
		}
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

// ============================================================================
// Error Handling
// ============================================================================

async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {}

	return { message, friendlyMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

function extractAccountId(token: string): string {
	const accountId = parseOpenAICodexAccountId(token);
	if (!accountId) throw new Error("Failed to extract accountId from token");
	return accountId;
}

function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";
	headers.set("User-Agent", userAgent);
	return headers;
}

function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}
