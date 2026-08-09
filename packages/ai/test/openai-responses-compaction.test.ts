import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { stream as rawStream } from "../src/api/openai-responses.ts";
import { createModels, createProvider } from "../src/models.ts";
import type {
	Context,
	JsonValue,
	Model,
	NativeCompactionProviderRequest,
	NativeCompactionPublicOptionsMap,
} from "../src/types.ts";
import { NativeCompactionError } from "../src/utils/native-compaction.ts";

const authContext = {
	env: async (): Promise<string | undefined> => undefined,
	fileExists: async (): Promise<boolean> => false,
};

const model: Model<"openai-responses"> = {
	id: "gpt-public-compact-test",
	name: "GPT Public Compact Test",
	api: "openai-responses",
	provider: "public-compact-test",
	baseUrl: "https://api.example.test/v1/",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
};

const context: Context = {
	systemPrompt: "Keep the answer short.",
	messages: [{ role: "user", content: "new question", timestamp: 1 }],
};

interface CapturedRequest {
	readonly url: string;
	readonly body: Readonly<Record<string, unknown>>;
}

function compactResponse(output: readonly JsonValue[] = [{ type: "compaction", encrypted_content: "opaque-1" }]) {
	return {
		id: "resp_compact_1",
		created_at: 1,
		object: "response.compaction",
		output,
		usage: {
			input_tokens: 20,
			input_tokens_details: { cached_tokens: 3 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 2 },
			total_tokens: 25,
		},
	};
}

function completedSse(): string {
	return `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			status: "completed",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	})}\n\n`;
}

function createFetchHarness(responses: unknown[] = [compactResponse()]) {
	const captured: CapturedRequest[] = [];
	const queue = [...responses];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		const bodyText = await request.clone().text();
		const body = bodyText.length === 0 ? {} : (JSON.parse(bodyText) as Readonly<Record<string, unknown>>);
		captured.push({ url: request.url, body });
		if (request.url.endsWith("/responses/compact")) {
			return new Response(JSON.stringify(queue.shift()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(completedSse(), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { fetch, captured };
}

function createHarness(requestModel: Model<"openai-responses"> = model) {
	const provider = createProvider({
		id: requestModel.provider,
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		models: [requestModel],
		api: openAIResponsesApi(),
	});
	const models = createModels({ authContext });
	models.setProvider(provider);
	return models;
}

function expectNativeCode(error: unknown, code: NativeCompactionError["code"]): void {
	expect(error).toBeInstanceOf(NativeCompactionError);
	expect((error as NativeCompactionError).code).toBe(code);
}

describe("OpenAI Responses native compaction", () => {
	it("exposes the complete Public native capability with an API-narrowed request", () => {
		const lazy = openAIResponsesApi();
		type CompactRequest = Parameters<NonNullable<typeof lazy.compact>>[0];
		expectTypeOf<CompactRequest>().toEqualTypeOf<NativeCompactionProviderRequest<"openai-responses">>();
		expect(lazy.compact).toBeTypeOf("function");
		expect(lazy.canConsumeProviderContext).toBeTypeOf("function");
		expect(lazy.resolveNativeCompactionRoutes).toBeTypeOf("function");
	});

	it("keeps an own undefined providerContext on the ordinary stream path", async () => {
		const { fetch } = createFetchHarness();
		let payload: unknown;
		const message = await rawStream(
			model,
			{ ...context, providerContext: undefined },
			{
				apiKey: "test-key",
				fetch,
				onPayload: (value) => {
					payload = value;
				},
			},
		).result();
		expect(message.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(Object.hasOwn(payload as object, "instructions")).toBe(false);
	});

	it("sends the closed compact payload and returns a frozen canonical envelope", async () => {
		const { fetch, captured } = createFetchHarness();
		const onResponse = vi.fn();
		const result = await createHarness().compact(model, context, {
			fetch,
			sessionId: "session-1",
			onResponse,
		});

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://api.example.test/v1/responses/compact");
		expect(Object.keys(captured[0]?.body ?? {}).sort()).toEqual([
			"input",
			"instructions",
			"model",
			"prompt_cache_key",
		]);
		expect(captured[0]?.body).toMatchObject({
			model: model.id,
			instructions: context.systemPrompt,
			prompt_cache_key: "session-1",
			input: [{ role: "user", content: [{ type: "input_text", text: "new question" }] }],
		});
		expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
		expect(result.providerContext.binding).toMatchObject({
			provider: model.provider,
			api: model.api,
			model: model.id,
			endpoint: model.baseUrl,
			protocol: "openai-responses-compact",
		});
		expect(Object.isFrozen(result.providerContext.items)).toBe(true);
		expect(Object.isFrozen(result.providerContext.items[0])).toBe(true);
		expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: expect.any(Object) }, expect.any(Object));
	});

	it("prepends prior canonical items when compacting a second time", async () => {
		const retained = { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } as const;
		const first = compactResponse([retained, { type: "compaction", encrypted_content: "opaque-1" }]);
		const second = compactResponse([retained, { type: "compaction", encrypted_content: "opaque-2" }]);
		const { fetch, captured } = createFetchHarness([first, second]);
		const models = createHarness();
		const initial = await models.compact(model, context, { fetch });
		await models.compact(model, { ...context, providerContext: initial.providerContext }, { fetch });

		expect(captured).toHaveLength(2);
		expect(captured[1]?.body.input).toEqual([
			...initial.providerContext.items,
			{ role: "user", content: [{ type: "input_text", text: "new question" }] },
		]);
	});

	it("authorizes one Models replay and sends canonical items before new messages", async () => {
		const retained = { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } as const;
		const { fetch, captured } = createFetchHarness([
			compactResponse([retained, { type: "compaction", encrypted_content: "opaque" }]),
		]);
		const models = createHarness();
		const compacted = await models.compact(model, context, { fetch });
		const replay = await models.complete(
			model,
			{ ...context, providerContext: compacted.providerContext },
			{ fetch },
		);

		expect(replay.stopReason).toBe("stop");
		expect(captured).toHaveLength(2);
		expect(captured[1]?.url).toBe("https://api.example.test/v1/responses");
		expect(captured[1]?.body).toMatchObject({
			instructions: context.systemPrompt,
			input: [
				...compacted.providerContext.items,
				{ role: "user", content: [{ type: "input_text", text: "new question" }] },
			],
		});
	});

	it("prioritizes abort after replay fetch and after onResponse without consuming the body", async () => {
		const compactFetch = createFetchHarness();
		const compacted = await createHarness().compact(model, context, { fetch: compactFetch.fetch });

		const fetchAbortController = new AbortController();
		const fetchAbortResponse = new Response(completedSse(), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const fetchAbort = vi.fn(async () => {
			fetchAbortController.abort();
			return fetchAbortResponse;
		});
		const skippedResponseCallback = vi.fn();
		const fetchAborted = await createHarness().complete(
			model,
			{ ...context, providerContext: compacted.providerContext },
			{
				fetch: fetchAbort,
				signal: fetchAbortController.signal,
				onResponse: skippedResponseCallback,
			},
		);
		expect(fetchAborted.stopReason).toBe("aborted");
		expect(fetchAborted.errorMessage).toBe("Native compaction was aborted.");
		expect(skippedResponseCallback).not.toHaveBeenCalled();
		expect(fetchAbortResponse.bodyUsed).toBe(false);

		const responseAbortController = new AbortController();
		const responseAbortResponse = new Response(completedSse(), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const responseAbortFetch = vi.fn(async () => responseAbortResponse);
		const responseCallback = vi.fn(() => responseAbortController.abort());
		const responseAborted = await createHarness().complete(
			model,
			{ ...context, providerContext: compacted.providerContext },
			{
				fetch: responseAbortFetch,
				signal: responseAbortController.signal,
				onResponse: responseCallback,
			},
		);
		expect(responseAborted.stopReason).toBe("aborted");
		expect(responseAborted.errorMessage).toBe("Native compaction was aborted.");
		expect(responseCallback).toHaveBeenCalledTimes(1);
		expect(responseAbortResponse.bodyUsed).toBe(false);
	});

	it("rejects direct raw replay without a consumer handoff", async () => {
		const { fetch } = createFetchHarness();
		const result = await createHarness().compact(model, context, { fetch });
		fetch.mockClear();
		const message = await rawStream(
			model,
			{ ...context, providerContext: result.providerContext },
			{ apiKey: "test-key", fetch },
		).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Native compaction is not supported.");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects callback mutation of the canonical prefix before replay fetch", async () => {
		const { fetch } = createFetchHarness();
		const models = createHarness();
		const result = await models.compact(model, context, { fetch });
		fetch.mockClear();
		const message = await models.complete(
			model,
			{ ...context, providerContext: result.providerContext },
			{
				fetch,
				onPayload: (payload) => {
					const record = payload as { input: unknown[] };
					return { ...(payload as object), input: record.input.slice(1) };
				},
			},
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Native compaction protocol is incompatible.");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects callback mutation of the canonical prefix before a repeated compact fetch", async () => {
		const { fetch } = createFetchHarness();
		const models = createHarness();
		const result = await models.compact(model, context, { fetch });
		fetch.mockClear();
		await expect(
			models.compact(
				model,
				{ ...context, providerContext: result.providerContext },
				{
					fetch,
					onPayload: (payload) => {
						const record = payload as { input: unknown[] };
						return { ...(payload as object), input: record.input.slice(1) };
					},
				},
			),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects over-capacity compact and replay payloads before fetch", async () => {
		const smallModel = { ...model, contextWindow: 10, maxTokens: 9 };
		const { fetch } = createFetchHarness();
		await expect(createHarness(smallModel).compact(smallModel, context, { fetch })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "capacity");
			return true;
		});
		expect(fetch).not.toHaveBeenCalled();

		const normalFetch = createFetchHarness();
		const compacted = await createHarness().compact(model, context, { fetch: normalFetch.fetch });
		normalFetch.fetch.mockClear();
		const replay = await createHarness(smallModel).complete(
			smallModel,
			{ ...context, providerContext: compacted.providerContext },
			{ fetch: normalFetch.fetch },
		);
		expect(replay.stopReason).toBe("error");
		expect(replay.errorMessage).toBe("Native compaction input exceeds the supported capacity.");
		expect(normalFetch.fetch).not.toHaveBeenCalled();
	});

	it.each([
		["wrong object", { ...compactResponse(), object: "response" }],
		["missing compaction", compactResponse([{ type: "message", role: "user", content: [] }])],
		[
			"multiple compactions",
			compactResponse([
				{ type: "compaction", encrypted_content: "one" },
				{ type: "compaction", encrypted_content: "two" },
			]),
		],
		["unsafe usage", { ...compactResponse(), usage: { ...compactResponse().usage, total_tokens: -1 } }],
		[
			"unexpected usage detail",
			{
				...compactResponse(),
				usage: {
					...compactResponse().usage,
					input_tokens_details: { cached_tokens: 0, secret_tokens: 1 },
				},
			},
		],
	] as const)("rejects malformed provider response: %s", async (_name, response) => {
		const { fetch } = createFetchHarness([response]);
		await expect(createHarness().compact(model, context, { fetch })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["https://api.example.test/v1?", "https://api.example.test/v1?tenant=one"])(
		"rejects query-bearing base URL %s before provider fetch",
		async (baseUrl) => {
			const queryModel = { ...model, baseUrl };
			const { fetch } = createFetchHarness();
			await expect(createHarness(queryModel).compact(queryModel, context, { fetch })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "protocol");
				return true;
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("validates callback payloads and prioritizes abort without provider fetch", async () => {
		const { fetch } = createFetchHarness();
		await expect(
			createHarness().compact(model, context, {
				fetch,
				onPayload: () => ({ model: model.id, input: [], previous_response_id: "forbidden" }),
			}),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
		expect(fetch).not.toHaveBeenCalled();

		const controller = new AbortController();
		const options: NativeCompactionPublicOptionsMap["openai-responses"] = {
			fetch,
			signal: controller.signal,
			onPayload: () => {
				controller.abort();
			},
		};
		await expect(createHarness().compact(model, context, options)).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not expose provider error bodies or callback exceptions", async () => {
		const providerFetch = vi.fn(
			async () => new Response("PROVIDER_SECRET", { status: 500, headers: { "content-type": "text/plain" } }),
		);
		await expect(createHarness().compact(model, context, { fetch: providerFetch })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "provider_error");
			expect((error as Error).message).not.toContain("PROVIDER_SECRET");
			return true;
		});

		await expect(
			createHarness().compact(model, context, {
				fetch: providerFetch,
				onPayload: () => {
					throw new Error("CALLBACK_SECRET");
				},
			}),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "provider_error");
			expect((error as Error).message).not.toContain("CALLBACK_SECRET");
			return true;
		});

		const normalFetch = createFetchHarness();
		const compacted = await createHarness().compact(model, context, { fetch: normalFetch.fetch });
		const replayFetch = vi.fn(
			async () => new Response("REPLAY_SECRET", { status: 500, headers: { "content-type": "text/plain" } }),
		);
		const replay = await createHarness().complete(
			model,
			{ ...context, providerContext: compacted.providerContext },
			{ fetch: replayFetch },
		);
		expect(replay.stopReason).toBe("error");
		expect(replay.errorMessage).toBe("Native compaction provider request failed.");
		expect(replay.errorMessage).not.toContain("REPLAY_SECRET");
	});

	it("keeps failed envelopes immutable from later provider response mutation", async () => {
		const providerOutput: JsonValue[] = [{ type: "compaction", encrypted_content: "before" }];
		const { fetch } = createFetchHarness([compactResponse(providerOutput)]);
		const result = await createHarness().compact(model, context, { fetch });
		(providerOutput[0] as { encrypted_content: string }).encrypted_content = "after";
		expect((result.providerContext.items[0] as { encrypted_content: string }).encrypted_content).toBe("before");
	});
});
