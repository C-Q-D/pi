import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import {
	type AuthResolutionOverrides,
	getEffectiveAuthMetadata,
	inheritEffectiveAuthMetadata,
	ModelsError,
	resolveProviderAuth,
} from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ProviderModelsStore } from "./models-store.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	NativeCompactionApi,
	NativeCompactionProviderCapabilities,
	NativeCompactionProviderRequest,
	NativeCompactionPublicOptionsMap,
	NativeCompactionResult,
	NativeCompactionRouteSet,
	NoNativeCompactionProviderCapabilities,
	OptionalNativeCompactionProviderCapabilities,
	ProviderContextBinding,
	ProviderContextEnvelope,
	ProviderHeaders,
	ProviderStreamMethods,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";
import { sha256Hex } from "./utils/hash.ts";
import { lazyStream } from "./utils/lazy-stream.ts";
import {
	cloneAndFreezeJson,
	cloneAndFreezeProviderContext,
	createNativeCompactionError,
	sanitizeNativeCompactionError,
	validateNativeCompactionResult,
} from "./utils/native-compaction.ts";
import { cloneAndFreezeNativeContext } from "./utils/native-context.ts";
import { validateNativeCompactionRouteSet } from "./utils/native-endpoint.ts";
import {
	assertAuthorizedNativeCompactionBinding,
	assertNativeCompactionProviderRequest,
	nativeCompactionBindingIsAuthorized,
	registerNativeCompactionProviderRequest,
} from "./utils/native-request.ts";

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

export interface RefreshModelsContext {
	/** Effective configured credential. OAuth credentials are refreshed before network access. */
	credential?: Credential;
	/** Persistent model storage scoped to this provider ID. */
	store: ProviderModelsStore;
	/** False during offline/cache-only initialization. */
	allowNetwork: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** Bypass provider freshness checks and fetch immediately when network access is allowed. */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

export interface ModelsStreamTransforms {
	/** Transform fully assembled model/auth/request headers before provider dispatch. */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsStreamTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsStreamTransforms;

/**
 * A provider is the concrete runtime unit. It owns id/name/base metadata,
 * auth methods, model listing, and stream behavior.
 *
 * `TApi` lets concrete provider factories declare which APIs their models
 * use (e.g. `openaiProvider(): Provider<"openai-responses" | "openai-completions">`),
 * giving typed model lists to direct factory users. Inside a `Models`
 * collection providers are held in the erased default `Provider` shape.
 */
interface ProviderCore<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Every provider has auth
	 * semantics — even providers with only ambient credentials (env vars, AWS
	 * profiles, ADC files) and keyless local servers provide `apiKey` auth
	 * whose `resolve()` reports whether the provider is configured.
	 * `Models.getAuth()` returns undefined when the provider is unconfigured.
	 */
	readonly auth: ProviderAuth;

	/**
	 * Current known models, sync. Static providers return their catalog;
	 * dynamic providers return the list as of the last `refreshModels()`
	 * (empty before the first). Must not throw; `Models` treats a throwing
	 * implementation as having no models.
	 */
	getModels(): readonly Model<TApi>[];

	/**
	 * Dynamic providers only: restore the provider-scoped stored catalog and optionally fetch
	 * a newer list using the effective credential. Implementations must retain their previous
	 * list on failure and honor the shared abort signal for network requests.
	 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/**
	 * Optional provider policy for credential-specific model availability.
	 * `getModels()` remains the complete synchronous catalog; `Models.getAvailable()`
	 * applies this filter after confirming that provider auth is configured.
	 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** Provider 集合保存异构 API 时使用的只读、不可调用擦除形状。 */
interface ErasedNativeCompactionProviderCapabilities {
	readonly compact: (request: never) => Promise<NativeCompactionResult>;
	readonly canConsumeProviderContext: (request: never) => Promise<boolean>;
	readonly resolveNativeCompactionRoutes: (model: never, options: never) => NativeCompactionRouteSet;
}

type OptionalErasedNativeCompactionProviderCapabilities =
	| ErasedNativeCompactionProviderCapabilities
	| NoNativeCompactionProviderCapabilities;

/** Provider 普通能力与可选、不可拆分的原生压缩三件套。 */
export type Provider<TApi extends Api = never> = [TApi] extends [never]
	? ProviderCore<Api> & OptionalErasedNativeCompactionProviderCapabilities
	: ProviderCore<TApi> & OptionalNativeCompactionProviderCapabilities<TApi>;

/**
 * Runtime collection of providers plus auth application and stream
 * convenience. Providers own stream behavior; `Models` resolves auth and
 * delegates each request to the provider that owns the model.
 */
export interface Models {
	/** Optional on read-only wrappers; createModels() always returns the complete capability. */
	readonly compact?: NativeCompactionModels["compact"];
	readonly canConsumeProviderContext?: NativeCompactionModels["canConsumeProviderContext"];

	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/**
	 * Sync read of last-known models from one provider or all providers.
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * Sync runtime model lookup against last-known lists. Dynamic model lists
	 * are typed as `Model<Api>`; narrow with the `hasApi()` type guard.
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/**
	 * Refresh every configured dynamic provider concurrently. Provider errors and cancellation
	 * are returned without rejecting; static and unconfigured providers are skipped.
	 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** Check whether a provider has complete auth configuration without refreshing OAuth. */
	checkAuth(providerId: string): Promise<AuthCheck | undefined>;

	/** Return models whose providers have complete auth configuration. */
	getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;

	/**
	 * Resolve provider-scoped auth by provider id, or provider auth plus static
	 * model headers when passed a model. Includes a source label for status UI.
	 * Resolves `undefined` when the provider is unknown or unconfigured.
	 * Rejects with `ModelsError`: code "oauth" when a token refresh fails (the
	 * stored credential is preserved for retry; re-login fixes it), code "auth"
	 * when api-key resolution or the credential store fails. Request paths
	 * surface rejections as stream errors.
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** Run a provider-owned login flow and persist its returned credential. */
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;

	/** Remove the stored credential for a provider. */
	logout(providerId: string): Promise<void>;

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}

/** Models collection with the native compaction entry points introduced by the preflight layer. */
export interface NativeCompactionModels {
	compact<TApi extends NativeCompactionApi>(
		model: Model<TApi>,
		context: Context,
		options?: NativeCompactionPublicOptionsMap[TApi],
	): Promise<NativeCompactionResult>;

	canConsumeProviderContext<TApi extends NativeCompactionApi>(
		model: Model<TApi>,
		providerContext: ProviderContextEnvelope,
		options?: NativeCompactionPublicOptionsMap[TApi],
	): Promise<boolean>;
}

export type MutableModels = Models &
	NativeCompactionModels & {
		/** Upsert/replace by provider.id. Provider ids are unique. */
		setProvider(provider: Provider): void;
		deleteProvider(id: string): void;
		clearProviders(): void;
	};

export interface CreateModelsOptions {
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

const NATIVE_COMPACTION_APIS = new Set<NativeCompactionApi>(["openai-responses", "openai-codex-responses"]);
const NATIVE_COMPACTION_COMMON_OPTION_KEYS = [
	"signal",
	"apiKey",
	"fetch",
	"headers",
	"timeoutMs",
	"maxRetries",
	"maxRetryDelayMs",
	"env",
	"onPayload",
	"onResponse",
	"sessionId",
	"cacheRetention",
	"reasoningEffort",
	"reasoningSummary",
	"serviceTier",
] as const;
const OPENAI_RESPONSES_NATIVE_OPTION_KEYS = new Set<string>(NATIVE_COMPACTION_COMMON_OPTION_KEYS);
const OPENAI_CODEX_NATIVE_OPTION_KEYS = new Set<string>([...NATIVE_COMPACTION_COMMON_OPTION_KEYS, "textVerbosity"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** createProvider 内部用于运行时检查三件套的宽形状，不向调用方开放部分 Capability。 */
type ProviderStreamsRuntime = ProviderStreamMethods & Partial<NativeCompactionProviderCapabilities>;

/** 只读取普通对象上的可枚举字符串数据属性，避免执行 Getter。 */
function readNativeCompactionObject(value: unknown): ReadonlyMap<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw createNativeCompactionError("invalid_context");
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) {
		throw createNativeCompactionError("invalid_context");
	}
	const properties = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
			throw createNativeCompactionError("invalid_context");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
			throw createNativeCompactionError("invalid_context");
		}
		properties.set(key, descriptor.value);
	}
	return properties;
}

/** 复制并冻结 Headers/Env 这类闭合字符串记录。 */
function cloneNativeCompactionRecord(value: unknown, allowNull: boolean): Readonly<Record<string, string | null>> {
	const properties = readNativeCompactionObject(value);
	const clone: Record<string, string | null> = {};
	for (const [key, entry] of properties) {
		if (typeof entry !== "string" && !(allowNull && entry === null)) {
			throw createNativeCompactionError("invalid_context");
		}
		clone[key] = entry;
	}
	return Object.freeze(clone);
}

/** 按 API 校验、复制并冻结原生压缩公开选项。 */
function validateNativeCompactionOptions<TApi extends NativeCompactionApi>(
	api: TApi,
	options: unknown,
): Readonly<NativeCompactionPublicOptionsMap[TApi]> {
	try {
		const properties = readNativeCompactionObject(options);
		const allowed =
			api === "openai-responses" ? OPENAI_RESPONSES_NATIVE_OPTION_KEYS : OPENAI_CODEX_NATIVE_OPTION_KEYS;
		const clone: Record<string, unknown> = {};
		for (const [key, value] of properties) {
			if (!allowed.has(key)) {
				throw createNativeCompactionError("invalid_context");
			}
			switch (key) {
				case "signal":
					if (!(value instanceof AbortSignal)) throw createNativeCompactionError("invalid_context");
					clone.signal = value;
					break;
				case "apiKey":
				case "sessionId":
					if (typeof value !== "string" || value.length === 0) {
						throw createNativeCompactionError("invalid_context");
					}
					clone[key] = value;
					break;
				case "fetch":
				case "onPayload":
				case "onResponse":
					if (typeof value !== "function") throw createNativeCompactionError("invalid_context");
					clone[key] = value;
					break;
				case "headers":
					clone.headers = cloneNativeCompactionRecord(value, true);
					break;
				case "env":
					clone.env = cloneNativeCompactionRecord(value, false);
					break;
				case "timeoutMs":
				case "maxRetryDelayMs":
					if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
						throw createNativeCompactionError("invalid_context");
					}
					clone[key] = value;
					break;
				case "maxRetries":
					if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
						throw createNativeCompactionError("invalid_context");
					}
					clone.maxRetries = value;
					break;
				case "cacheRetention":
					if (value !== "none" && value !== "short" && value !== "long") {
						throw createNativeCompactionError("invalid_context");
					}
					clone.cacheRetention = value;
					break;
				case "reasoningEffort": {
					const commonEffort =
						value === "minimal" ||
						value === "low" ||
						value === "medium" ||
						value === "high" ||
						value === "xhigh" ||
						value === "max";
					if (!commonEffort && !(api === "openai-codex-responses" && value === "none")) {
						throw createNativeCompactionError("invalid_context");
					}
					clone.reasoningEffort = value;
					break;
				}
				case "reasoningSummary": {
					const commonSummary = value === "auto" || value === "detailed" || value === "concise" || value === null;
					if (!commonSummary && !(api === "openai-codex-responses" && (value === "off" || value === "on"))) {
						throw createNativeCompactionError("invalid_context");
					}
					clone.reasoningSummary = value;
					break;
				}
				case "serviceTier":
					if (
						value !== "auto" &&
						value !== "default" &&
						value !== "flex" &&
						value !== "scale" &&
						value !== "priority" &&
						value !== null
					) {
						throw createNativeCompactionError("invalid_context");
					}
					clone.serviceTier = value;
					break;
				case "textVerbosity":
					if (value !== "low" && value !== "medium" && value !== "high") {
						throw createNativeCompactionError("invalid_context");
					}
					clone.textVerbosity = value;
					break;
			}
		}
		return Object.freeze(clone) as Readonly<NativeCompactionPublicOptionsMap[TApi]>;
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "invalid_context");
	}
}

/** 判断 API 是否属于首版原生压缩白名单。 */
function isNativeCompactionApi(api: Api): api is NativeCompactionApi {
	return NATIVE_COMPACTION_APIS.has(api as NativeCompactionApi);
}

/** 判断一个 Stream 实现是否完整提供原生压缩三件套。 */
function hasNativeCompactionCapabilities(
	streams: ProviderStreamsRuntime,
): streams is ProviderStreamMethods & NativeCompactionProviderCapabilities {
	return (
		typeof streams.compact === "function" &&
		typeof streams.canConsumeProviderContext === "function" &&
		typeof streams.resolveNativeCompactionRoutes === "function"
	);
}

/** 判断一个 Stream 实现是否声明了任意原生压缩成员。 */
function hasAnyNativeCompactionCapability(streams: ProviderStreamsRuntime): boolean {
	return (
		typeof streams.compact === "function" ||
		typeof streams.canConsumeProviderContext === "function" ||
		typeof streams.resolveNativeCompactionRoutes === "function"
	);
}

type NarrowedNativeProvider<TApi extends NativeCompactionApi> = ProviderCore<TApi> &
	NativeCompactionProviderCapabilities<TApi>;

interface NativeCompactionPreflight<TApi extends NativeCompactionApi> {
	readonly provider: NarrowedNativeProvider<TApi>;
	readonly request: NativeCompactionProviderRequest<TApi>;
	readonly streamContext: Context;
	readonly streamOptions: StreamOptions;
}

/** 唯一的异构 Provider → 具体 Native API 运行时收窄点。 */
function narrowNativeCompactionProvider<TApi extends NativeCompactionApi>(
	provider: Provider,
	api: TApi,
): NarrowedNativeProvider<TApi> {
	const runtime = provider as ProviderCore<Api> & ProviderStreamsRuntime;
	if (!isNativeCompactionApi(api) || !hasNativeCompactionCapabilities(runtime)) {
		throw createNativeCompactionError("unsupported");
	}
	return runtime as unknown as NarrowedNativeProvider<TApi>;
}

function throwIfNativeCompactionAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw createNativeCompactionError("aborted");
}

function cloneNativeModel<TApi extends NativeCompactionApi>(model: Model<TApi>): Readonly<Model<TApi>> {
	try {
		const properties = readNativeCompactionObject(model);
		const required = [
			"id",
			"name",
			"api",
			"provider",
			"baseUrl",
			"reasoning",
			"input",
			"cost",
			"contextWindow",
			"maxTokens",
		] as const;
		const allowed = new Set([...required, "thinkingLevelMap", "headers", "compat"]);
		for (const key of properties.keys()) {
			if (!allowed.has(key)) throw createNativeCompactionError("invalid_context");
		}
		for (const key of required) {
			if (!properties.has(key)) throw createNativeCompactionError("invalid_context");
		}
		const clone = cloneAndFreezeJson(model);
		const snapshot = readNativeCompactionObject(clone);
		for (const key of ["id", "name", "provider", "baseUrl"] as const) {
			const value = snapshot.get(key);
			if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
				throw createNativeCompactionError("invalid_context");
			}
		}
		if (!isNativeCompactionApi(snapshot.get("api") as Api)) {
			throw createNativeCompactionError("unsupported");
		}
		if (typeof snapshot.get("reasoning") !== "boolean") {
			throw createNativeCompactionError("invalid_context");
		}
		for (const key of ["contextWindow", "maxTokens"] as const) {
			const value = snapshot.get(key);
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
				throw createNativeCompactionError("invalid_context");
			}
		}
		const input = snapshot.get("input");
		if (!Array.isArray(input) || input.length === 0 || input.some((value) => value !== "text" && value !== "image")) {
			throw createNativeCompactionError("invalid_context");
		}
		validateNativeModelCost(snapshot.get("cost"));
		if (snapshot.has("headers")) cloneNativeCompactionRecord(snapshot.get("headers"), false);
		if (snapshot.has("thinkingLevelMap")) validateNativeThinkingLevelMap(snapshot.get("thinkingLevelMap"));
		if (snapshot.has("compat")) validateNativeResponsesCompat(snapshot.get("compat"));
		return clone as unknown as Readonly<Model<TApi>>;
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "invalid_context");
	}
}

function validateFiniteNonNegativeRecord(value: unknown, required: readonly string[]): void {
	const properties = readNativeCompactionObject(value);
	if (properties.size !== required.length) throw createNativeCompactionError("invalid_context");
	for (const key of required) {
		const entry = properties.get(key);
		if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
			throw createNativeCompactionError("invalid_context");
		}
	}
}

function validateNativeModelCost(value: unknown): void {
	const properties = readNativeCompactionObject(value);
	const required = ["input", "output", "cacheRead", "cacheWrite"] as const;
	for (const key of properties.keys()) {
		if (![...required, "tiers"].includes(key as (typeof required)[number] | "tiers")) {
			throw createNativeCompactionError("invalid_context");
		}
	}
	for (const key of required) {
		const entry = properties.get(key);
		if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
			throw createNativeCompactionError("invalid_context");
		}
	}
	if (properties.has("tiers")) {
		const tiers = properties.get("tiers");
		if (!Array.isArray(tiers)) throw createNativeCompactionError("invalid_context");
		for (const tier of tiers) {
			validateFiniteNonNegativeRecord(tier, ["inputTokensAbove", ...required]);
		}
	}
}

function validateNativeThinkingLevelMap(value: unknown): void {
	const properties = readNativeCompactionObject(value);
	const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	for (const [key, entry] of properties) {
		if (!allowed.has(key) || (entry !== null && typeof entry !== "string")) {
			throw createNativeCompactionError("invalid_context");
		}
	}
}

function validateNativeResponsesCompat(value: unknown): void {
	const properties = readNativeCompactionObject(value);
	const booleanKeys = new Set([
		"supportsDeveloperRole",
		"supportsLongCacheRetention",
		"supportsStrictMode",
		"supportsOpenAIGrammarTools",
		"supportsToolSearch",
		"supportsExplicitPromptCacheMode",
	]);
	for (const [key, entry] of properties) {
		if (key === "sessionAffinityFormat") {
			if (entry !== "openai" && entry !== "openai-nosession" && entry !== "openrouter") {
				throw createNativeCompactionError("invalid_context");
			}
		} else if (!booleanKeys.has(key) || typeof entry !== "boolean") {
			throw createNativeCompactionError("invalid_context");
		}
	}
}

function cloneStreamOptionsForNative(options: unknown, skipUndefined = false): StreamOptions {
	try {
		const properties = readNativeCompactionObject(options ?? {});
		const clone: Record<string, unknown> = {};
		for (const [key, value] of properties) {
			if (value === undefined) {
				if (skipUndefined) continue;
				throw createNativeCompactionError("invalid_context");
			}
			if (typeof value === "function" || value instanceof AbortSignal) {
				clone[key] = value;
			} else {
				clone[key] = cloneAndFreezeJson(value);
			}
		}
		return Object.freeze(clone) as StreamOptions;
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "invalid_context");
	}
}

function selectNativeCompactionOptions<TApi extends NativeCompactionApi>(
	api: TApi,
	options: unknown,
): Readonly<NativeCompactionPublicOptionsMap[TApi]> {
	const properties = readNativeCompactionObject(options ?? {});
	const allowed = api === "openai-responses" ? OPENAI_RESPONSES_NATIVE_OPTION_KEYS : OPENAI_CODEX_NATIVE_OPTION_KEYS;
	const selected: Record<string, unknown> = {};
	for (const [key, value] of properties) {
		if (allowed.has(key) && value !== undefined) selected[key] = value;
	}
	return validateNativeCompactionOptions(api, selected);
}

function hasAuthorizationHeader(headers: ProviderHeaders | undefined): boolean {
	return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function readContextProviderContext(context: unknown): unknown {
	try {
		if (typeof context !== "object" || context === null) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(context, "providerContext");
		if (!descriptor) {
			if ("providerContext" in context) throw createNativeCompactionError("invalid_context");
			return undefined;
		}
		if (!descriptor.enumerable || !("value" in descriptor)) {
			throw createNativeCompactionError("invalid_context");
		}
		return descriptor.value;
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "invalid_context");
	}
}

class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private modelsStore: ModelsStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const errors = new Map<string, Error>();
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined,
		);

		await Promise.all(
			refreshable.map(async (provider) => {
				if (options.signal?.aborted) return;
				const store: ProviderModelsStore = {
					read: () => this.modelsStore.read(provider.id),
					write: (entry) => this.modelsStore.write(provider.id, entry),
					delete: () => this.modelsStore.delete(provider.id),
				};
				let stored: Credential | undefined;
				try {
					stored = await this.readCredential(provider.id);
					const credential = await this.resolveRefreshCredential(provider, stored, allowNetwork, options.signal);
					if (!credential) return;
					await provider.refreshModels({
						credential,
						store,
						allowNetwork,
						force: options.force,
						signal: options.signal,
					});
				} catch (error) {
					if (!options.signal?.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
					try {
						await provider.refreshModels({
							credential: stored,
							store,
							allowNetwork: false,
							signal: options.signal,
						});
					} catch {
						// Preserve the original auth/network error; cache restoration is best-effort here.
					}
				}
			}),
		);

		return { aborted: options.signal?.aborted ?? false, errors };
	}

	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		allowNetwork: boolean,
		signal?: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (!allowNetwork || Date.now() < stored.expires) return stored;
			if (signal?.aborted) return undefined;
			const post = await this.credentials.modify(provider.id, async (current) => {
				if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
				return oauth.refresh(current, signal);
			});
			return post?.type === "oauth" ? post : undefined;
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	private async readCredential(providerId: string): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext);
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return this.checkProviderAuth(provider, await this.readCredential(providerId));
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.readCredential(provider.id);
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential) };
			}),
		);
		return checks.flatMap(({ provider, credential, auth }) => {
			if (!auth) return [];
			const models = provider.getModels();
			return provider.filterModels?.(models, credential) ?? models;
		});
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return inheritEffectiveAuthMetadata(result, {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		});
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		const credential = await method.login(interaction);
		try {
			await this.credentials.modify(providerId, async () => credential);
		} catch (error) {
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		try {
			await this.credentials.delete(providerId);
		} catch (error) {
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private async applyAuth<TOptions extends StreamOptions & ModelsStreamTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ requestModel: Model<Api>; requestOptions: StreamOptions | undefined; resolution: AuthResult }> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as StreamOptions;

		return { requestModel, requestOptions, resolution };
	}

	private async resolveNativeCredentialScope(
		api: NativeCompactionApi,
		provider: Provider,
		resolution: AuthResult,
		options: Readonly<NativeCompactionPublicOptionsMap[NativeCompactionApi]>,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const metadata = getEffectiveAuthMetadata(resolution);
		if (api === "openai-responses") {
			if (metadata?.kind !== "api_key" || typeof options.apiKey !== "string" || options.apiKey.length === 0) {
				throw createNativeCompactionError("unsupported");
			}
			try {
				const hash = await sha256Hex(`api-key:${options.apiKey}`);
				throwIfNativeCompactionAborted(signal);
				return hash;
			} catch (error) {
				throwIfNativeCompactionAborted(signal);
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		}

		if (metadata?.kind !== "oauth" || !metadata.getStableSubject) {
			throw createNativeCompactionError("unsupported");
		}
		if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
			throw createNativeCompactionError("unsupported");
		}
		try {
			const subject = await metadata.getStableSubject(metadata.finalCredential);
			throwIfNativeCompactionAborted(signal);
			if (!subject || CONTROL_CHARACTER_PATTERN.test(subject)) {
				throw createNativeCompactionError("unsupported");
			}
			if (metadata.previousSubject) {
				if (metadata.previousSubject.status === "error") {
					throw createNativeCompactionError("provider_error");
				}
				if (!metadata.previousSubject.value || metadata.previousSubject.value !== subject) {
					throw createNativeCompactionError("unsupported");
				}
			}
			const hash = await sha256Hex(`chatgpt-account:${subject}:${provider.id}`);
			throwIfNativeCompactionAborted(signal);
			return hash;
		} catch (error) {
			throwIfNativeCompactionAborted(signal);
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
	}

	private async nativeCompactionPreflight<TApi extends NativeCompactionApi>(
		model: Model<TApi>,
		context: Context,
		options: unknown,
		inputKind: "native" | "stream",
	): Promise<NativeCompactionPreflight<TApi>> {
		let rawOptionProperties: ReadonlyMap<string, unknown>;
		try {
			rawOptionProperties = readNativeCompactionObject(options ?? {});
		} catch (error) {
			throw sanitizeNativeCompactionError(error, "invalid_context");
		}
		let signal: AbortSignal | undefined;
		try {
			const rawSignal = rawOptionProperties.get("signal");
			if (rawSignal !== undefined && !(rawSignal instanceof AbortSignal)) {
				throw createNativeCompactionError("invalid_context");
			}
			signal = rawSignal as AbortSignal | undefined;
		} catch (error) {
			throw sanitizeNativeCompactionError(error, "invalid_context");
		}
		throwIfNativeCompactionAborted(signal);
		const inputModelSnapshot = cloneNativeModel(model);
		if (!isNativeCompactionApi(inputModelSnapshot.api)) throw createNativeCompactionError("unsupported");
		const providerCandidate = this.providers.get(inputModelSnapshot.provider);
		if (!providerCandidate) throw createNativeCompactionError("unsupported");
		const provider = narrowNativeCompactionProvider(providerCandidate, inputModelSnapshot.api);

		const rawStreamOptions =
			inputKind === "native"
				? (validateNativeCompactionOptions(inputModelSnapshot.api, options ?? {}) as StreamOptions)
				: cloneStreamOptionsForNative(options);
		const rawNativeOptions = selectNativeCompactionOptions(inputModelSnapshot.api, rawStreamOptions);
		if (inputModelSnapshot.api === "openai-codex-responses" && rawOptionProperties.has("apiKey")) {
			throw createNativeCompactionError("unsupported");
		}
		if (hasAuthorizationHeader(rawNativeOptions.headers)) {
			throw createNativeCompactionError("unsupported");
		}

		const contextSnapshot = cloneAndFreezeNativeContext(context);
		const rawProviderContext = readContextProviderContext(context);
		const providerContext =
			rawProviderContext === undefined ? undefined : cloneAndFreezeProviderContext(rawProviderContext);
		let authResult: {
			requestModel: Model<Api>;
			requestOptions: StreamOptions | undefined;
			resolution: AuthResult;
		};
		try {
			authResult = await this.applyAuth(
				inputModelSnapshot,
				rawStreamOptions as StreamOptions & ModelsStreamTransforms,
			);
		} catch (error) {
			throwIfNativeCompactionAborted(signal);
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
		const { requestModel, requestOptions, resolution } = authResult;
		throwIfNativeCompactionAborted(signal);
		if (
			inputModelSnapshot.api === "openai-codex-responses" &&
			(typeof resolution.auth.apiKey !== "string" || resolution.auth.apiKey.length === 0)
		) {
			throw createNativeCompactionError("unsupported");
		}
		const streamOptions = cloneStreamOptionsForNative(requestOptions, true);
		const nativeOptions = selectNativeCompactionOptions(inputModelSnapshot.api, streamOptions);
		if (hasAuthorizationHeader(nativeOptions.headers)) {
			throw createNativeCompactionError("unsupported");
		}
		const modelSnapshot = cloneNativeModel(requestModel as Model<TApi>);
		const credentialScopeHash = await this.resolveNativeCredentialScope(
			inputModelSnapshot.api,
			provider,
			resolution,
			nativeOptions,
			signal,
		);
		throwIfNativeCompactionAborted(signal);

		let routes: NativeCompactionRouteSet<TApi>;
		try {
			routes = validateNativeCompactionRouteSet(
				inputModelSnapshot.api,
				provider.resolveNativeCompactionRoutes(modelSnapshot, nativeOptions),
			);
		} catch (error) {
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
		const authorizedBindings = Object.freeze(
			[routes.primary, ...routes.fallbacks].map(
				(route): ProviderContextBinding =>
					cloneAndFreezeProviderContext({
						format: "openai-responses-compaction",
						version: 1,
						binding: {
							provider: provider.id,
							api: modelSnapshot.api,
							model: modelSnapshot.id,
							endpoint: route.endpoint,
							format: "openai-responses-compaction",
							protocol: route.protocol,
							credentialScopeHash,
						},
						items: [],
					}).binding,
			),
		);
		if (providerContext && !nativeCompactionBindingIsAuthorized(providerContext.binding, authorizedBindings)) {
			throw createNativeCompactionError("binding_mismatch");
		}

		const request = Object.freeze({
			model: modelSnapshot,
			context: contextSnapshot,
			options: nativeOptions,
			binding: authorizedBindings[0]!,
			...(providerContext ? { providerContext } : {}),
		}) as unknown as NativeCompactionProviderRequest<TApi>;
		registerNativeCompactionProviderRequest(request, authorizedBindings);
		const streamContext = Object.freeze({
			...contextSnapshot,
			...(providerContext ? { providerContext } : {}),
		}) as Context;
		return Object.freeze({ provider, request, streamContext, streamOptions });
	}

	async compact<TApi extends NativeCompactionApi>(
		model: Model<TApi>,
		context: Context,
		options?: NativeCompactionPublicOptionsMap[TApi],
	): Promise<NativeCompactionResult> {
		const preflight = await this.nativeCompactionPreflight(model, context, options, "native");
		try {
			const rawResult: unknown = await preflight.provider.compact(preflight.request);
			throwIfNativeCompactionAborted(preflight.request.options.signal);
			let result: NativeCompactionResult;
			try {
				result = validateNativeCompactionResult(rawResult);
			} catch {
				throw createNativeCompactionError("protocol");
			}
			assertAuthorizedNativeCompactionBinding(preflight.request, result.providerContext.binding);
			return result;
		} catch (error) {
			throwIfNativeCompactionAborted(preflight.request.options.signal);
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
	}

	async canConsumeProviderContext<TApi extends NativeCompactionApi>(
		model: Model<TApi>,
		providerContext: ProviderContextEnvelope,
		options?: NativeCompactionPublicOptionsMap[TApi],
	): Promise<boolean> {
		const preflight = await this.nativeCompactionPreflight(
			model,
			{ messages: [], providerContext },
			options,
			"native",
		);
		try {
			const result: unknown = await preflight.provider.canConsumeProviderContext(preflight.request);
			throwIfNativeCompactionAborted(preflight.request.options.signal);
			if (typeof result !== "boolean") throw createNativeCompactionError("protocol");
			return result;
		} catch (error) {
			throwIfNativeCompactionAborted(preflight.request.options.signal);
			throw sanitizeNativeCompactionError(error, "provider_error");
		}
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const rawProviderContext = readContextProviderContext(context);
			if (rawProviderContext !== undefined) {
				const preflight = await this.nativeCompactionPreflight(
					model as Model<NativeCompactionApi>,
					context,
					options,
					"stream",
				);
				let canConsume: unknown;
				try {
					canConsume = await preflight.provider.canConsumeProviderContext(preflight.request);
				} catch (error) {
					throwIfNativeCompactionAborted(preflight.request.options.signal);
					throw sanitizeNativeCompactionError(error, "provider_error");
				}
				throwIfNativeCompactionAborted(preflight.request.options.signal);
				if (typeof canConsume !== "boolean") throw createNativeCompactionError("protocol");
				if (!canConsume) throw createNativeCompactionError("unsupported");
				try {
					const stream = preflight.provider.stream(
						preflight.request.model,
						preflight.streamContext,
						preflight.streamOptions,
					);
					throwIfNativeCompactionAborted(preflight.request.options.signal);
					return stream;
				} catch (error) {
					throwIfNativeCompactionAborted(preflight.request.options.signal);
					throw sanitizeNativeCompactionError(error, "provider_error");
				}
			}
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(
				model,
				options as ModelsApiStreamOptions<Api> | undefined,
			);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const rawProviderContext = readContextProviderContext(context);
			if (rawProviderContext !== undefined) {
				if (!isNativeCompactionApi(model.api)) throw createNativeCompactionError("unsupported");
				const preflight = await this.nativeCompactionPreflight(
					model as Model<NativeCompactionApi>,
					context,
					options,
					"stream",
				);
				let canConsume: unknown;
				try {
					canConsume = await preflight.provider.canConsumeProviderContext(preflight.request);
				} catch (error) {
					throwIfNativeCompactionAborted(preflight.request.options.signal);
					throw sanitizeNativeCompactionError(error, "provider_error");
				}
				throwIfNativeCompactionAborted(preflight.request.options.signal);
				if (typeof canConsume !== "boolean") throw createNativeCompactionError("protocol");
				if (!canConsume) throw createNativeCompactionError("unsupported");
				try {
					const stream = preflight.provider.streamSimple(
						preflight.request.model,
						preflight.streamContext,
						preflight.streamOptions,
					);
					throwIfNativeCompactionAborted(preflight.request.options.signal);
					return stream;
				} catch (error) {
					throwIfNativeCompactionAborted(preflight.request.options.signal);
					throw sanitizeNativeCompactionError(error, "provider_error");
				}
			}
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
		});
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}
}

export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	/** Static baseline model list (empty for purely dynamic providers). */
	models: readonly Model<TApi>[];
	/** Fetch a dynamic model overlay. createProvider restores/persists it through ModelsStore. */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** Single implementation, or map keyed by `model.api` for mixed-API providers. */
	api: ProviderStreams<TApi> | Partial<{ [TCurrentApi in TApi]: ProviderStreams<TCurrentApi> }>;
}

/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all models;
 * an `api` map dispatches on `model.api`, and a model whose api has no entry
 * produces a stream error.
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const baselineModels = input.models;
	let dynamicModels: readonly Model<TApi>[] = [];
	let inflightRefresh: Promise<void> | undefined;
	const fetchModels = input.fetchModels;
	const currentModels = (): readonly Model<TApi>[] => {
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex((entry) => entry.id === model.id);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	const single =
		typeof (input.api as ProviderStreamMethods).stream === "function"
			? (input.api as ProviderStreamsRuntime)
			: undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreamsRuntime>>);

	const apiFor = (model: Model<Api>): ProviderStreamsRuntime | undefined => single ?? byApi?.[model.api];
	const configuredStreams = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
	const exposesNativeCompaction = configuredStreams.some(hasAnyNativeCompactionCapability);

	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreamsRuntime) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	const providerCore: ProviderCore<TApi> = {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: currentModels,
		refreshModels: fetchModels
			? (context) => {
					inflightRefresh ??= (async () => {
						try {
							const stored = await context.store.read();
							if (stored) {
								dynamicModels = stored.models
									.filter((model) => model.provider === input.id)
									.map((model) => model as Model<TApi>);
							}
							if (!context.allowNetwork || context.signal?.aborted) return;
							const refreshed = await fetchModels(context);
							if (context.signal?.aborted) return;
							dynamicModels = refreshed;
							await context.store.write({ models: refreshed, checkedAt: Date.now() });
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		filterModels: input.filterModels,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};
	if (!exposesNativeCompaction) {
		return providerCore as Provider<TApi>;
	}

	const nativeCapabilities: NativeCompactionProviderCapabilities = {
		compact: async (request): Promise<NativeCompactionResult> => {
			assertNativeCompactionProviderRequest(request);
			const streams = apiFor(request.model);
			if (!streams || !hasNativeCompactionCapabilities(streams)) {
				throw createNativeCompactionError("unsupported");
			}
			try {
				const rawResult: unknown = await streams.compact(request);
				let result: NativeCompactionResult;
				try {
					result = validateNativeCompactionResult(rawResult);
				} catch {
					throw createNativeCompactionError("protocol");
				}
				assertAuthorizedNativeCompactionBinding(request, result.providerContext.binding);
				return result;
			} catch (error) {
				throwIfNativeCompactionAborted(request.options.signal);
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
		canConsumeProviderContext: async (request): Promise<boolean> => {
			assertNativeCompactionProviderRequest(request);
			const streams = apiFor(request.model);
			if (!streams || !hasNativeCompactionCapabilities(streams)) {
				throw createNativeCompactionError("unsupported");
			}
			try {
				return await streams.canConsumeProviderContext(request);
			} catch (error) {
				throwIfNativeCompactionAborted(request.options.signal);
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
		resolveNativeCompactionRoutes: (model, options): NativeCompactionRouteSet => {
			try {
				if (!isNativeCompactionApi(model.api)) {
					throw createNativeCompactionError("unsupported");
				}
				const streams = apiFor(model);
				if (!streams || !hasNativeCompactionCapabilities(streams)) {
					throw createNativeCompactionError("unsupported");
				}
				const validatedOptions = validateNativeCompactionOptions(model.api, options);
				return validateNativeCompactionRouteSet(
					model.api,
					streams.resolveNativeCompactionRoutes(model, validatedOptions),
				);
			} catch (error) {
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
	};
	return Object.assign(providerCore, nativeCapabilities) as Provider<TApi>;
}

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
