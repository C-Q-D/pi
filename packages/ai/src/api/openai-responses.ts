import OpenAI from "openai";
import type { ResponseCompactParams, ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { assertNativeCompactionProviderRequest, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	JsonObject,
	JsonValue,
	Model,
	NativeCompactionProviderRequest,
	NativeCompactionResult,
	NativeCompactionUsage,
	OpenAIResponsesCompat,
	ProviderContextEnvelope,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { estimateTextTokens } from "../utils/estimate.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import {
	cloneAndFreezeJson,
	createNativeCompactionError,
	NativeCompactionError,
	sanitizeNativeCompactionError,
	validateNativeCompactionResult,
} from "../utils/native-compaction.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
	resolveOpenAIResponsesCompactionEndpoint,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const COMPACT_PAYLOAD_KEYS = new Set(["model", "input", "instructions", "prompt_cache_key"]);
const COMPACT_RESPONSE_KEYS = new Set(["id", "created_at", "object", "output", "usage"]);
const COMPACT_USAGE_KEYS = new Set([
	"input_tokens",
	"input_tokens_details",
	"output_tokens",
	"output_tokens_details",
	"total_tokens",
]);
const AUTHORIZED_REPLAY_CONTEXTS = new WeakSet<object>();

function throwIfNativeCompactionAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw createNativeCompactionError("aborted");
}

function cloneProtocolJson(value: unknown): JsonValue {
	try {
		return cloneAndFreezeJson(value);
	} catch {
		throw createNativeCompactionError("protocol");
	}
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
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

function validateCanonicalItems(value: unknown): readonly JsonValue[] {
	const cloned = cloneProtocolJson(value);
	if (!Array.isArray(cloned) || cloned.length === 0) throw createNativeCompactionError("protocol");
	let compactionCount = 0;
	for (const item of cloned) {
		if (!isJsonObject(item) || typeof item.type !== "string") throw createNativeCompactionError("protocol");
		if (item.type === "compaction") {
			compactionCount += 1;
			if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
				throw createNativeCompactionError("protocol");
			}
		} else if (item.type !== "message" || item.role !== "user") {
			throw createNativeCompactionError("protocol");
		}
	}
	if (compactionCount !== 1) throw createNativeCompactionError("protocol");
	return cloned;
}

function validateCompactUsage(value: JsonValue): NativeCompactionUsage {
	if (!isJsonObject(value) || !hasExactKeys(value, COMPACT_USAGE_KEYS)) {
		throw createNativeCompactionError("protocol");
	}
	const readCount = (key: "input_tokens" | "output_tokens" | "total_tokens"): number => {
		const count = value[key];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
			throw createNativeCompactionError("protocol");
		}
		return count;
	};
	if (
		!isJsonObject(value.input_tokens_details) ||
		!hasExactKeys(value.input_tokens_details, new Set(["cached_tokens"])) ||
		typeof value.input_tokens_details.cached_tokens !== "number" ||
		!Number.isSafeInteger(value.input_tokens_details.cached_tokens) ||
		value.input_tokens_details.cached_tokens < 0 ||
		!isJsonObject(value.output_tokens_details) ||
		!hasExactKeys(value.output_tokens_details, new Set(["reasoning_tokens"])) ||
		typeof value.output_tokens_details.reasoning_tokens !== "number" ||
		!Number.isSafeInteger(value.output_tokens_details.reasoning_tokens) ||
		value.output_tokens_details.reasoning_tokens < 0
	) {
		throw createNativeCompactionError("protocol");
	}
	return Object.freeze({
		inputTokens: readCount("input_tokens"),
		outputTokens: readCount("output_tokens"),
		totalTokens: readCount("total_tokens"),
	});
}

function validateCompactedResponse(value: unknown, request: NativeCompactionProviderRequest<"openai-responses">) {
	let responseRecord: Record<string, unknown>;
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Object.prototype
		) {
			throw createNativeCompactionError("protocol");
		}
		const keys = Reflect.ownKeys(value);
		if (
			keys.some((key) => typeof key !== "string" || (!COMPACT_RESPONSE_KEYS.has(key) && key !== "_request_id")) ||
			[...COMPACT_RESPONSE_KEYS].some((key) => !keys.includes(key))
		) {
			throw createNativeCompactionError("protocol");
		}
		responseRecord = {};
		for (const key of COMPACT_RESPONSE_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw createNativeCompactionError("protocol");
			responseRecord[key] = descriptor.value;
		}
		const requestIdDescriptor = Object.getOwnPropertyDescriptor(value, "_request_id");
		if (
			requestIdDescriptor !== undefined &&
			(requestIdDescriptor.enumerable ||
				!("value" in requestIdDescriptor) ||
				(requestIdDescriptor.value !== null && typeof requestIdDescriptor.value !== "string"))
		) {
			throw createNativeCompactionError("protocol");
		}
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "protocol");
	}
	const cloned = cloneProtocolJson(responseRecord);
	if (!isJsonObject(cloned) || !hasExactKeys(cloned, COMPACT_RESPONSE_KEYS)) {
		throw createNativeCompactionError("protocol");
	}
	if (
		typeof cloned.id !== "string" ||
		cloned.id.length === 0 ||
		typeof cloned.created_at !== "number" ||
		!Number.isSafeInteger(cloned.created_at) ||
		cloned.created_at < 0 ||
		cloned.object !== "response.compaction"
	) {
		throw createNativeCompactionError("protocol");
	}
	const items = validateCanonicalItems(cloned.output);
	const usage = validateCompactUsage(cloned.usage);
	return validateNativeCompactionResult({
		providerContext: {
			format: "openai-responses-compaction",
			version: 1,
			binding: request.binding,
			items,
		},
		usage,
	});
}

function assertCanonicalPrefix(input: readonly JsonValue[], prefix: readonly JsonValue[]): void {
	if (input.length < prefix.length) throw createNativeCompactionError("protocol");
	for (let index = 0; index < prefix.length; index += 1) {
		if (!jsonValuesEqual(input[index], prefix[index])) throw createNativeCompactionError("protocol");
	}
}

function assertCompactionCapacity(
	model: Readonly<Model<"openai-responses">>,
	context: Readonly<Omit<Context, "providerContext">>,
	input: readonly JsonValue[],
	instructions: string | undefined,
): void {
	try {
		const wireTokens = estimateTextTokens(JSON.stringify(input)) + estimateTextTokens(instructions ?? "");
		const toolTokens = estimateTextTokens(JSON.stringify(context.tools ?? []));
		if (model.contextWindow <= 0 || wireTokens + toolTokens + model.maxTokens > model.contextWindow) {
			throw createNativeCompactionError("capacity");
		}
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "protocol");
	}
}

function stripUndefinedProperties(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, propertyValue]) => propertyValue !== undefined));
}

function validateCompactPayload(
	value: unknown,
	modelId: string,
	prefix: readonly JsonValue[],
): Readonly<ResponseCompactParams> & { readonly input: readonly JsonValue[] } {
	const cloned = cloneProtocolJson(value);
	if (!isJsonObject(cloned) || !Object.keys(cloned).every((key) => COMPACT_PAYLOAD_KEYS.has(key))) {
		throw createNativeCompactionError("protocol");
	}
	if (cloned.model !== modelId || !Array.isArray(cloned.input)) throw createNativeCompactionError("protocol");
	if (cloned.instructions !== undefined && typeof cloned.instructions !== "string") {
		throw createNativeCompactionError("protocol");
	}
	if (cloned.prompt_cache_key !== undefined && typeof cloned.prompt_cache_key !== "string") {
		throw createNativeCompactionError("protocol");
	}
	assertCanonicalPrefix(cloned.input, prefix);
	return cloned as unknown as Readonly<ResponseCompactParams> & { readonly input: readonly JsonValue[] };
}

function validateReplayPayload(
	value: unknown,
	modelId: string,
	prefix: readonly JsonValue[],
): ResponseCreateParamsStreaming & { readonly input: readonly JsonValue[] } {
	const cloned = cloneProtocolJson(value);
	if (
		!isJsonObject(cloned) ||
		cloned.model !== modelId ||
		!Array.isArray(cloned.input) ||
		Object.hasOwn(cloned, "previous_response_id") ||
		Object.hasOwn(cloned, "conversation")
	) {
		throw createNativeCompactionError("protocol");
	}
	assertCanonicalPrefix(cloned.input, prefix);
	return cloned as unknown as ResponseCreateParamsStreaming & { readonly input: readonly JsonValue[] };
}

function readReplayProviderContext(context: Context): ProviderContextEnvelope | undefined {
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

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

function buildCompactionPayload(
	request: NativeCompactionProviderRequest<"openai-responses">,
	prefix: readonly JsonValue[],
): Readonly<ResponseCompactParams> & { readonly input: readonly JsonValue[] } {
	const compat = getCompat(request.model);
	const grammarToolInputProperties = createGrammarToolInputProperties(
		request.context.tools,
		compat.supportsOpenAIGrammarTools,
	);
	const toolPlacement = splitDeferredTools(request.context, compat.supportsToolSearch);
	const messages = convertResponsesMessages(request.model, request.context, OPENAI_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});
	const cacheRetention = resolveCacheRetention(request.options.cacheRetention, request.options.env);
	return validateCompactPayload(
		stripUndefinedProperties({
			model: request.model.id,
			input: [...prefix, ...messages],
			instructions: request.context.systemPrompt,
			prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(request.options.sessionId),
		}),
		request.model.id,
		prefix,
	);
}

export const resolveNativeCompactionEndpoint = resolveOpenAIResponsesCompactionEndpoint;

export async function canConsumeProviderContext(
	request: NativeCompactionProviderRequest<"openai-responses">,
): Promise<boolean> {
	assertNativeCompactionProviderRequest(request);
	throwIfNativeCompactionAborted(request.options.signal);
	if (request.providerContext === undefined) return false;
	if (request.binding.protocol !== "openai-responses-compact") throw createNativeCompactionError("protocol");
	validateCanonicalItems(request.providerContext.items);
	AUTHORIZED_REPLAY_CONTEXTS.add(request.providerContext);
	return true;
}

export async function compact(
	request: NativeCompactionProviderRequest<"openai-responses">,
): Promise<NativeCompactionResult> {
	assertNativeCompactionProviderRequest(request);
	try {
		throwIfNativeCompactionAborted(request.options.signal);
		const prefix = request.providerContext ? validateCanonicalItems(request.providerContext.items) : [];
		let payload = buildCompactionPayload(request, prefix);
		assertCompactionCapacity(request.model, request.context, payload.input, payload.instructions ?? undefined);
		let nextPayload: unknown;
		try {
			nextPayload = await request.options.onPayload?.(payload, request.model);
		} catch (error) {
			throwIfNativeCompactionAborted(request.options.signal);
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
		throwIfNativeCompactionAborted(request.options.signal);
		if (nextPayload !== undefined) payload = validateCompactPayload(nextPayload, request.model.id, prefix);
		assertCompactionCapacity(request.model, request.context, payload.input, payload.instructions ?? undefined);

		const apiKey = getClientApiKey(request.model.provider, request.options.apiKey, request.options.headers);
		const cacheRetention = resolveCacheRetention(request.options.cacheRetention, request.options.env);
		const cacheSessionId = cacheRetention === "none" ? undefined : request.options.sessionId;
		const client = createClient(
			request.model,
			request.context,
			apiKey,
			request.options.headers,
			request.options.fetch,
			cacheSessionId,
		);
		const requestOptions = {
			...(request.options.signal ? { signal: request.options.signal } : {}),
			...(request.options.timeoutMs !== undefined ? { timeout: request.options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data, response } = await retryProviderRequest(
			() => client.responses.compact(payload as ResponseCompactParams, requestOptions).withResponse(),
			{
				maxRetries: request.options.maxRetries,
				maxRetryDelayMs: request.options.maxRetryDelayMs,
				signal: request.options.signal,
			},
		);
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
		return validateCompactedResponse(data as unknown, request);
	} catch (error) {
		throwIfNativeCompactionAborted(request.options.signal);
		throw sanitizeNativeCompactionError(error, "provider_error");
	}
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		let nativeReplay = false;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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
			const providerContext = readReplayProviderContext(context);
			let replayItems: readonly JsonValue[] | undefined;
			if (providerContext !== undefined) {
				nativeReplay = true;
				throwIfNativeCompactionAborted(options?.signal);
				if (!AUTHORIZED_REPLAY_CONTEXTS.delete(providerContext)) {
					throw createNativeCompactionError("unsupported");
				}
				replayItems = validateCanonicalItems(providerContext.items);
			}
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId);
			let params = buildParams(model, context, options, compat, grammarToolInputProperties, replayItems);
			if (replayItems !== undefined) {
				const validatedParams = validateReplayPayload(
					stripUndefinedProperties(params as unknown as Record<string, unknown>),
					model.id,
					replayItems,
				);
				params = validatedParams;
				assertCompactionCapacity(model, context, validatedParams.input, validatedParams.instructions ?? undefined);
			}
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params =
					replayItems === undefined
						? (nextParams as ResponseCreateParamsStreaming)
						: validateReplayPayload(nextParams, model.id, replayItems);
			}
			if (replayItems !== undefined) {
				throwIfNativeCompactionAborted(options?.signal);
				assertCompactionCapacity(
					model,
					context,
					params.input as unknown as readonly JsonValue[],
					params.instructions ?? undefined,
				);
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			if (replayItems !== undefined) throwIfNativeCompactionAborted(options?.signal);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (replayItems !== undefined) throwIfNativeCompactionAborted(options?.signal);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const nativeError = options?.signal?.aborted
				? createNativeCompactionError("aborted")
				: error instanceof NativeCompactionError
					? error
					: nativeReplay
						? sanitizeNativeCompactionError(error, "provider_error")
						: undefined;
			output.errorMessage = nativeError?.message ?? formatOpenAIResponsesError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		compat.supportsOpenAIGrammarTools,
	),
	replayItems?: readonly JsonValue[],
) {
	const toolPlacement = splitDeferredTools(context, compat.supportsToolSearch);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: replayItems === undefined,
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;
	const params: ResponseCreateParamsStreaming & { prompt_cache_options?: { mode: "explicit" } } = {
		model: model.id,
		input: (replayItems === undefined
			? messages
			: [...replayItems, ...messages]) as ResponseCreateParamsStreaming["input"],
		...(replayItems === undefined ? {} : { instructions: context.systemPrompt }),
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		params.tools = convertResponsesTools(toolPlacement.immediate, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
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
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
