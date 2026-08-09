import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import {
	complete as compatComplete,
	stream as compatStream,
	getApiProvider,
	getModel,
	registerApiProvider,
	resetApiProviders,
} from "../src/compat.ts";
import { assertNativeCompactionProviderRequest, createModels, createProvider } from "../src/models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	NativeCompactionProviderRequest,
	NativeCompactionResult,
	ProviderStreams,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { NativeCompactionError } from "../src/utils/native-compaction.ts";

const authContext = {
	env: async (): Promise<string | undefined> => undefined,
	fileExists: async (): Promise<boolean> => false,
};

const model: Model<"openai-responses"> = {
	id: "gpt-lazy-test",
	name: "GPT Lazy Test",
	api: "openai-responses",
	provider: "lazy-test",
	baseUrl: "https://api.example.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

function message(requestModel: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
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
}

function doneStream(requestModel: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = message(requestModel);
	stream.push({ type: "start", partial: output });
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end(output);
	return stream;
}

function expectNativeCode(error: unknown, code: NativeCompactionError["code"]): void {
	expect(error).toBeInstanceOf(NativeCompactionError);
	expect((error as NativeCompactionError).code).toBe(code);
}

interface LazyHarness {
	lazy: ReturnType<typeof lazyApi<"openai-responses">>;
	load: ReturnType<typeof vi.fn>;
	publicResolver: ReturnType<typeof vi.fn>;
	moduleResolver: ReturnType<typeof vi.fn>;
	compact: ReturnType<typeof vi.fn>;
	consumer: ReturnType<typeof vi.fn>;
	stream: ReturnType<typeof vi.fn>;
	state: {
		endpoint: string;
		compactResult?: unknown;
		consumerResult: unknown;
	};
	capturedRequests: NativeCompactionProviderRequest<"openai-responses">[];
}

function createLazyHarness(): LazyHarness {
	const state: LazyHarness["state"] = {
		endpoint: "https://api.example.test/v1/responses?mode=compact",
		consumerResult: true,
	};
	const capturedRequests: NativeCompactionProviderRequest<"openai-responses">[] = [];
	const stream = vi.fn((requestModel: Model<Api>) => doneStream(requestModel));
	const moduleResolver = vi.fn(() => ({
		endpoint: state.endpoint,
		protocol: "openai-responses-compact" as const,
	}));
	const compact = vi.fn(async (request: NativeCompactionProviderRequest<"openai-responses">) => {
		assertNativeCompactionProviderRequest(request);
		capturedRequests.push(request);
		if (Object.hasOwn(state, "compactResult")) return state.compactResult as NativeCompactionResult;
		return {
			providerContext: {
				format: "openai-responses-compaction" as const,
				version: 1 as const,
				binding: request.binding,
				items: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		};
	});
	const consumer = vi.fn(async (request: NativeCompactionProviderRequest<"openai-responses">) => {
		assertNativeCompactionProviderRequest(request);
		return state.consumerResult as boolean;
	});
	const module: ProviderStreams<"openai-responses"> = {
		stream,
		streamSimple: stream,
		compact,
		canConsumeProviderContext: consumer,
		resolveNativeCompactionEndpoint: moduleResolver,
	};
	const load = vi.fn(async () => module);
	const publicResolver = vi.fn(() => ({
		endpoint: "https://api.example.test/v1/responses?mode=compact",
		protocol: "openai-responses-compact" as const,
	}));
	const lazy = lazyApi(load, { nativeCompaction: { resolveNativeCompactionEndpoint: publicResolver } });
	return { lazy, load, publicResolver, moduleResolver, compact, consumer, stream, state, capturedRequests };
}

function createNativeModels(harness: LazyHarness) {
	const provider = createProvider({
		id: model.provider,
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		models: [model],
		api: harness.lazy,
	});
	const models = createModels({ authContext });
	models.setProvider(provider);
	return models;
}

describe("native compaction lazy boundary", () => {
	it("keeps the default lazy API stream-only and loads only for an ordinary stream", async () => {
		const stream = vi.fn((requestModel: Model<Api>) => doneStream(requestModel));
		const load = vi.fn(async (): Promise<ProviderStreams> => ({ stream, streamSimple: stream }));
		const lazy = lazyApi(load);
		expectTypeOf(lazy.compact).toEqualTypeOf<undefined>();
		expect("compact" in lazy).toBe(false);
		expect(load).not.toHaveBeenCalled();
		await lazy.stream(model, { messages: [] }).result();
		expect(load).toHaveBeenCalledTimes(1);
		expect(stream).toHaveBeenCalledTimes(1);
	});

	it("rejects an unbranded request before reading options or loading", async () => {
		const harness = createLazyHarness();
		let optionReads = 0;
		const forged = Object.defineProperty({}, "options", {
			get: () => {
				optionReads++;
				return { signal: AbortSignal.abort() };
			},
		}) as NativeCompactionProviderRequest<"openai-responses">;
		await expect(harness.lazy.compact(forged)).rejects.toSatisfy((error) => {
			expectNativeCode(error, "unsupported");
			return true;
		});
		expect(optionReads).toBe(0);
		expect(harness.load).not.toHaveBeenCalled();
	});

	it("loads after Models preflight and verifies both endpoint resolvers", async () => {
		const harness = createLazyHarness();
		const models = createNativeModels(harness);
		const result = await models.compact(model, { messages: [] });
		expect(result.providerContext.items).toHaveLength(1);
		expect(harness.publicResolver).toHaveBeenCalledTimes(1);
		expect(harness.load).toHaveBeenCalledTimes(1);
		expect(harness.moduleResolver).toHaveBeenCalledTimes(1);
		expect(harness.compact).toHaveBeenCalledTimes(1);
	});

	it("rejects unknown APIs at the public lazy endpoint resolver", () => {
		const harness = createLazyHarness();
		harness.publicResolver.mockImplementation(() => {
			throw new Error("RESOLVER_SECRET");
		});
		let caught: unknown;
		try {
			harness.lazy.resolveNativeCompactionEndpoint(
				{ ...model, api: "not-native" } as unknown as Model<"openai-responses">,
				{},
			);
		} catch (error) {
			caught = error;
		}
		expectNativeCode(caught, "protocol");
		expect((caught as Error).message).not.toContain("RESOLVER_SECRET");
		expect(harness.publicResolver).not.toHaveBeenCalled();
		expect(harness.load).not.toHaveBeenCalled();
	});

	it("prioritizes abort for branded requests without loading or resolving the module", async () => {
		const harness = createLazyHarness();
		const models = createNativeModels(harness);
		const controller = new AbortController();
		await models.compact(model, { messages: [] }, { signal: controller.signal });
		const request = harness.capturedRequests[0]!;
		controller.abort();
		harness.load.mockClear();
		harness.moduleResolver.mockClear();
		harness.compact.mockClear();
		await expect(harness.lazy.compact(request)).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(harness.load).not.toHaveBeenCalled();
		expect(harness.moduleResolver).not.toHaveBeenCalled();
		expect(harness.compact).not.toHaveBeenCalled();
	});

	it("rejects endpoint drift before invoking the underlying capability", async () => {
		const harness = createLazyHarness();
		harness.state.endpoint = "https://different.example.test/v1/responses";
		const models = createNativeModels(harness);
		await expect(models.compact(model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "binding_mismatch");
			return true;
		});
		expect(harness.compact).not.toHaveBeenCalled();
	});

	it("sanitizes loader failures and rejects non-module or incomplete values", async () => {
		for (const scenario of ["loader", "incomplete", "null", "undefined"] as const) {
			const harness = createLazyHarness();
			if (scenario === "loader") {
				harness.load.mockRejectedValue(new Error("LOADER_SECRET"));
			} else if (scenario === "null") {
				harness.load.mockResolvedValue(null);
			} else if (scenario === "undefined") {
				harness.load.mockResolvedValue(undefined);
			} else {
				harness.load.mockResolvedValue({ stream: harness.stream, streamSimple: harness.stream });
			}
			const models = createNativeModels(harness);
			await expect(models.compact(model, { messages: [] })).rejects.toSatisfy((error) => {
				expectNativeCode(error, scenario === "loader" ? "provider_error" : "unsupported");
				expect((error as Error).message).not.toContain("LOADER_SECRET");
				return true;
			});
			expect(harness.moduleResolver).not.toHaveBeenCalled();
			expect(harness.compact).not.toHaveBeenCalled();
		}
	});

	it("validates compact results and consumer booleans at the lazy boundary", async () => {
		const harness = createLazyHarness();
		const models = createNativeModels(harness);
		harness.state.compactResult = {};
		await expect(models.compact(model, { messages: [] })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
		delete harness.state.compactResult;
		const compacted = await models.compact(model, { messages: [] });
		harness.state.consumerResult = "yes";
		await expect(models.canConsumeProviderContext(model, compacted.providerContext)).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
	});
});

describe("compat provider context isolation", () => {
	afterEach(() => {
		resetApiProviders();
	});

	function registerCustomStream() {
		const dispatch = vi.fn((requestModel: Model<"openai-responses">) => doneStream(requestModel));
		registerApiProvider({
			api: "openai-responses",
			stream: dispatch,
			streamSimple: dispatch,
		});
		return dispatch;
	}

	it("blocks provider context in top-level custom compat dispatch", async () => {
		const dispatch = registerCustomStream();
		const result = await compatComplete(model, { messages: [], providerContext: {} } as unknown as Context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Native compaction is not supported.");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("blocks provider context when calling a registry provider directly", async () => {
		const dispatch = registerCustomStream();
		const provider = getApiProvider("openai-responses")!;
		const result = await provider.stream(model, { messages: [], providerContext: {} } as unknown as Context).result();
		expect(result.errorMessage).toBe("Native compaction is not supported.");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("routes builtin provider context through Models preflight", async () => {
		const builtin = getModel("anthropic", "claude-sonnet-4-6")!;
		const result = await compatStream(builtin, { messages: [], providerContext: {} } as unknown as Context).result();
		expect(result.errorMessage).toBe("Native compaction is not supported.");
	});

	it("does not execute a providerContext getter or leak its error", async () => {
		const dispatch = registerCustomStream();
		const context = { messages: [] } as Context;
		Object.defineProperty(context, "providerContext", {
			enumerable: true,
			get: () => {
				throw new Error("GETTER_SECRET");
			},
		});
		const result = await compatStream(model, context).result();
		expect(result.errorMessage).toBe("Native compaction is not supported.");
		expect(result.errorMessage).not.toContain("GETTER_SECRET");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("preserves ordinary compat dispatch for an own undefined providerContext", async () => {
		const dispatch = registerCustomStream();
		const context: Context = { messages: [], providerContext: undefined };
		const result = await compatComplete(model, context);
		expect(result.stopReason).toBe("stop");
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});
