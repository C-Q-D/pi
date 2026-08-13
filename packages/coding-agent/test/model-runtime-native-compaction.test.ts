import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Model,
	type NativeCompactionBindingMismatchDimension,
	NativeCompactionError,
	type NativeCompactionProviderRequest,
	type NativeCompactionResult,
	type OAuthAuth,
	type ProviderContextBinding,
	type ProviderContextEnvelope,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

function compactedResult(binding: ProviderContextBinding): NativeCompactionResult {
	return {
		providerContext: {
			format: "openai-responses-compaction",
			version: 1,
			binding,
			items: [{ type: "compaction", encrypted_content: "opaque-faux-context" }],
		},
	};
}

function extensionModel(id: string): Omit<Model<"openai-responses">, "api" | "provider"> {
	return {
		id,
		name: id,
		baseUrl: "https://compat.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

describe("ModelRuntime native compaction", () => {
	it("keeps Faux stream-only by default and enables a production-shaped public capability explicitly", () => {
		const plain = fauxProvider();
		const native = fauxProvider({ nativeCompaction: {} });

		expect((plain.provider as unknown as Record<string, unknown>).compact).toBeUndefined();
		expect(plain.nativeCompaction).toBeUndefined();
		expect(native.api).toBe("openai-responses");
		expect(typeof (native.provider as unknown as Record<string, unknown>).compact).toBe("function");
		expect(native.nativeCompaction).toBeDefined();
		expect(() => fauxProvider({ api: "openai-codex-responses", nativeCompaction: {} })).toThrow(
			'only supports api "openai-responses"',
		);
	});

	it("uses one Models preflight and preserves configured/caller header order with effective env", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-native-runtime-"));
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"runtime-native": {
						modelOverrides: {
							"faux-1": {
								headers: {
									"x-configured": "$MODEL_HEADER",
									"x-shared": "configured",
								},
							},
						},
					},
				},
			}),
		);
		try {
			const faux = fauxProvider({ provider: "runtime-native", nativeCompaction: {} });
			const native = faux.nativeCompaction!;
			native.setResults([
				(request) => {
					expect(Object.isFrozen(request)).toBe(true);
					expect(request.options).not.toHaveProperty("transformHeaders");
					expect(request.options.headers).toEqual({
						"x-configured": "from-effective-env",
						"x-shared": "caller",
						"x-caller": "caller",
						"x-transformed": "caller-env",
					});
					expect(request.options.env).toEqual({
						MODEL_HEADER: "from-effective-env",
						CALLER_ONLY: "caller-env",
					});
					return compactedResult(request.binding);
				},
			]);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath,
				allowModelNetwork: false,
			});
			runtime.registerNativeProvider(faux.provider);
			const model = runtime.getModel("runtime-native", "faux-1") as Model<"openai-responses">;
			const transformHeaders = vi.fn(
				async (headers: Readonly<Record<string, string | null>>, env?: Readonly<Record<string, string>>) => {
					expect(headers).toEqual({
						"x-configured": "from-effective-env",
						"x-shared": "caller",
						"x-caller": "caller",
					});
					return { ...headers, "x-transformed": env?.CALLER_ONLY ?? null };
				},
			);
			const options = {
				headers: { "x-shared": "caller", "x-caller": "caller" },
				env: { MODEL_HEADER: "from-effective-env", CALLER_ONLY: "caller-env" },
				transformHeaders,
			};

			const result = await runtime.compact(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				options,
			);
			expect(await runtime.canConsumeProviderContext(model, result.providerContext, options)).toBe(true);
			expect(transformHeaders).toHaveBeenCalledTimes(2);
			expect(native.state.compactCallCount).toBe(1);
			expect(native.state.consumerCallCount).toBe(1);
			expect(faux.state.callCount).toBe(0);

			native.setResults([{} as NativeCompactionResult]);
			await expect(runtime.compact(model, { messages: [] }, options)).rejects.toMatchObject({ code: "protocol" });
			expect(native.state.compactCallCount).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the same exact Binding Guard for assertion and ordinary stream before provider dispatch", async () => {
		const faux = fauxProvider({ provider: "runtime-binding", nativeCompaction: {} });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		const model = runtime.getModel("runtime-binding", "faux-1") as Model<"openai-responses">;
		faux.nativeCompaction!.setResults([(request) => compactedResult(request.binding)]);
		const compacted = await runtime.compact(model, { messages: [] });

		await runtime.assertCanConsumeProviderContext(model, compacted.providerContext);
		faux.setResponses([fauxAssistantMessage("same binding")]);
		const sameBinding = await runtime
			.streamSimple(model, { messages: [], providerContext: compacted.providerContext })
			.result();
		expect(sameBinding.stopReason).toBe("stop");
		expect(faux.nativeCompaction!.state.consumerCallCount).toBe(2);
		expect(faux.state.callCount).toBe(1);

		const binding = compacted.providerContext.binding;
		const mismatches: Array<[NativeCompactionBindingMismatchDimension, ProviderContextEnvelope]> = [
			["provider", { ...compacted.providerContext, binding: { ...binding, provider: "other-provider" } }],
			["api", { ...compacted.providerContext, binding: { ...binding, api: "openai-codex-responses" } }],
			["model", { ...compacted.providerContext, binding: { ...binding, model: "other-model" } }],
			[
				"endpoint",
				{
					...compacted.providerContext,
					binding: { ...binding, endpoint: "https://other.example.test/v1/compact" },
				},
			],
			["protocol", { ...compacted.providerContext, binding: { ...binding, protocol: "openai-codex-remote-v2" } }],
			[
				"credential",
				{
					...compacted.providerContext,
					binding: {
						...binding,
						credentialScopeHash: binding.credentialScopeHash.replace(/^./u, (character) =>
							character === "0" ? "1" : "0",
						),
					},
				},
			],
		];
		for (const [bindingDimension, providerContext] of mismatches) {
			await expect(runtime.assertCanConsumeProviderContext(model, providerContext)).rejects.toMatchObject({
				code: "binding_mismatch",
				bindingDimension,
			});
			const message = await runtime.streamSimple(model, { messages: [], providerContext }).result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toBe("Native compaction context binding does not match the active provider.");
			expect(message.diagnostics).toEqual([
				expect.objectContaining({
					type: "native_compaction",
					details: { code: "binding_mismatch", bindingDimension },
				}),
			]);
		}
		expect(faux.nativeCompaction!.state.consumerCallCount).toBe(2);
		expect(faux.state.callCount).toBe(1);
	});

	it("lets Pi AI reject unsafe caller options before Runtime reads them", async () => {
		const faux = fauxProvider({ provider: "unsafe-runtime-native", nativeCompaction: {} });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		const model = runtime.getModel("unsafe-runtime-native", "faux-1") as Model<"openai-responses">;
		const sentinel = "UNSAFE_CALLER_GETTER";
		const options = Object.defineProperty({}, "headers", {
			enumerable: true,
			get() {
				throw new Error(sentinel);
			},
		});

		await expect(runtime.compact(model, { messages: [] }, options as never)).rejects.toSatisfy((error) => {
			expect(error).toBeInstanceOf(NativeCompactionError);
			expect((error as NativeCompactionError).code).toBe("invalid_context");
			expect((error as Error).message).not.toContain(sentinel);
			return true;
		});
		expect(faux.nativeCompaction!.state.compactCallCount).toBe(0);
	});

	it("preserves only the base native trio and rejects extension or compatibility stream branches", async () => {
		const config = await ModelConfig.load(undefined);
		const base = fauxProvider({ provider: "composed-native", nativeCompaction: {} });
		const extensionOverride = composeModelProvider("composed-native", base.provider, config, {
			apiKey: "extension-key",
			api: "openai-responses",
			streamSimple: () => {
				throw new Error("stream should not run");
			},
		});
		const overrideModels = createModels();
		overrideModels.setProvider(extensionOverride);
		await expect(
			overrideModels.compact(base.getModel() as Model<"openai-responses">, { messages: [] }),
		).rejects.toSatisfy((error) => {
			expect(error).toBeInstanceOf(NativeCompactionError);
			expect((error as NativeCompactionError).code).toBe("unsupported");
			return true;
		});
		expect(base.nativeCompaction!.state.compactCallCount).toBe(0);

		const compatibilityOnly = composeModelProvider("compat-only", undefined, config, {
			baseUrl: "https://compat.example.test/v1",
			apiKey: "compat-key",
			api: "openai-responses",
			models: [extensionModel("compat-model")],
		});
		expect((compatibilityOnly as unknown as Record<string, unknown>).compact).toBeUndefined();
		const compatibilityModels = createModels();
		compatibilityModels.setProvider(compatibilityOnly);
		await expect(
			compatibilityModels.compact(compatibilityOnly.getModels()[0] as Model<"openai-responses">, { messages: [] }),
		).rejects.toMatchObject({ code: "unsupported" });
	});

	it("resolves Codex OAuth once and never reclassifies the provider token as a caller override", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("runtime-codex", async () => ({
			type: "oauth",
			access: "old-provider-token",
			refresh: "refresh-token",
			expires: 0,
			accountId: "stable-account",
		}));
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "new-provider-token",
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "stable-account",
		}));
		const toAuth = vi.fn(async (credential: { access: string }) => ({ apiKey: credential.access }));
		const oauth: OAuthAuth = {
			name: "Runtime Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh,
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth,
		};
		const model: Model<"openai-codex-responses"> = {
			id: "codex-model",
			name: "Codex Model",
			api: "openai-codex-responses",
			provider: "runtime-codex",
			baseUrl: "https://chatgpt.example.test/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		};
		const compactCalls: NativeCompactionProviderRequest<"openai-codex-responses">[] = [];
		const streams: ProviderStreams<"openai-codex-responses"> = {
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
			compact: async (request) => {
				compactCalls.push(request);
				return compactedResult(request.binding);
			},
			canConsumeProviderContext: async () => true,
			resolveNativeCompactionRoutes: () => ({
				primary: {
					endpoint: "https://chatgpt.example.test/backend-api/codex/responses/compact",
					protocol: "openai-codex-remote-v2",
				},
				fallbacks: [],
			}),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(
			createProvider({ id: "runtime-codex", auth: { oauth }, models: [model], api: streams }),
		);
		await runtime.refresh({ allowNetwork: false });
		refresh.mockClear();
		toAuth.mockClear();

		await runtime.compact(model, { messages: [] });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(toAuth).toHaveBeenCalledTimes(1);
		expect(compactCalls[0]!.options.apiKey).toBe("new-provider-token");

		await expect(runtime.compact(model, { messages: [] }, { apiKey: "caller-token" })).rejects.toMatchObject({
			code: "unsupported",
		});
		await expect(
			runtime.compact(model, { messages: [] }, { headers: { Authorization: "Bearer caller-token" } }),
		).rejects.toMatchObject({ code: "unsupported" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(toAuth).toHaveBeenCalledTimes(1);
		expect(compactCalls).toHaveLength(1);
	});
});
