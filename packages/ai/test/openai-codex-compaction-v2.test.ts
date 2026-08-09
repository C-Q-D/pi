import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { openAICodexResponsesApi } from "../src/api/openai-codex-responses.lazy.ts";
import { getOpenAICodexWebSocketDebugStats, stream as rawStream } from "../src/api/openai-codex-responses.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { AssistantMessage, Context, JsonValue, Model, NativeCompactionProviderRequest } from "../src/types.ts";
import { NativeCompactionError } from "../src/utils/native-compaction.ts";

const authContext = {
	env: async (): Promise<string | undefined> => undefined,
	fileExists: async (): Promise<boolean> => false,
};

const model: Model<"openai-codex-responses"> = {
	id: "gpt-codex-compact-test",
	name: "GPT Codex Compact Test",
	api: "openai-codex-responses",
	provider: "codex-compact-test",
	baseUrl: "https://chatgpt.example.test/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

const context: Context = {
	systemPrompt: "Keep the answer short.",
	messages: [{ role: "user", content: "new question", timestamp: 1 }],
};

interface CapturedRequest {
	readonly url: string;
	readonly headers: Headers;
	readonly body: Readonly<Record<string, unknown>>;
	readonly rawBody: Uint8Array;
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

function decodeRequestBody(body: RequestInit["body"] | ArrayBuffer | undefined): Readonly<Record<string, unknown>> {
	if (typeof body === "string") return JSON.parse(body) as Readonly<Record<string, unknown>>;
	if (body instanceof ArrayBuffer) {
		return JSON.parse(Buffer.from(zstdDecompressSync(new Uint8Array(body))).toString("utf8")) as Readonly<
			Record<string, unknown>
		>;
	}
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Readonly<Record<string, unknown>>;
	}
	throw new Error("Missing Codex request body");
}

function requestBodyBytes(body: RequestInit["body"] | ArrayBuffer | undefined): Uint8Array {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body).slice();
	if (body instanceof Uint8Array) return body.slice();
	throw new Error("Missing Codex request body");
}

function sse(events: readonly unknown[]): string {
	return `${events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function compactSse(encryptedContent: string = "opaque-1", extraItems: readonly unknown[] = []): string {
	return sse([
		...extraItems,
		{
			type: "response.output_item.done",
			item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent },
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 20,
					output_tokens: 5,
					total_tokens: 25,
					input_tokens_details: { cached_tokens: 3 },
					output_tokens_details: { reasoning_tokens: 2 },
				},
			},
		},
	]);
}

function ordinarySse(): string {
	return sse([
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}

function response(body: string, status: number = 200, headers: Readonly<Record<string, string>> = {}): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/event-stream",
			"retry-after-ms": "0",
			...Object.fromEntries(new Headers(headers)),
		},
	});
}

function createFetchHarness(responses: readonly (() => Response)[]) {
	const captured: CapturedRequest[] = [];
	const queue = [...responses];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
		const requestBody = input instanceof Request ? await input.arrayBuffer() : init?.body;
		captured.push({
			url,
			headers,
			body: decodeRequestBody(requestBody),
			rawBody: requestBodyBytes(requestBody),
		});
		const next = queue.shift();
		if (!next) throw new Error("Unexpected extra provider request");
		return next();
	});
	return { fetch, captured };
}

async function createHarness(options?: {
	readonly requestModel?: Model<"openai-codex-responses">;
	readonly tokenAccountId?: string;
	readonly storedAccountId?: string;
}) {
	const requestModel = options?.requestModel ?? model;
	const tokenAccountId = options?.tokenAccountId ?? "account-a";
	const token = createAccessToken(tokenAccountId);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(requestModel.provider, async () => ({
		type: "oauth",
		access: token,
		refresh: "refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
		accountId: options?.storedAccountId ?? tokenAccountId,
	}));
	const provider = createProvider({
		id: requestModel.provider,
		auth: { oauth: openaiCodexOAuth },
		models: [requestModel],
		api: openAICodexResponsesApi(),
	});
	const models = createModels({ authContext, credentials });
	models.setProvider(provider);
	return { models, token };
}

function expectNativeCode(error: unknown, code: NativeCompactionError["code"]): void {
	expect(error).toBeInstanceOf(NativeCompactionError);
	expect((error as NativeCompactionError).code).toBe(code);
}

describe("OpenAI Codex Remote Compaction V2", () => {
	it("exposes the complete API-narrowed native capability", () => {
		const lazy = openAICodexResponsesApi();
		type CompactRequest = Parameters<NonNullable<typeof lazy.compact>>[0];
		expectTypeOf<CompactRequest>().toEqualTypeOf<NativeCompactionProviderRequest<"openai-codex-responses">>();
		expect(lazy.compact).toBeTypeOf("function");
		expect(lazy.canConsumeProviderContext).toBeTypeOf("function");
		expect(lazy.resolveNativeCompactionEndpoint).toBeTypeOf("function");
	});

	it("sends the exact V2 request and accepts unrelated output items", async () => {
		const extraItem = {
			type: "response.output_item.done",
			item: { type: "message", role: "assistant", content: [] },
		};
		const { fetch, captured } = createFetchHarness([() => response(compactSse("opaque-1", [extraItem]))]);
		const { models, token } = await createHarness();
		const onResponse = vi.fn();
		let callbackPayload: unknown;
		const result = await models.compact(
			model,
			{
				...context,
				tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({ query: Type.String() }) }],
			},
			{
				fetch,
				sessionId: "session-1",
				headers: { "x-codex-beta-features": "other, remote_compaction_v2, other" },
				onPayload: (payload) => {
					callbackPayload = payload;
				},
				onResponse,
			},
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://chatgpt.example.test/backend-api/codex/responses");
		expect(captured[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(captured[0]?.headers.get("chatgpt-account-id")).toBe("account-a");
		expect(captured[0]?.headers.get("originator")).toBe("pi");
		expect(captured[0]?.headers.get("session-id")).toBe("session-1");
		expect(captured[0]?.headers.get("x-client-request-id")).toBe("session-1");
		expect(captured[0]?.headers.get("x-codex-beta-features")).toBe("other,remote_compaction_v2");
		expect(captured[0]?.headers.get("content-encoding")).toBe("zstd");
		expect(captured[0]?.body).toMatchObject({
			model: model.id,
			store: false,
			stream: true,
			instructions: context.systemPrompt,
			prompt_cache_key: "session-1",
		});
		const input = captured[0]?.body.input as readonly JsonValue[];
		expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
		expect(input.filter((item) => (item as { type?: string }).type === "compaction_trigger")).toHaveLength(1);
		expect(JSON.stringify(captured[0]?.body.tools)).not.toContain("~kind");
		const callbackTools = (callbackPayload as { tools: readonly [{ parameters: object }] }).tools;
		const callbackParameters = callbackTools[0].parameters;
		expect(Object.getPrototypeOf(callbackParameters)).toBe(Object.prototype);
		expect(Reflect.ownKeys(callbackParameters)).toEqual(Object.keys(callbackParameters));
		expect(Object.values(Object.getOwnPropertyDescriptors(callbackParameters)).every((item) => "value" in item)).toBe(
			true,
		);
		expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
		expect(result.providerContext.items).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new question" }] },
			{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-1" },
		]);
		expect(result.providerContext.binding).toMatchObject({
			provider: model.provider,
			api: model.api,
			model: model.id,
			endpoint: "https://chatgpt.example.test/backend-api/codex/responses",
			protocol: "openai-codex-remote-v2",
		});
		expect(onResponse).toHaveBeenCalledTimes(1);
	});

	it("prepends prior canonical items when compacting repeatedly", async () => {
		const { fetch, captured } = createFetchHarness([
			() => response(compactSse("opaque-1")),
			() => response(compactSse("opaque-2")),
		]);
		const { models } = await createHarness();
		const first = await models.compact(model, context, { fetch });
		const second = await models.compact(model, { ...context, providerContext: first.providerContext }, { fetch });
		const secondInput = captured[1]?.body.input as readonly JsonValue[];
		expect(secondInput.slice(0, first.providerContext.items.length)).toEqual(first.providerContext.items);
		expect(secondInput.at(-1)).toEqual({ type: "compaction_trigger" });
		expect(second.providerContext.items.filter((item) => (item as { type?: string }).type === "compaction")).toEqual([
			{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-2" },
		]);
	});

	it("replays the full canonical context over SSE without Trigger or cache continuation", async () => {
		const { fetch, captured } = createFetchHarness([() => response(compactSse()), () => response(ordinarySse())]);
		const { models } = await createHarness();
		const compacted = await models.compact(model, context, { fetch });
		const webSocketUrls: string[] = [];
		class ForbiddenWebSocket {
			constructor(url: string) {
				webSocketUrls.push(url);
				throw new Error("Replay must not construct WebSocket");
			}
		}
		vi.stubGlobal("WebSocket", ForbiddenWebSocket);
		let replay: AssistantMessage;
		try {
			replay = await models.complete(
				model,
				{ ...context, providerContext: compacted.providerContext },
				{ fetch, transport: "websocket", sessionId: "session-1" },
			);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(replay.stopReason).toBe("stop");
		expect(webSocketUrls).toEqual([]);
		expect(getOpenAICodexWebSocketDebugStats("session-1")).toBeUndefined();
		expect(captured).toHaveLength(2);
		const replayBody = captured[1]?.body;
		expect(replayBody).not.toHaveProperty("previous_response_id");
		expect(JSON.stringify(replayBody)).not.toContain("compaction_trigger");
		expect(replayBody.input).toEqual([
			...compacted.providerContext.items,
			{ role: "user", content: [{ type: "input_text", text: "new question" }] },
		]);
	});

	it("rejects raw replay and callback mutation before provider fetch", async () => {
		const compactFetch = createFetchHarness([() => response(compactSse())]);
		const { models, token } = await createHarness();
		const compacted = await models.compact(model, context, { fetch: compactFetch.fetch });
		const rawFetch = vi.fn();
		const rawResult = await rawStream(
			model,
			{ ...context, providerContext: compacted.providerContext },
			{ apiKey: token, fetch: rawFetch },
		).result();
		expect(rawResult.stopReason).toBe("error");
		expect(rawResult.errorMessage).toBe("Native compaction is not supported.");
		expect(rawFetch).not.toHaveBeenCalled();

		for (const onPayload of [
			(payload: unknown) => ({ ...(payload as object), extra: "forbidden" }),
			(payload: unknown) => {
				const body = payload as { input: unknown[] };
				return { ...(payload as object), input: body.input.slice(0, -1) };
			},
		]) {
			const fetch = vi.fn();
			await expect(models.compact(model, context, { fetch, onPayload })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "protocol");
				return true;
			});
			expect(fetch).not.toHaveBeenCalled();
		}
	});

	it("rejects canonical prefix mutation in compact and replay before provider fetch", async () => {
		const initial = createFetchHarness([() => response(compactSse())]);
		const { models } = await createHarness();
		const compacted = await models.compact(model, context, { fetch: initial.fetch });
		const compactFetch = vi.fn();
		await expect(
			models.compact(
				model,
				{ ...context, providerContext: compacted.providerContext },
				{
					fetch: compactFetch,
					onPayload: (payload) => {
						const body = payload as { input: readonly JsonValue[] };
						return {
							...(payload as object),
							input: [{ type: "message", role: "user", content: [] }, ...body.input.slice(1)],
						};
					},
				},
			),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "protocol");
			return true;
		});
		expect(compactFetch).not.toHaveBeenCalled();

		const replayFetch = vi.fn();
		const replay = await models.complete(
			model,
			{ ...context, providerContext: compacted.providerContext },
			{
				fetch: replayFetch,
				onPayload: (payload) => {
					const body = payload as { input: readonly JsonValue[] };
					return { ...(payload as object), input: body.input.slice(1) };
				},
			},
		);
		expect(replay.stopReason).toBe("error");
		expect(replay.errorMessage).toBe("Native compaction protocol is incompatible.");
		expect(replayFetch).not.toHaveBeenCalled();
	});

	it("rejects non-plain callback payloads before provider fetch", async () => {
		const { models } = await createHarness();
		const callbacks: readonly ((payload: unknown) => unknown)[] = [
			(payload) => {
				const next = { ...(payload as object) };
				Object.defineProperty(next, "model", { enumerable: true, get: () => model.id });
				return next;
			},
			(payload) => {
				const next = { ...(payload as object) };
				Object.defineProperty(next, "hidden", { enumerable: false, value: true });
				return next;
			},
			(payload) => Object.assign(Object.create({ inherited: true }), payload as object),
			(payload) =>
				new Proxy(payload as object, {
					ownKeys() {
						throw new Error("CALLBACK_SECRET");
					},
				}),
			(payload) => {
				const next = { ...(payload as object) } as Record<string, unknown>;
				next.cycle = next;
				return next;
			},
		];
		for (const onPayload of callbacks) {
			const fetch = vi.fn();
			await expect(models.compact(model, context, { fetch, onPayload })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "protocol");
				expect((error as Error).message).not.toContain("CALLBACK_SECRET");
				return true;
			});
			expect(fetch).not.toHaveBeenCalled();
		}
	});

	it("retries only structured transient SSE failures and runs onPayload once", async () => {
		const failed = sse([
			{
				type: "response.failed",
				response: { status: "failed", error: { code: "server_error", message: "PROVIDER_SECRET" } },
			},
		]);
		const { fetch } = createFetchHarness([
			() => response(failed),
			() => response(failed),
			() => response(compactSse()),
		]);
		const { models } = await createHarness();
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		await models.compact(model, context, { fetch, onPayload, onResponse });
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(3);
	});

	it.each(["server_error", "internal_server_error", "rate_limit_exceeded"])(
		"retries the structured SSE code %s even when the response disables generic retries",
		async (code) => {
			const failed = sse([{ type: "response.failed", response: { error: { code, message: "SECRET" } } }]);
			const { fetch, captured } = createFetchHarness([
				() => response(failed, 200, { "x-should-retry": "false" }),
				() => response(compactSse()),
			]);
			const { models } = await createHarness();
			const onPayload = vi.fn();
			const onResponse = vi.fn();
			await models.compact(model, context, { fetch, maxRetries: 1, onPayload, onResponse });
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(onResponse).toHaveBeenCalledTimes(2);
			expect(captured[0]?.rawBody).toEqual(captured[1]?.rawBody);
		},
	);

	it("isolates retry headers and body bytes from custom fetch mutation", async () => {
		const bodies: Uint8Array[] = [];
		const features: string[] = [];
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (!(init?.body instanceof Uint8Array)) throw new Error("Expected zstd request bytes");
			if (!(init.headers instanceof Headers)) throw new Error("Expected isolated request headers");
			bodies.push(init.body.slice());
			features.push(init.headers.get("x-codex-beta-features") ?? "");
			init.body.fill(0);
			init.headers.delete("x-codex-beta-features");
			return fetch.mock.calls.length === 1
				? response(sse([{ type: "response.failed", response: { error: { code: "server_error" } } }]), 200, {
						"x-should-retry": "false",
					})
				: response(compactSse());
		});
		const { models } = await createHarness();
		const onPayload = vi.fn();
		await models.compact(model, context, { fetch, maxRetries: 1, onPayload });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(bodies[0]).toEqual(bodies[1]);
		expect(features).toEqual(["remote_compaction_v2", "remote_compaction_v2"]);
	});

	it.each([429, 500, 502, 503, 504])(
		"retries the fixed HTTP status %s without x-should-retry overriding the classification",
		async (status) => {
			const { fetch, captured } = createFetchHarness([
				() => response("temporary", status, { "x-should-retry": "false" }),
				() => response(compactSse()),
			]);
			const { models } = await createHarness();
			const onPayload = vi.fn();
			const onResponse = vi.fn();
			await models.compact(model, context, { fetch, maxRetries: 1, onPayload, onResponse });
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(onResponse).toHaveBeenCalledTimes(2);
			expect(captured[0]?.rawBody).toEqual(captured[1]?.rawBody);
		},
	);

	it.each([
		[429, "insufficient_quota: usage limit", "true"],
		[408, "request timeout", "true"],
	] as const)("does not retry terminal or non-whitelisted HTTP %s", async (status, body, shouldRetry) => {
		const { fetch } = createFetchHarness([() => response(body, status, { "x-should-retry": shouldRetry })]);
		const { models } = await createHarness();
		await expect(models.compact(model, context, { fetch, maxRetries: 2 })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "provider_error");
			return true;
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"fetch rejection",
			() => {
				throw new Error("FETCH_SECRET");
			},
			1,
		],
		[
			"body reader rejection",
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(new Error("READER_SECRET"));
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream", "retry-after-ms": "0" } },
				),
			2,
		],
		[
			"response.incomplete",
			() => response(sse([{ type: "response.incomplete", response: { status: "incomplete" } }])),
			2,
		],
		[
			"early close",
			() =>
				response(
					sse([{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "partial" } }]),
				),
			2,
		],
	] as const)("retries %s and reuses identical request bytes", async (_name, firstResponse, responseCallbacks) => {
		const { fetch, captured } = createFetchHarness([firstResponse, () => response(compactSse())]);
		const { models } = await createHarness();
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		await models.compact(model, context, { fetch, maxRetries: 1, onPayload, onResponse });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(responseCallbacks);
		expect(captured[0]?.rawBody).toEqual(captured[1]?.rawBody);
	});

	it.each([
		["context capacity", "context_length_exceeded", "capacity"],
		["unknown provider code", "unexpected_failure", "provider_error"],
	] as const)("does not retry %s", async (_name, code, expectedCode) => {
		const failed = sse([{ type: "response.failed", response: { error: { code, message: "SECRET" } } }]);
		const { fetch } = createFetchHarness([() => response(failed)]);
		const { models } = await createHarness();
		await expect(models.compact(model, context, { fetch, maxRetries: 2 })).rejects.toSatisfy((error) => {
			expectNativeCode(error, expectedCode);
			return true;
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("classifies retryable top-level SSE error events", async () => {
		const failed = sse([{ type: "error", code: "server_error", message: "SECRET" }]);
		const { fetch } = createFetchHarness([() => response(failed), () => response(compactSse())]);
		const { models } = await createHarness();
		await models.compact(model, context, { fetch, maxRetries: 1 });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		["context_length_exceeded", "capacity"],
		["unexpected_failure", "provider_error"],
	] as const)("does not retry top-level SSE error code %s", async (code, expectedCode) => {
		const failed = sse([{ type: "error", code, message: "SECRET" }]);
		const { fetch } = createFetchHarness([() => response(failed)]);
		const { models } = await createHarness();
		await expect(models.compact(model, context, { fetch, maxRetries: 2 })).rejects.toSatisfy((error) => {
			expectNativeCode(error, expectedCode);
			return true;
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("allows callers to lower retries but clamps increases to two retries", async () => {
		const failed = sse([{ type: "response.failed", response: { error: { code: "server_error" } } }]);
		const disabled = createFetchHarness([() => response(failed)]);
		const { models } = await createHarness();
		await expect(models.compact(model, context, { fetch: disabled.fetch, maxRetries: 0 })).rejects.toBeInstanceOf(
			NativeCompactionError,
		);
		expect(disabled.fetch).toHaveBeenCalledTimes(1);

		const clamped = createFetchHarness([() => response(failed), () => response(failed), () => response(failed)]);
		await expect(models.compact(model, context, { fetch: clamped.fetch, maxRetries: 99 })).rejects.toBeInstanceOf(
			NativeCompactionError,
		);
		expect(clamped.fetch).toHaveBeenCalledTimes(3);
	});

	it.each([
		["missing compaction", sse([{ type: "response.completed", response: { status: "completed" } }]), "protocol"],
		[
			"multiple compactions",
			sse([
				{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "one" } },
				{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "two" } },
			]),
			"protocol",
		],
		[
			"empty compaction",
			sse([{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "" } }]),
			"protocol",
		],
		["invalid JSON", "data: {invalid-json}\n\n", "protocol"],
		[
			"terminal provider failure",
			sse([{ type: "response.failed", response: { error: { code: "insufficient_quota", message: "SECRET" } } }]),
			"provider_error",
		],
	] as const)("rejects %s without a partial result", async (_name, body, code) => {
		const { fetch } = createFetchHarness([() => response(body)]);
		const { models } = await createHarness();
		await expect(models.compact(model, context, { fetch, maxRetries: 0 })).rejects.toSatisfy((error) => {
			expectNativeCode(error, code);
			expect((error as Error).message).not.toContain("SECRET");
			return true;
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("prioritizes abort after fetch and after onResponse without consuming the body", async () => {
		const { models } = await createHarness();
		const fetchController = new AbortController();
		const fetchResponse = response(compactSse());
		const fetch = vi.fn(async () => {
			fetchController.abort();
			return fetchResponse;
		});
		const skippedOnResponse = vi.fn();
		await expect(
			models.compact(model, context, { fetch, signal: fetchController.signal, onResponse: skippedOnResponse }),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(skippedOnResponse).not.toHaveBeenCalled();
		expect(fetchResponse.bodyUsed).toBe(false);

		const responseController = new AbortController();
		const callbackResponse = response(compactSse());
		const onResponse = vi.fn(() => responseController.abort());
		await expect(
			models.compact(model, context, {
				fetch: async () => callbackResponse,
				signal: responseController.signal,
				onResponse,
			}),
		).rejects.toSatisfy((error) => {
			expectNativeCode(error, "aborted");
			return true;
		});
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(callbackResponse.bodyUsed).toBe(false);
	});

	it("checks abort immediately after every SSE reader read", async () => {
		const controller = new AbortController();
		let reads = 0;
		let cancels = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(streamController) {
					reads += 1;
					streamController.enqueue(new TextEncoder().encode(compactSse()));
					controller.abort();
				},
				cancel() {
					cancels += 1;
				},
			},
			{ highWaterMark: 0 },
		);
		const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
		const onResponse = vi.fn();
		const { models } = await createHarness();
		await expect(models.compact(model, context, { fetch, signal: controller.signal, onResponse })).rejects.toSatisfy(
			(error) => {
				expectNativeCode(error, "aborted");
				return true;
			},
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(reads).toBe(1);
		expect(cancels).toBeGreaterThanOrEqual(1);
	});

	it("uses the exact UTF-8 middle truncation algorithm and preserves images", async () => {
		const newest = "n".repeat(63_998 * 4);
		const { fetch } = createFetchHarness([() => response(compactSse())]);
		const { models } = await createHarness();
		const result = await models.compact(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "甲乙😀丙丁" },
							{ type: "image", data: "AA==", mimeType: "image/png" },
						],
						timestamp: 1,
					},
					{ role: "user", content: newest, timestamp: 2 },
				],
			},
			{ fetch },
		);
		const retained = result.providerContext.items;
		expect(retained[0]).toMatchObject({
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "甲…2 tokens truncated…丁" },
				{ type: "input_image", image_url: "data:image/png;base64,AA==" },
			],
		});
		expect(retained[1]).toMatchObject({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: newest }],
		});
		expect(retained.at(-1)).toMatchObject({ type: "compaction", encrypted_content: "opaque-1" });
	});

	it("uses an odd retention budget and excludes non-user and old compaction artifacts", async () => {
		const newest = "n".repeat(63_997 * 4);
		const oldAudio = { type: "input_audio", input_audio: { data: "AQI=", format: "wav" } };
		const oldImage = { type: "input_image", image_url: "data:image/png;base64,AA==" };
		const { fetch } = createFetchHarness([() => response(compactSse("new-compaction"))]);
		const { models } = await createHarness();
		const result = await models.compact(model, context, {
			fetch,
			onPayload: (payload) => ({
				...(payload as object),
				input: [
					{ type: "message", role: "developer", content: [{ type: "input_text", text: "developer" }] },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant" }] },
					{ type: "function_call_output", call_id: "call-1", output: "tool" },
					{ type: "compaction", encrypted_content: "old-compaction" },
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: "甲乙😀丙丁" },
							oldAudio,
							{ type: "input_text", text: "must-be-dropped" },
							oldImage,
						],
					},
					{ type: "message", role: "user", content: [{ type: "input_text", text: newest }] },
					{ type: "compaction_trigger" },
				],
			}),
		});
		expect(result.providerContext.items).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "甲乙…1 tokens truncated…丙丁" }, oldAudio, oldImage],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: newest }] },
			{ type: "compaction", id: "cmp_1", encrypted_content: "new-compaction" },
		]);
		expect(JSON.stringify(result.providerContext.items)).not.toContain("old-compaction");
		expect(JSON.stringify(result.providerContext.items)).not.toContain("must-be-dropped");
	});

	it("rejects account mismatch and every query or fragment marker before provider fetch", async () => {
		const fetch = vi.fn();
		const mismatched = await createHarness({ tokenAccountId: "account-b", storedAccountId: "account-a" });
		await expect(mismatched.models.compact(model, context, { fetch })).rejects.toSatisfy((error) => {
			expectNativeCode(error, "unsupported");
			return true;
		});
		expect(fetch).not.toHaveBeenCalled();

		for (const [suffix, provider] of [
			["?tenant=one", "codex-query-test"],
			["?", "codex-empty-query-test"],
			["#", "codex-empty-fragment-test"],
		] as const) {
			const invalidModel = { ...model, provider, baseUrl: `${model.baseUrl}${suffix}` };
			const invalidHarness = await createHarness({ requestModel: invalidModel });
			await expect(invalidHarness.models.compact(invalidModel, context, { fetch })).rejects.toSatisfy((error) => {
				expectNativeCode(error, "protocol");
				return true;
			});
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});
