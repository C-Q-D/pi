import { describe, expect, expectTypeOf, it } from "vitest";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import type { AuthContext, AuthEvent } from "../src/auth/types.ts";
import * as publicApi from "../src/index.ts";
import { createModels, createProvider, type Provider } from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import { builtinModels, builtinProviders, getBuiltinModel } from "../src/providers/all.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { cloudflareAIGatewayProvider } from "../src/providers/cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "../src/providers/cloudflare-workers-ai.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import type {
	Api,
	Context,
	Model,
	NativeCompactionApi,
	NativeCompactionProviderCapabilities,
	NativeCompactionProviderRequest,
	NativeCompactionPublicOptionsMap,
	ProviderStreams,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { createNativeCompactionError, NativeCompactionError } from "../src/utils/native-compaction.ts";
import { assertNativeCompactionProviderRequest } from "../src/utils/native-request.ts";

function fakeAuthContext(env: Record<string, string>, files: string[] = []): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async (path) => files.includes(path),
	};
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

describe("builtin providers", () => {
	it("builtinModels registers every builtin provider with models", async () => {
		const models = builtinModels();
		const providers = models.getProviders();
		expect(providers.length).toBe(builtinProviders().length);
		expect(providers.map((p) => p.id)).toContain("anthropic");

		const anthropic = models.getModel("anthropic", "claude-haiku-4-5");
		expect(anthropic?.api).toBe("anthropic-messages");

		const all = models.getModels();
		expect(all.length).toBeGreaterThan(500);

		// Static providers list models immediately; Radius is purely dynamic.
		for (const provider of providers) {
			const list = models.getModels(provider.id);
			if (provider.id === "radius") expect(list).toEqual([]);
			else expect(list.length).toBeGreaterThan(0);
			expect(list.every((m) => m.provider === provider.id)).toBe(true);
		}
	});

	it("stores native constrained-sampling capabilities in model metadata", () => {
		const gpt4o = getBuiltinModel("openai", "gpt-4o");
		expect(gpt4o.compat?.supportsStrictMode).toBe(true);
		expect(gpt4o.compat?.supportsOpenAIGrammarTools).toBeUndefined();
		expect(getBuiltinModel("openai", "gpt-5.4").compat).toMatchObject({
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: true,
		});
		expect(getBuiltinModel("anthropic", "claude-haiku-4-5").compat?.supportsStrictTools).toBe(true);
	});

	it("uses official Kimi K3 pricing for Moonshot providers", () => {
		const models = builtinModels();
		for (const provider of ["moonshotai", "moonshotai-cn"]) {
			expect(models.getModel(provider, "kimi-k3")?.cost).toEqual({
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 0,
			});
		}
	});

	it("uses API-equivalent implied pricing for Kimi Coding subscription models", () => {
		const models = builtinModels();
		const expectedCosts = {
			k3: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
		};

		for (const [modelId, cost] of Object.entries(expectedCosts)) {
			expect(models.getModel("kimi-coding", modelId)?.cost).toEqual(cost);
		}
	});

	it("resolves Anthropic bearer auth from env with auth token precedence", async () => {
		const models = createModels({
			authContext: fakeAuthContext({
				ANTHROPIC_AUTH_TOKEN: "auth-token",
				ANTHROPIC_OAUTH_TOKEN: "oauth-token",
				ANTHROPIC_API_KEY: "api-key",
			}),
		});
		models.setProvider(anthropicProvider());

		expect(await models.getAuth("anthropic")).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: "ANTHROPIC_AUTH_TOKEN",
		});
	});

	it("preserves Anthropic OAuth token precedence over the API key", async () => {
		const models = createModels({
			authContext: fakeAuthContext({ ANTHROPIC_API_KEY: "key", ANTHROPIC_OAUTH_TOKEN: "oauth-token" }),
		});
		models.setProvider(anthropicProvider());

		const result = await models.getAuth("anthropic");
		expect(result?.auth.apiKey).toBe("oauth-token");
		expect(result?.source).toBe("ANTHROPIC_OAUTH_TOKEN");
	});

	it("runs provider-owned Bedrock bearer token and AWS profile login flows", async () => {
		const auth = amazonBedrockProvider().auth.apiKey!;
		const bearerAnswers = ["bearer-token", "bedrock-token"];
		expect(
			await auth.login?.({
				prompt: async () => bearerAnswers.shift()!,
				notify: () => {},
			}),
		).toEqual({ type: "api_key", key: "bedrock-token" });

		const profileAnswers = ["aws-profile", "work"];
		const events: AuthEvent[] = [];
		expect(
			await auth.login?.({
				prompt: async () => profileAnswers.shift()!,
				notify: (event) => events.push(event),
			}),
		).toEqual({ type: "api_key", env: { AWS_PROFILE: "work" } });
		expect(events).toEqual([
			expect.objectContaining({
				type: "info",
				links: [expect.objectContaining({ label: "AWS credential provider chain" })],
			}),
		]);
		expect(
			await auth.resolve({
				ctx: fakeAuthContext({}),
				credential: { type: "api_key", env: { AWS_PROFILE: "work" } },
			}),
		).toMatchObject({ auth: {}, env: { AWS_PROFILE: "work" } });
	});

	it("reports bedrock as configured from ambient AWS credentials without an api key", async () => {
		const models = createModels({ authContext: fakeAuthContext({ AWS_PROFILE: "dev" }) });
		models.setProvider(amazonBedrockProvider());
		const model = models.getModels("amazon-bedrock")[0];

		const result = await models.getAuth(model.provider);
		expect(result?.auth).toEqual({});
		expect(result?.source).toBe("AWS_PROFILE");

		const unconfigured = createModels({ authContext: fakeAuthContext({}) });
		unconfigured.setProvider(amazonBedrockProvider());
		expect(await unconfigured.getAuth(model.provider)).toBeUndefined();
	});

	it("requires Cloudflare Workers AI account config and returns scoped env", async () => {
		const missingAccount = createModels({ authContext: fakeAuthContext({ CLOUDFLARE_API_KEY: "cf-key" }) });
		missingAccount.setProvider(cloudflareWorkersAIProvider());
		const model = missingAccount.getModels("cloudflare-workers-ai")[0];
		expect(await missingAccount.getAuth(model.provider)).toBeUndefined();

		const configured = createModels({
			authContext: fakeAuthContext({ CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "account-id" }),
		});
		configured.setProvider(cloudflareWorkersAIProvider());
		const result = await configured.getAuth(model.provider);
		expect(result?.auth).toEqual({ apiKey: "cf-key" });
		expect(result?.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "account-id" });
	});

	it("requires Cloudflare AI Gateway account and gateway config and returns scoped env headers", async () => {
		const missingGateway = createModels({
			authContext: fakeAuthContext({ CLOUDFLARE_API_KEY: "cf-key", CLOUDFLARE_ACCOUNT_ID: "account-id" }),
		});
		missingGateway.setProvider(cloudflareAIGatewayProvider());
		const model = missingGateway.getModels("cloudflare-ai-gateway")[0];
		expect(await missingGateway.getAuth(model.provider)).toBeUndefined();

		const configured = createModels({
			authContext: fakeAuthContext({
				CLOUDFLARE_API_KEY: "cf-key",
				CLOUDFLARE_ACCOUNT_ID: "account-id",
				CLOUDFLARE_GATEWAY_ID: "gateway-id",
			}),
		});
		configured.setProvider(cloudflareAIGatewayProvider());
		const result = await configured.getAuth(model.provider);
		expect(result?.auth).toEqual({
			headers: {
				"cf-aig-authorization": "Bearer cf-key",
				Authorization: null,
				"x-api-key": null,
			},
		});
		expect(result?.env).toEqual({
			CLOUDFLARE_ACCOUNT_ID: "account-id",
			CLOUDFLARE_GATEWAY_ID: "gateway-id",
		});
	});

	it("runs provider-owned Vertex API key and ADC login flows", async () => {
		const auth = googleVertexProvider().auth.apiKey!;
		const keyAnswers = ["api-key", "vertex-key"];
		expect(
			await auth.login?.({
				prompt: async () => keyAnswers.shift()!,
				notify: () => {},
			}),
		).toEqual({ type: "api_key", key: "vertex-key" });

		const adcAnswers = ["adc", "project-id", "us-central1"];
		const events: AuthEvent[] = [];
		expect(
			await auth.login?.({
				prompt: async () => adcAnswers.shift()!,
				notify: (event) => events.push(event),
			}),
		).toEqual({
			type: "api_key",
			env: { GOOGLE_CLOUD_PROJECT: "project-id", GOOGLE_CLOUD_LOCATION: "us-central1" },
		});
		expect(events).toEqual([
			expect.objectContaining({
				type: "info",
				links: [expect.objectContaining({ label: "Application Default Credentials" })],
			}),
		]);
		expect(
			await auth.resolve({
				ctx: fakeAuthContext({}, ["~/.config/gcloud/application_default_credentials.json"]),
				credential: {
					type: "api_key",
					env: { GOOGLE_CLOUD_PROJECT: "project-id", GOOGLE_CLOUD_LOCATION: "us-central1" },
				},
			}),
		).toMatchObject({
			auth: {},
			env: { GOOGLE_CLOUD_PROJECT: "project-id", GOOGLE_CLOUD_LOCATION: "us-central1" },
		});
	});

	it("resolves vertex via ADC file plus project and location", async () => {
		const adc = "~/.config/gcloud/application_default_credentials.json";
		const configured = createModels({
			authContext: fakeAuthContext({ GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1" }, [adc]),
		});
		configured.setProvider(googleVertexProvider());
		const model = configured.getModels("google-vertex")[0];

		const result = await configured.getAuth(model.provider);
		expect(result?.auth).toEqual({});
		expect(result?.source).toContain("application default");

		// ADC without project/location is not configured
		const partial = createModels({ authContext: fakeAuthContext({ GOOGLE_CLOUD_PROJECT: "proj" }, [adc]) });
		partial.setProvider(googleVertexProvider());
		expect(await partial.getAuth(model.provider)).toBeUndefined();

		// explicit key wins over ADC
		const keyed = createModels({ authContext: fakeAuthContext({ GOOGLE_CLOUD_API_KEY: "vertex-key" }) });
		keyed.setProvider(googleVertexProvider());
		expect((await keyed.getAuth(model.provider))?.auth.apiKey).toBe("vertex-key");
	});
});

describe("envApiKeyAuth", () => {
	it("prefers the stored credential key and falls back through env vars in order", async () => {
		const auth = envApiKeyAuth("Test key", ["FIRST_KEY", "SECOND_KEY"]);

		const stored = await auth.resolve({
			ctx: fakeAuthContext({ FIRST_KEY: "env" }),
			credential: { type: "api_key", key: "stored" },
		});
		expect(stored?.auth.apiKey).toBe("stored");
		expect(stored?.source).toBe("stored credential");

		const second = await auth.resolve({ ctx: fakeAuthContext({ SECOND_KEY: "second" }) });
		expect(second?.auth.apiKey).toBe("second");
		expect(second?.source).toBe("SECOND_KEY");

		expect(await auth.resolve({ ctx: fakeAuthContext({}) })).toBeUndefined();
	});

	it("login prompts for a secret and returns an api-key credential", async () => {
		const auth = envApiKeyAuth("Test key", ["TEST_KEY"]);
		const credential = await auth.login?.({
			prompt: async (prompt) => {
				expect(prompt.type).toBe("secret");
				return "entered-key";
			},
			notify: () => {},
		});
		expect(credential).toEqual({ type: "api_key", key: "entered-key" });
	});
});

describe("createProvider", () => {
	it("不从 Package Barrel 暴露原生请求品牌和授权内部能力", () => {
		expect("assertNativeCompactionProviderRequest" in publicApi).toBe(false);
		expect("getAuthorizedNativeCompactionBindings" in publicApi).toBe(false);
		expect("assertAuthorizedNativeCompactionBinding" in publicApi).toBe(false);
		expect("registerNativeCompactionProviderRequest" in publicApi).toBe(false);
	});

	function recordingStreams(label: string, calls: string[]): ProviderStreams {
		const respond = (model: Model<Api>) => {
			calls.push(`${label}:${model.id}`);
			const stream = new AssistantMessageEventStream();
			const message = fauxAssistantMessage("ok");
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		return { stream: respond, streamSimple: respond };
	}

	function testModel<TApi extends Api>(api: TApi, id: string): Model<TApi> {
		return {
			id,
			name: id,
			api,
			provider: "mixed",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
		};
	}

	/** 创建供原生压缩 Provider 契约测试使用的精确 API 模型。 */
	function testNativeModel<TApi extends NativeCompactionApi>(api: TApi, id: string): Model<TApi> {
		return testModel(api, id);
	}

	/** 创建完整原生压缩三件套；网络能力在本 Atom 中保持不可执行。 */
	function nativeStreams<TApi extends NativeCompactionApi>(
		resolveNativeCompactionRoutes: NativeCompactionProviderCapabilities<TApi>["resolveNativeCompactionRoutes"],
	) {
		return {
			...recordingStreams("native", []),
			compact: async () => {
				throw createNativeCompactionError("provider_error");
			},
			canConsumeProviderContext: async () => false,
			resolveNativeCompactionRoutes,
		};
	}

	/** 捕获并断言 Provider Native 调用必须抛出的固定安全错误。 */
	function captureProviderNativeError(
		callback: () => unknown,
		code: NativeCompactionError["code"],
	): NativeCompactionError {
		let thrown: unknown;
		try {
			callback();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(NativeCompactionError);
		expect((thrown as NativeCompactionError).code).toBe(code);
		return thrown as NativeCompactionError;
	}

	it("dispatches on model.api for mixed-API providers", async () => {
		const calls: string[] = [];
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [testModel("api-a", "model-a"), testModel("api-b", "model-b")],
			api: { "api-a": recordingStreams("a", calls), "api-b": recordingStreams("b", calls) },
		});
		const models = createModels();
		models.setProvider(provider);

		await models.completeSimple(testModel("api-a", "model-a"), context);
		await models.completeSimple(testModel("api-b", "model-b"), context);
		expect(calls).toEqual(["a:model-a", "b:model-b"]);
	});

	it("merges provider-resolved env into stream options", async () => {
		let capturedEnv: Record<string, string> | undefined;
		let capturedApiKey: string | undefined;
		const envModel = { ...testModel("api-a", "model-a"), provider: "env-provider" };
		const provider = createProvider({
			id: "env-provider",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async () => ({
						auth: { apiKey: "provider-key" },
						env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
					}),
				},
			},
			models: [envModel],
			api: {
				stream: (model, _context, options) => {
					capturedEnv = options?.env;
					capturedApiKey = options?.apiKey;
					return recordingStreams("a", []).stream(model, _context, options);
				},
				streamSimple: (model, _context, options) => {
					capturedEnv = options?.env;
					capturedApiKey = options?.apiKey;
					return recordingStreams("a", []).streamSimple(model, _context, options);
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);

		await models.completeSimple(envModel, context, {
			apiKey: "request-key",
			env: { REQUEST_ONLY: "request", SHARED: "request" },
		});

		expect(capturedApiKey).toBe("request-key");
		expect(capturedEnv).toEqual({ PROVIDER_ONLY: "provider", REQUEST_ONLY: "request", SHARED: "request" });
	});

	it("produces a stream error for a model whose api has no implementation", async () => {
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [testModel("api-a", "model-a")],
			api: { "api-a": recordingStreams("a", []) },
		});
		const result = await provider
			.streamSimple(testModel("api-ghost", "model-x") as unknown as Model<"api-a">, context)
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no API implementation");
	});

	it("supports dynamic providers: empty until refreshed, in-flight refreshes deduped", async () => {
		let fetches = 0;
		const provider = createProvider({
			id: "dynamic",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [],
			fetchModels: async () => {
				fetches++;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return [testModel("api-a", "listed")];
			},
			api: recordingStreams("a", []),
		});

		const store = new InMemoryModelsStore();
		const refreshContext = {
			credential: { type: "api_key" as const },
			store: {
				read: () => store.read("dynamic"),
				write: (entry: ModelsStoreEntry) => store.write("dynamic", entry),
				delete: () => store.delete("dynamic"),
			},
			allowNetwork: true,
		};
		expect(provider.getModels()).toEqual([]);
		await Promise.all([provider.refreshModels?.(refreshContext), provider.refreshModels?.(refreshContext)]);
		expect(fetches).toBe(1);
		expect(provider.getModels().map((m) => m.id)).toEqual(["listed"]);

		// a later refresh fetches again
		await provider.refreshModels?.(refreshContext);
		expect(fetches).toBe(2);
	});

	it("按 API 暴露完整原生压缩三件套，并复制冻结公开 Options", () => {
		const model = testNativeModel("openai-responses", "gpt-test");
		let capturedOptions: Readonly<NativeCompactionPublicOptionsMap["openai-responses"]> | undefined;
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-responses">((_model, options) => {
				capturedOptions = options;
				return {
					primary: { endpoint: "https://api.openai.test/v1", protocol: "openai-responses-compact" },
					fallbacks: [],
				};
			}),
		});
		const controller = new AbortController();
		const fetchHandle: typeof fetch = async () => new Response();
		const onPayload = (payload: unknown) => payload;
		const onResponse = () => undefined;
		const headers = { Authorization: "Bearer test", Suppressed: null };
		const env = { TEST_ENV: "value" };
		const options = {
			signal: controller.signal,
			fetch: fetchHandle,
			onPayload,
			onResponse,
			headers,
			env,
			apiKey: "test-key",
			sessionId: "session",
			cacheRetention: "long" as const,
			timeoutMs: 1.5,
			maxRetries: 2,
			maxRetryDelayMs: 25.5,
			reasoningEffort: "high" as const,
			reasoningSummary: "concise" as const,
			serviceTier: "priority" as const,
		};

		expect(provider.compact).toBeTypeOf("function");
		expect(provider.canConsumeProviderContext).toBeTypeOf("function");
		expect(provider.resolveNativeCompactionRoutes?.(model, options)).toEqual({
			primary: { endpoint: "https://api.openai.test/v1", protocol: "openai-responses-compact" },
			fallbacks: [],
		});
		expect(capturedOptions).not.toBe(options);
		expect(Object.isFrozen(capturedOptions)).toBe(true);
		expect(Object.isFrozen(capturedOptions?.headers)).toBe(true);
		expect(Object.isFrozen(capturedOptions?.env)).toBe(true);
		expect(capturedOptions?.signal).toBe(controller.signal);
		expect(capturedOptions?.fetch).toBe(fetchHandle);
		expect(capturedOptions?.onPayload).toBe(onPayload);
		expect(capturedOptions?.onResponse).toBe(onResponse);
		headers.Authorization = "changed";
		env.TEST_ENV = "changed";
		expect(capturedOptions?.headers?.Authorization).toBe("Bearer test");
		expect(capturedOptions?.env?.TEST_ENV).toBe("value");
		expect(Object.isFrozen(controller.signal)).toBe(false);
	});

	it("严格复制、冻结并闭合校验 Route Set", () => {
		const model = testNativeModel("openai-responses", "gpt-test");
		const rawRoutes = {
			primary: { endpoint: "https://api.openai.test/v1", protocol: "openai-responses-compact" as const },
			fallbacks: [{ endpoint: "https://backup.openai.test/v1", protocol: "openai-responses-compact" as const }],
		};
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-responses">(() => rawRoutes),
		});

		const routes = provider.resolveNativeCompactionRoutes?.(model, {});
		if (!routes) expect.unreachable("完整 Native Provider 必须暴露 Route Set Resolver");
		rawRoutes.primary.endpoint = "https://mutated.test/v1";
		rawRoutes.fallbacks[0]!.endpoint = "https://mutated-backup.test/v1";
		expect(routes).toEqual({
			primary: { endpoint: "https://api.openai.test/v1", protocol: "openai-responses-compact" },
			fallbacks: [{ endpoint: "https://backup.openai.test/v1", protocol: "openai-responses-compact" }],
		});
		expect(Object.isFrozen(routes)).toBe(true);
		expect(Object.isFrozen(routes.primary)).toBe(true);
		expect(Object.isFrozen(routes.fallbacks)).toBe(true);
		expect(Object.isFrozen(routes.fallbacks[0])).toBe(true);

		let accessorReads = 0;
		const accessorFallbacks: unknown[] = [];
		Object.defineProperty(accessorFallbacks, "0", {
			enumerable: true,
			get: () => {
				accessorReads++;
				return rawRoutes.primary;
			},
		});
		accessorFallbacks.length = 1;
		const sparseFallbacks = new Array(1);
		const symbolRoute = { endpoint: "https://symbol.test/v1", protocol: "openai-responses-compact" };
		Object.defineProperty(symbolRoute, Symbol("hidden"), { value: true, enumerable: true });
		const invalidRouteSets: unknown[] = [
			{ primary: rawRoutes.primary },
			{ primary: rawRoutes.primary, fallbacks: [], extra: true },
			{ primary: rawRoutes.primary, fallbacks: [rawRoutes.primary] },
			{ primary: rawRoutes.primary, fallbacks: sparseFallbacks },
			{ primary: rawRoutes.primary, fallbacks: accessorFallbacks },
			{ primary: symbolRoute, fallbacks: [] },
			{ primary: { endpoint: "/relative", protocol: "openai-responses-compact" }, fallbacks: [] },
		];
		for (const invalidRoutes of invalidRouteSets) {
			const invalidProvider = createProvider({
				id: "mixed",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model],
				api: nativeStreams<"openai-responses">(() => invalidRoutes as never),
			});
			captureProviderNativeError(() => invalidProvider.resolveNativeCompactionRoutes?.(model, {}), "protocol");
		}
		expect(accessorReads).toBe(0);
	});

	it("让 Codex 使用独立 Options 值域，不向 OpenAI Public 借用", () => {
		const model = testNativeModel("openai-codex-responses", "codex-test");
		let capturedOptions: Readonly<NativeCompactionPublicOptionsMap["openai-codex-responses"]> | undefined;
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-codex-responses">((_model, options) => {
				capturedOptions = options;
				return {
					primary: {
						endpoint: "https://chatgpt.test/backend-api/codex",
						protocol: "openai-codex-remote-v2",
					},
					fallbacks: [],
				};
			}),
		});

		provider.resolveNativeCompactionRoutes?.(model, {
			reasoningEffort: "none",
			reasoningSummary: "off",
			textVerbosity: "high",
		});
		expect(capturedOptions).toMatchObject({
			reasoningEffort: "none",
			reasoningSummary: "off",
			textVerbosity: "high",
		});
	});

	it.each([
		["openai-responses", { reasoningEffort: "none" }],
		["openai-responses", { textVerbosity: "low" }],
		["openai-responses", { toolChoice: "auto" }],
		["openai-codex-responses", { toolChoice: "auto" }],
		["openai-codex-responses", { azureResourceName: "resource" }],
		["openai-codex-responses", { unknownField: true }],
		["openai-codex-responses", { binding: {} }],
		["openai-codex-responses", { credentialScopeHash: "secret" }],
		["openai-codex-responses", { providerContext: {} }],
		["openai-codex-responses", { requestId: "request" }],
		["openai-responses", { signal: {} }],
		["openai-responses", { maxRetries: 1.5 }],
		["openai-responses", JSON.parse('{"headers":{"__proto__":"unsafe"}}')],
	] as const)("拒绝 %s 的越界公开 Options", (api, unsafeOptions) => {
		const model = testNativeModel(api, "test");
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<typeof api>((_model) => ({
				primary: {
					endpoint: "https://example.test/native",
					protocol: api === "openai-responses" ? "openai-responses-compact" : "openai-codex-remote-v2",
				},
				fallbacks: [],
			})),
		});

		expect(() =>
			provider.resolveNativeCompactionRoutes?.(
				model,
				unsafeOptions as unknown as NativeCompactionPublicOptionsMap[typeof api],
			),
		).toThrowError(NativeCompactionError);
		try {
			provider.resolveNativeCompactionRoutes?.(
				model,
				unsafeOptions as unknown as NativeCompactionPublicOptionsMap[typeof api],
			);
		} catch (error) {
			expect((error as NativeCompactionError).code).toBe("invalid_context");
		}
	});

	it("By-API Provider 对 Custom API 和不完整 Capability 返回 Unsupported", () => {
		const nativeModel = testNativeModel("openai-responses", "native");
		const customModel = testModel("custom-api", "custom");
		const partialStreams = {
			...recordingStreams("partial", []),
			compact: async () => {
				throw createNativeCompactionError("provider_error");
			},
		} as unknown as ProviderStreams<"openai-responses">;
		const partialProvider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [nativeModel],
			api: partialStreams,
		});
		expect(() => partialProvider.resolveNativeCompactionRoutes?.(nativeModel, {})).toThrowError(
			NativeCompactionError,
		);
		try {
			partialProvider.resolveNativeCompactionRoutes?.(nativeModel, {});
		} catch (error) {
			expect((error as NativeCompactionError).code).toBe("unsupported");
		}

		const mixedProvider = createProvider<"openai-responses" | "custom-api">({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [nativeModel, customModel],
			api: {
				"openai-responses": nativeStreams<"openai-responses">(() => ({
					primary: { endpoint: "https://example.test/native", protocol: "openai-responses-compact" },
					fallbacks: [],
				})),
				"custom-api": recordingStreams("custom", []),
			},
		});
		expect(() =>
			mixedProvider.resolveNativeCompactionRoutes?.(customModel as unknown as Model<"openai-responses">, {}),
		).toThrowError(NativeCompactionError);
	});

	it("净化 Endpoint Resolver 的原始异常和非法返回", () => {
		const model = testNativeModel("openai-responses", "gpt-test");
		const failingProvider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-responses">(() => {
				throw new Error("sensitive-provider-error");
			}),
		});
		const crossProtocolProvider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-responses">(
				() =>
					({
						primary: { endpoint: "https://example.test/native", protocol: "openai-codex-remote-v2" },
						fallbacks: [],
					}) as never,
			),
		});
		const codexModel = testNativeModel("openai-codex-responses", "codex-test");
		const reverseCrossProtocolProvider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [codexModel],
			api: nativeStreams<"openai-codex-responses">(
				() =>
					({
						primary: { endpoint: "https://example.test/native", protocol: "openai-responses-compact" },
						fallbacks: [],
					}) as never,
			),
		});
		const invalidObjectProvider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-responses">(() => new Date() as never),
		});

		const providerError = captureProviderNativeError(
			() => failingProvider.resolveNativeCompactionRoutes?.(model, {}),
			"provider_error",
		);
		expect(String(providerError)).not.toContain("sensitive-provider-error");
		for (const [provider, endpointModel] of [
			[crossProtocolProvider, model],
			[reverseCrossProtocolProvider, codexModel],
			[invalidObjectProvider, model],
		] as const) {
			captureProviderNativeError(
				() => provider.resolveNativeCompactionRoutes?.(endpointModel as never, {}),
				"protocol",
			);
		}
	});

	it("拒绝 Provider 直接传入未由 Models 登记的同形请求", async () => {
		const model = testNativeModel("openai-responses", "gpt-test");
		const provider = createProvider({
			id: "mixed",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model],
			api: nativeStreams<"openai-responses">(() => ({
				primary: { endpoint: "https://example.test/native", protocol: "openai-responses-compact" },
				fallbacks: [],
			})),
		});
		const forgedRequest = {
			model,
			context: { messages: [] },
			options: {},
			binding: {},
			providerContext: undefined,
		} as unknown as NativeCompactionProviderRequest<"openai-responses">;

		expect(() => assertNativeCompactionProviderRequest(forgedRequest)).toThrowError(NativeCompactionError);
		await expect(provider.compact?.(forgedRequest)).rejects.toMatchObject({ code: "unsupported" });
		await expect(provider.canConsumeProviderContext?.(forgedRequest)).rejects.toMatchObject({ code: "unsupported" });
	});

	it("在类型层保持两个 Options 和请求字段闭合", () => {
		type PublicKeys = keyof NativeCompactionPublicOptionsMap["openai-responses"];
		type CodexKeys = keyof NativeCompactionPublicOptionsMap["openai-codex-responses"];
		type RequestKeys = keyof NativeCompactionProviderRequest<"openai-responses">;

		expectTypeOf<Extract<"textVerbosity", PublicKeys>>().toEqualTypeOf<never>();
		expectTypeOf<Extract<"textVerbosity", CodexKeys>>().toEqualTypeOf<"textVerbosity">();
		expectTypeOf<Extract<"toolChoice", PublicKeys | CodexKeys>>().toEqualTypeOf<never>();
		expectTypeOf<Extract<"providerContext", RequestKeys>>().toEqualTypeOf<"providerContext">();
		expectTypeOf<Extract<"api" | "requestId", RequestKeys>>().toEqualTypeOf<never>();

		const compileProviderTypeContract = () => {
			const typedProvider = {} as Provider<"openai-responses">;
			// @ts-expect-error Provider Capability 必须保持只读。
			typedProvider.compact = undefined;
			const partialCapability = {
				...recordingStreams("partial-type", []),
				compact: async () => {
					throw createNativeCompactionError("provider_error");
				},
			};
			// @ts-expect-error ProviderStreams 不允许只实现原生压缩三件套的一部分。
			const invalidStreams: ProviderStreams<"openai-responses"> = partialCapability;
			void invalidStreams;
			const erasedProvider = {} as Provider;
			const request = {} as NativeCompactionProviderRequest<"openai-responses">;
			// @ts-expect-error 异构集合中的擦除 Capability 不接受实际 Request。
			erasedProvider.compact?.(request);
		};
		void compileProviderTypeContract;
	});
});

describe("fauxProvider", () => {
	it("streams queued responses through a Models collection", async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("hello from faux")]);

		const model = models.getModels(faux.provider.id)[0];
		const result = await models.completeSimple(model, context);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello from faux" }]);
		expect(faux.state.callCount).toBe(1);
	});
});
