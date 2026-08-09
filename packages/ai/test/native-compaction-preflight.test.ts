import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { ApiKeyAuth, AuthContext, OAuthAuth } from "../src/auth/types.ts";
import { assertNativeCompactionProviderRequest, createModels, createProvider, type Models } from "../src/models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	NativeCompactionApi,
	NativeCompactionProviderRequest,
	NativeCompactionResult,
	ProviderContextEnvelope,
	ProviderStreams,
	StreamOptions,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { sha256Hex } from "../src/utils/hash.ts";
import { NativeCompactionError } from "../src/utils/native-compaction.ts";

const authContext: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};

function openAICodexAccessToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function nativeModel<TApi extends NativeCompactionApi>(provider: string, api: TApi): Model<TApi> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api,
		provider,
		baseUrl: "https://api.example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

function doneStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

interface NativeHarness<TApi extends NativeCompactionApi> {
	model: Model<TApi>;
	compactCalls: NativeCompactionProviderRequest<TApi>[];
	consumerCalls: NativeCompactionProviderRequest<TApi>[];
	streamCalls: Array<{ model: Model<Api>; context: Context; options?: StreamOptions }>;
	consumerResult: { value: unknown };
	resultBindingOverride: { value?: Partial<NativeCompactionProviderRequest<TApi>["binding"]> };
	endpoint: { value: string };
	streamError: { value?: unknown };
	rawCompactResult: { value?: unknown };
}

function nativeHarness<TApi extends NativeCompactionApi>(
	providerId: string,
	api: TApi,
	auth: ApiKeyAuth | OAuthAuth,
): NativeHarness<TApi> & { provider: ReturnType<typeof createProvider<TApi>> } {
	const model = nativeModel(providerId, api);
	const compactCalls: NativeCompactionProviderRequest<TApi>[] = [];
	const consumerCalls: NativeCompactionProviderRequest<TApi>[] = [];
	const streamCalls: NativeHarness<TApi>["streamCalls"] = [];
	const consumerResult = { value: true };
	const resultBindingOverride: NativeHarness<TApi>["resultBindingOverride"] = {};
	const endpoint = { value: "https://api.example.test/v1/responses?mode=compact" };
	const streamError: NativeHarness<TApi>["streamError"] = {};
	const rawCompactResult: NativeHarness<TApi>["rawCompactResult"] = {};
	const harness: NativeHarness<TApi> = {
		model,
		compactCalls,
		consumerCalls,
		streamCalls,
		consumerResult,
		resultBindingOverride,
		endpoint,
		streamError,
		rawCompactResult,
	};
	const streams = {
		stream: (requestModel: Model<NativeCompactionApi>, context: Context, options?: StreamOptions) => {
			if (harness.streamError.value) throw harness.streamError.value;
			streamCalls.push({ model: requestModel, context, options });
			return doneStream(requestModel);
		},
		streamSimple: (requestModel: Model<NativeCompactionApi>, context: Context, options?: StreamOptions) => {
			if (harness.streamError.value) throw harness.streamError.value;
			streamCalls.push({ model: requestModel, context, options });
			return doneStream(requestModel);
		},
		compact: async (request: NativeCompactionProviderRequest<TApi>): Promise<NativeCompactionResult> => {
			assertNativeCompactionProviderRequest(request);
			compactCalls.push(request);
			if (Object.hasOwn(harness.rawCompactResult, "value")) {
				return harness.rawCompactResult.value as NativeCompactionResult;
			}
			return {
				providerContext: {
					format: "openai-responses-compaction",
					version: 1,
					binding: { ...request.binding, ...harness.resultBindingOverride.value },
					items: [{ type: "compaction", encrypted_content: "opaque" }],
				},
			};
		},
		canConsumeProviderContext: async (request: NativeCompactionProviderRequest<TApi>): Promise<boolean> => {
			assertNativeCompactionProviderRequest(request);
			consumerCalls.push(request);
			return harness.consumerResult.value as boolean;
		},
		resolveNativeCompactionEndpoint: () => ({
			endpoint: harness.endpoint.value,
			protocol: api === "openai-responses" ? "openai-responses-compact" : "openai-codex-remote-v2",
		}),
	} as unknown as ProviderStreams<TApi>;
	const provider = createProvider({
		id: providerId,
		auth: "resolve" in auth ? { apiKey: auth } : { oauth: auth },
		models: [model],
		api: streams,
	});
	return { ...harness, provider };
}

const apiKeyAuth: ApiKeyAuth = {
	name: "Test key",
	resolve: async () => ({ auth: { apiKey: "secret-api-key" }, source: "test" }),
};

function expectNativeCode(error: unknown, code: NativeCompactionError["code"]): void {
	expect(error).toBeInstanceOf(NativeCompactionError);
	expect((error as NativeCompactionError).code).toBe(code);
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("Models native compaction preflight", () => {
	it("exposes optional native capability on the public Models type", () => {
		const models: Models = createModels({ authContext });
		expectTypeOf(models.compact).toMatchTypeOf<Models["compact"]>();
		expect(typeof models.compact).toBe("function");
		expect(typeof models.canConsumeProviderContext).toBe("function");
	});

	it("reads the OpenAI Codex stable subject only through its provider-owned callback", async () => {
		expect(
			await openaiCodexOAuth.getStableSubject?.({
				type: "oauth",
				access: openAICodexAccessToken("account-a"),
				refresh: "opaque",
				expires: 1,
				accountId: "account-a",
			}),
		).toBe("account-a");
		expect(
			await openaiCodexOAuth.getStableSubject?.({
				type: "oauth",
				access: "opaque",
				refresh: "opaque",
				expires: 1,
			}),
		).toBeUndefined();
	});

	it("binds the final API key, preserves endpoint query, brands and freezes the canonical request", async () => {
		const harness = nativeHarness("public", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const context: Context = {
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "lookup",
					content: [{ type: "text", text: "done" }],
					details: new Date(),
					isError: false,
					timestamp: 2,
				},
			],
			tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({ query: Type.String() }) }],
		};

		const result = await models.compact(harness.model, context);
		const request = harness.compactCalls[0]!;
		expect(request.binding).toEqual({
			provider: "public",
			api: "openai-responses",
			model: "gpt-test",
			endpoint: "https://api.example.test/v1/responses?mode=compact",
			format: "openai-responses-compaction",
			protocol: "openai-responses-compact",
			credentialScopeHash: await sha256Hex("api-key:secret-api-key"),
		});
		expect(Object.isFrozen(request)).toBe(true);
		expect(Object.isFrozen(request.context.messages)).toBe(true);
		expect("details" in request.context.messages[1]!).toBe(false);
		expect(Reflect.ownKeys(request.context.tools![0]!.parameters)).not.toContain("~kind");
		expect(result.providerContext.binding).toEqual(request.binding);
	});

	it("snapshots model, context and options before asynchronous auth finishes", async () => {
		let finishAuth: (value: { auth: { apiKey: string } }) => void = () => {};
		const authResult = new Promise<{ auth: { apiKey: string } }>((resolve) => {
			finishAuth = resolve;
		});
		const delayedAuth: ApiKeyAuth = {
			name: "Delayed",
			resolve: () => authResult,
		};
		const harness = nativeHarness("snapshot", "openai-responses", delayedAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const context: Context = { messages: [{ role: "user", content: "before", timestamp: 1 }] };
		const options = { sessionId: "before" };
		const pending = models.compact(harness.model, context, options);
		harness.model.id = "after";
		(context.messages[0] as { content: string }).content = "after";
		options.sessionId = "after";
		finishAuth({ auth: { apiKey: "stable-key" } });
		await pending;
		const request = harness.compactCalls[0]!;
		expect(request.model.id).toBe("gpt-test");
		expect(request.context.messages[0]).toMatchObject({ content: "before" });
		expect(request.options.sessionId).toBe("before");
	});

	it("rejects mismatched provider context before calling the consumer or stream", async () => {
		const harness = nativeHarness("mismatch", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const compacted = await models.compact(harness.model, { messages: [] });
		const mismatched: ProviderContextEnvelope = {
			...compacted.providerContext,
			binding: { ...compacted.providerContext.binding, model: "different" },
		};
		await expect(models.canConsumeProviderContext(harness.model, mismatched)).rejects.toSatisfy((error) => {
			expectNativeCode(error, "binding_mismatch");
			return true;
		});
		expect(harness.consumerCalls).toHaveLength(0);
		expect(harness.streamCalls).toHaveLength(0);
	});

	it("returns consumer false publicly and prevents ordinary stream provider dispatch", async () => {
		const harness = nativeHarness("consumer", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const compacted = await models.compact(harness.model, { messages: [] });
		harness.consumerResult.value = false;
		expect(await models.canConsumeProviderContext(harness.model, compacted.providerContext)).toBe(false);
		const message = await models
			.stream(harness.model, { messages: [], providerContext: compacted.providerContext })
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Native compaction is not supported.");
		expect(harness.streamCalls).toHaveLength(0);
	});

	it("leaves ordinary streams without provider context on the existing path", async () => {
		const harness = nativeHarness("ordinary", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		Object.defineProperty(context, "localOnly", { value: new Date(), enumerable: false });
		const result = await models.stream(harness.model, context).result();
		expect(result.stopReason).toBe("stop");
		expect(harness.consumerCalls).toHaveLength(0);
		expect(harness.streamCalls[0]!.context).toBe(context);
	});

	it("sanitizes synchronous provider failures after native consumer preflight", async () => {
		const harness = nativeHarness("stream-error", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const compacted = await models.compact(harness.model, { messages: [] });
		harness.streamError.value = new Error("SECRET_SENTINEL");
		const message = await models
			.stream(harness.model, { messages: [], providerContext: compacted.providerContext })
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Native compaction provider request failed.");
		expect(message.errorMessage).not.toContain("SECRET_SENTINEL");
	});

	it("rejects non-boolean consumers and mismatched results with fixed protocol errors", async () => {
		const harness = nativeHarness("protocol", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const compacted = await models.compact(harness.model, { messages: [] });
		harness.consumerResult.value = "yes";
		await expect(models.canConsumeProviderContext(harness.model, compacted.providerContext)).rejects.toSatisfy(
			(error) => {
				expectNativeCode(error, "protocol");
				return true;
			},
		);
		harness.resultBindingOverride.value = { endpoint: "https://different.example.test/v1" };
		await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "binding_mismatch");
			return true;
		});
	});

	it("maps malformed provider compact results to protocol errors", async () => {
		const harness = nativeHarness("bad-result", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		for (const result of [
			{},
			{
				providerContext: { format: "openai-responses-compaction", version: 1, binding: {}, items: [] },
				extra: true,
			},
			{
				providerContext: {
					format: "openai-responses-compaction",
					version: 1,
					binding: {
						provider: "bad-result",
						api: "openai-responses",
						model: "gpt-test",
						endpoint: "https://api.example.test/v1/responses?mode=compact",
						format: "openai-responses-compaction",
						protocol: "openai-responses-compact",
						credentialScopeHash: await sha256Hex("api-key:secret-api-key"),
					},
					items: [],
				},
				usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 },
			},
		]) {
			harness.rawCompactResult.value = result;
			await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "protocol");
				return true;
			});
		}
	});

	it("checks complete capability before resolving credentials", async () => {
		const resolve = vi.fn(apiKeyAuth.resolve);
		const model = nativeModel("plain", "openai-responses");
		const provider = createProvider<"openai-responses">({
			id: "plain",
			auth: { apiKey: { ...apiKeyAuth, resolve } },
			models: [model],
			api: {
				stream: (requestModel) => doneStream(requestModel),
				streamSimple: (requestModel) => doneStream(requestModel),
			},
		});
		const models = createModels({ authContext });
		models.setProvider(provider);
		await expect(models.compact(model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "unsupported");
			return true;
		});
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects unsafe options and endpoints before provider API dispatch", async () => {
		const resolve = vi.fn(apiKeyAuth.resolve);
		const harness = nativeHarness("unsafe", "openai-responses", { ...apiKeyAuth, resolve });
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const accessorOptions = Object.defineProperty({}, "headers", {
			enumerable: true,
			get: () => ({ Authorization: "Bearer different" }),
		});
		await expect(models.compact(harness.model, { messages: [] }, accessorOptions)).rejects.toSatisfy((error) => {
			expectNativeCode(error, "invalid_context");
			return true;
		});
		await expect(
			models.compact(harness.model, { messages: [] }, { sessionId: undefined } as unknown as { sessionId: string }),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "invalid_context");
			return true;
		});
		expect(resolve).not.toHaveBeenCalled();

		harness.endpoint.value = "/relative";
		await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
		expect(harness.compactCalls).toHaveLength(0);
		for (const invalidEndpoint of [
			"https://api.example.test/v1#",
			"https://api.example.test/v1#fragment",
			"https://user:password@api.example.test/v1",
		]) {
			harness.endpoint.value = invalidEndpoint;
			await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "protocol");
				return true;
			});
		}
		harness.endpoint.value = "https://api.example.test/v1?literal=%23";
		await models.compact(harness.model, { messages: [] });
		expect(harness.compactCalls[0]!.binding.endpoint).toBe("https://api.example.test/v1?literal=%23");
	});

	it("rejects invalid canonical content and invalid models before auth", async () => {
		const resolve = vi.fn(apiKeyAuth.resolve);
		const harness = nativeHarness("canonical", "openai-responses", { ...apiKeyAuth, resolve });
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		for (const content of [[123], [{ type: "bogus", secret: "x" }], [{ type: "text", text: 123 }]]) {
			await expect(
				models.compact(harness.model, {
					messages: [{ role: "user", content, timestamp: 1 }],
				} as unknown as Context),
			).rejects.toSatisfy((error) => {
				expectNativeCode(error, "invalid_context");
				return true;
			});
		}
		for (const tool of [
			{ name: "bad", description: "bad", parameters: "bad" },
			{ name: "bad", description: "bad", parameters: {}, constrainedSampling: true },
			{
				name: "bad",
				description: "bad",
				parameters: {},
				constrainedSampling: { type: "json_schema", strict: "bogus" },
			},
			{
				name: "bad",
				description: "bad",
				parameters: {},
				constrainedSampling: { type: "grammar", variants: { openai_lark: 1 } },
			},
		]) {
			await expect(
				models.compact(harness.model, { messages: [], tools: [tool] } as unknown as Context),
			).rejects.toSatisfy((error) => {
				expectNativeCode(error, "invalid_context");
				return true;
			});
		}
		const invalidModel = { ...harness.model, id: 123 } as unknown as Model<"openai-responses">;
		await expect(models.compact(invalidModel, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "invalid_context");
			return true;
		});
		for (const compat of [{ supportsStrictMode: "yes" }, { unknown: true }]) {
			const invalidCompat = { ...harness.model, compat } as unknown as Model<"openai-responses">;
			await expect(models.compact(invalidCompat, { messages: [] })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "invalid_context");
				return true;
			});
		}
		expect(resolve).not.toHaveBeenCalled();
		expect(harness.compactCalls).toHaveLength(0);
	});

	it("omits local assistant diagnostics from the canonical provider request", async () => {
		const harness = nativeHarness("diagnostics", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		await models.compact(harness.model, {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-responses",
					provider: "diagnostics",
					model: "gpt-test",
					diagnostics: [123] as never,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});
		expect("diagnostics" in harness.compactCalls[0]!.context.messages[0]!).toBe(false);
	});

	it("maps unknown providers to fixed unsupported errors", async () => {
		const models = createModels({ authContext });
		const model = nativeModel("private-provider-name", "openai-responses");
		await expect(models.compact(model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "unsupported");
			expect((error as Error).message).not.toContain("private-provider-name");
			return true;
		});
	});

	it("uses provider-owned OAuth subject across model-header cloning and rejects caller token override", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex", async () => ({
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "account-a",
		}));
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh: async (credential) => credential,
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex", "openai-codex-responses", oauth);
		harness.model.headers = { "X-Model": "header" };
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		await models.compact(harness.model, { messages: [] });
		expect(harness.compactCalls[0]!.binding.credentialScopeHash).toBe(
			await sha256Hex("chatgpt-account:account-a:codex"),
		);
		await expect(models.compact(harness.model, { messages: [] }, { apiKey: "caller-token" })).rejects.toSatisfy(
			(error) => {
				expectNativeCode(error, "unsupported");
				return true;
			},
		);
		expect(harness.compactCalls).toHaveLength(1);
	});

	it("rejects Codex OAuth without a non-empty final access token", async () => {
		for (const auth of [{}, { headers: { Authorization: "Bearer header-only" } }, { apiKey: "" }]) {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("codex-empty", async () => ({
				type: "oauth",
				access: "stored-access",
				refresh: "stored-refresh",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "account-a",
			}));
			const oauth: OAuthAuth = {
				name: "Codex",
				login: async () => {
					throw new Error("unused");
				},
				refresh: async (credential) => credential,
				getStableSubject: async () => "account-a",
				toAuth: async () => auth,
			};
			const harness = nativeHarness("codex-empty", "openai-codex-responses", oauth);
			const models = createModels({ authContext, credentials });
			models.setProvider(harness.provider);
			await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "unsupported");
				return true;
			});
			expect(harness.compactCalls).toHaveLength(0);
		}
	});

	it("rejects OAuth account changes after refresh before provider API dispatch", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex-refresh", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "account-a",
		}));
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh: async () => ({
				type: "oauth",
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "account-b",
			}),
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex-refresh", "openai-codex-responses", oauth);
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "unsupported");
			return true;
		});
		expect(harness.compactCalls).toHaveLength(0);
	});

	it("rejects OAuth refresh that mutates the credential account in place", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex-in-place", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "account-a",
		}));
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh: async (credential) => {
				credential.accountId = "account-b";
				credential.access = "new-access";
				credential.expires = Date.now() + 60 * 60 * 1000;
				return credential;
			},
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex-in-place", "openai-codex-responses", oauth);
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "unsupported");
			return true;
		});
		expect(harness.compactCalls).toHaveLength(0);
	});

	it("keeps concurrent OAuth refresh requests bound to each request's initially observed account", async () => {
		for (const targetAccount of ["account-a", "account-b"]) {
			const providerId = `codex-concurrent-${targetAccount}`;
			const credentials = new InMemoryCredentialStore();
			await credentials.modify(providerId, async () => ({
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: 0,
				accountId: "account-a",
			}));
			let releaseSecondSubject = (): void => {};
			const secondSubjectMayFinish = new Promise<void>((resolve) => {
				releaseSecondSubject = resolve;
			});
			let subjectCalls = 0;
			const refresh = vi.fn(async (credential) => {
				credential.access = "new-access";
				credential.refresh = "new-refresh";
				credential.expires = Date.now() + 60 * 60 * 1000;
				credential.accountId = targetAccount;
				releaseSecondSubject();
				return credential;
			});
			const oauth: OAuthAuth = {
				name: "Codex",
				login: async () => {
					throw new Error("unused");
				},
				refresh,
				getStableSubject: async (credential) => {
					subjectCalls++;
					if (subjectCalls === 2) await secondSubjectMayFinish;
					return typeof credential.accountId === "string" ? credential.accountId : undefined;
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			};
			const harness = nativeHarness(providerId, "openai-codex-responses", oauth);
			const models = createModels({ authContext, credentials });
			models.setProvider(harness.provider);
			const results = await Promise.allSettled([
				models.compact(harness.model, { messages: [] }),
				models.compact(harness.model, { messages: [] }),
			]);
			expect(refresh).toHaveBeenCalledTimes(1);
			if (targetAccount === "account-a") {
				expect(results.every((result) => result.status === "fulfilled")).toBe(true);
				expect(harness.compactCalls).toHaveLength(2);
			} else {
				for (const result of results) {
					expect(result.status).toBe("rejected");
					if (result.status === "rejected") expectNativeCode(result.reason, "unsupported");
				}
				expect(harness.compactCalls).toHaveLength(0);
			}
		}
	});

	it("allows same-account OAuth refresh, forwards AbortSignal, and rejects pre-aborted work", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex-same", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "account-a",
		}));
		const refresh = vi.fn(async (_credential, signal?: AbortSignal) => ({
			type: "oauth" as const,
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "account-a",
			signalSeen: signal,
		}));
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh,
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex-same", "openai-codex-responses", oauth);
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		const controller = new AbortController();
		await models.compact(harness.model, { messages: [] }, { signal: controller.signal });
		expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-a" }), controller.signal);
		expect(harness.compactCalls).toHaveLength(1);

		const aborted = new AbortController();
		aborted.abort();
		await expect(models.compact(harness.model, { messages: [] }, { signal: aborted.signal })).rejects.toSatisfy(
			(error) => {
				expectNativeCode(error, "aborted");
				return true;
			},
		);
		expect(harness.compactCalls).toHaveLength(1);
	});

	it("maps an aborting OAuth refresh rejection to aborted before provider dispatch", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex-abort-refresh", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "account-a",
		}));
		const refreshStarted = deferred<void>();
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh: async (_credential, signal) => {
				refreshStarted.resolve();
				await new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("refresh aborted")), { once: true });
				});
				throw new Error("unreachable");
			},
			getStableSubject: async () => "account-a",
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex-abort-refresh", "openai-codex-responses", oauth);
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		const controller = new AbortController();
		const result = models.compact(harness.model, { messages: [] }, { signal: controller.signal });
		await refreshStarted.promise;
		controller.abort();
		await expect(result).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(harness.compactCalls).toHaveLength(0);
	});

	it("maps provider compact rejection after abort to aborted", async () => {
		const harness = nativeHarness("abort-compact", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const pending = deferred<NativeCompactionResult>();
		harness.rawCompactResult.value = pending.promise;
		const controller = new AbortController();
		const result = models.compact(harness.model, { messages: [] }, { signal: controller.signal });
		await vi.waitFor(() => expect(harness.compactCalls).toHaveLength(1));
		controller.abort();
		pending.reject(new Error("provider aborted"));
		await expect(result).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
	});

	it("maps consumer rejection after abort to aborted and skips stream dispatch", async () => {
		const harness = nativeHarness("abort-consumer", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		const compacted = await models.compact(harness.model, { messages: [] });
		const pending = deferred<boolean>();
		harness.consumerResult.value = pending.promise;
		const controller = new AbortController();
		const result = models
			.stream(
				harness.model,
				{ messages: [], providerContext: compacted.providerContext },
				{ signal: controller.signal },
			)
			.result();
		await vi.waitFor(() => expect(harness.consumerCalls).toHaveLength(1));
		controller.abort();
		pending.reject(new Error("consumer aborted"));
		const message = await result;
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Native compaction was aborted.");
		expect(harness.streamCalls).toHaveLength(0);
	});

	it("stops before refresh when initial OAuth subject resolution is aborted", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex-abort-initial-subject", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			accountId: "account-a",
		}));
		const subjectStarted = deferred<void>();
		const subjectMayFinish = deferred<void>();
		const refresh = vi.fn(async (credential) => credential);
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh,
			getStableSubject: async (credential) => {
				subjectStarted.resolve();
				await subjectMayFinish.promise;
				return typeof credential.accountId === "string" ? credential.accountId : undefined;
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex-abort-initial-subject", "openai-codex-responses", oauth);
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		const controller = new AbortController();
		const result = models.compact(harness.model, { messages: [] }, { signal: controller.signal });
		await subjectStarted.promise;
		controller.abort();
		subjectMayFinish.resolve();
		await expect(result).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(harness.compactCalls).toHaveLength(0);
	});

	it("maps final OAuth subject rejection after abort to aborted", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("codex-abort-final-subject", async () => ({
			type: "oauth",
			access: "valid-access",
			refresh: "valid-refresh",
			expires: Date.now() + 60 * 60 * 1000,
			accountId: "account-a",
		}));
		const subjectStarted = deferred<void>();
		const subjectMayFinish = deferred<string>();
		const oauth: OAuthAuth = {
			name: "Codex",
			login: async () => {
				throw new Error("unused");
			},
			refresh: async (credential) => credential,
			getStableSubject: async () => {
				subjectStarted.resolve();
				return subjectMayFinish.promise;
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const harness = nativeHarness("codex-abort-final-subject", "openai-codex-responses", oauth);
		const models = createModels({ authContext, credentials });
		models.setProvider(harness.provider);
		const controller = new AbortController();
		const result = models.compact(harness.model, { messages: [] }, { signal: controller.signal });
		await subjectStarted.promise;
		controller.abort();
		subjectMayFinish.reject(new Error("subject aborted"));
		await expect(result).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(harness.compactCalls).toHaveLength(0);
	});

	it("sanitizes unavailable Web Crypto before provider dispatch", async () => {
		const harness = nativeHarness("no-crypto", "openai-responses", apiKeyAuth);
		const models = createModels({ authContext });
		models.setProvider(harness.provider);
		vi.stubGlobal("crypto", undefined);
		try {
			await expect(models.compact(harness.model, { messages: [] })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "provider_error");
				expect((error as Error).message).not.toContain("subtle");
				return true;
			});
			expect(harness.compactCalls).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
