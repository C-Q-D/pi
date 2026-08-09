import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
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
	NativeCompactionEndpoint,
	NativeCompactionProviderCapabilities,
	NativeCompactionProviderRequest,
	NativeCompactionPublicOptionsMap,
	NativeCompactionResult,
	NoNativeCompactionProviderCapabilities,
	OptionalNativeCompactionProviderCapabilities,
	ProviderHeaders,
	ProviderStreamMethods,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	Usage,
} from "./types.ts";
import { createNativeCompactionError, sanitizeNativeCompactionError } from "./utils/native-compaction.ts";

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
	readonly resolveNativeCompactionEndpoint: (model: never, options: never) => NativeCompactionEndpoint;
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

export interface MutableModels extends Models {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

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
const NATIVE_COMPACTION_PROVIDER_REQUESTS = new WeakSet<object>();
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
		typeof streams.resolveNativeCompactionEndpoint === "function"
	);
}

/** 判断一个 Stream 实现是否声明了任意原生压缩成员。 */
function hasAnyNativeCompactionCapability(streams: ProviderStreamsRuntime): boolean {
	return (
		typeof streams.compact === "function" ||
		typeof streams.canConsumeProviderContext === "function" ||
		typeof streams.resolveNativeCompactionEndpoint === "function"
	);
}

/**
 * 断言请求已由 Models Preflight 登记。
 *
 * 该函数只开放检查能力，不开放 WeakSet 登记能力；公开 raw Adapter 的 Native
 * 方法必须在读取请求或发网前调用它。
 */
export function assertNativeCompactionProviderRequest(request: NativeCompactionProviderRequest): void {
	if (!NATIVE_COMPACTION_PROVIDER_REQUESTS.has(request)) {
		throw createNativeCompactionError("unsupported");
	}
}

/** 校验并冻结 Adapter 返回的 Endpoint Identity。 */
function validateNativeCompactionEndpoint<TApi extends NativeCompactionApi>(
	api: TApi,
	value: unknown,
): NativeCompactionEndpoint<TApi> {
	try {
		const properties = readNativeCompactionObject(value);
		if (properties.size !== 2 || !properties.has("endpoint") || !properties.has("protocol")) {
			throw createNativeCompactionError("protocol");
		}
		const endpoint = properties.get("endpoint");
		const protocol = properties.get("protocol");
		const protocolMatchesApi =
			api === "openai-responses"
				? protocol === "openai-responses-compact"
				: protocol === "openai-codex-remote-v2" || protocol === "openai-codex-compact-legacy";
		if (
			typeof endpoint !== "string" ||
			endpoint.length === 0 ||
			CONTROL_CHARACTER_PATTERN.test(endpoint) ||
			!protocolMatchesApi
		) {
			throw createNativeCompactionError("protocol");
		}
		return Object.freeze({
			endpoint,
			protocol: protocol as NativeCompactionEndpoint<TApi>["protocol"],
		});
	} catch {
		throw createNativeCompactionError("protocol");
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
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
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
	): Promise<{ requestModel: Model<Api>; requestOptions: StreamOptions | undefined }> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
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

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
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
				return await streams.compact(request);
			} catch (error) {
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
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
		resolveNativeCompactionEndpoint: (model, options): NativeCompactionEndpoint => {
			try {
				if (!isNativeCompactionApi(model.api)) {
					throw createNativeCompactionError("unsupported");
				}
				const streams = apiFor(model);
				if (!streams || !hasNativeCompactionCapabilities(streams)) {
					throw createNativeCompactionError("unsupported");
				}
				const validatedOptions = validateNativeCompactionOptions(model.api, options);
				return validateNativeCompactionEndpoint(
					model.api,
					streams.resolveNativeCompactionEndpoint(model, validatedOptions),
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
