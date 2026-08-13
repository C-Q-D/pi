import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	NativeCompactionError,
	type ProviderContextEnvelope,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	Agent,
	type AgentContext,
	type AgentLoopConfig,
	type AgentLoopTurnUpdate,
	type AgentMessage,
	type AgentTool,
	agentLoop,
	agentLoopContinue,
	declareStreamFnHandlesProviderContext,
	type StreamFn,
} from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

class DeferredResultAssistantStream extends MockAssistantStream {
	private readonly finalMessage: AssistantMessage;
	private readonly resultGate: Promise<void>;
	private readonly onResult: () => void;

	constructor(finalMessage: AssistantMessage, resultGate: Promise<void>, onResult: () => void) {
		super();
		this.finalMessage = finalMessage;
		this.resultGate = resultGate;
		this.onResult = onResult;
	}

	override async result(): Promise<AssistantMessage> {
		this.onResult();
		await this.resultGate;
		return this.finalMessage;
	}
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function model(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function providerContext(model = "mock", encryptedContent = "opaque"): ProviderContextEnvelope {
	return {
		format: "openai-responses-compaction",
		version: 1,
		binding: {
			provider: "openai",
			api: "openai-responses",
			model,
			endpoint: "https://api.example.test/v1/responses/compact",
			format: "openai-responses-compaction",
			protocol: "openai-responses-compact",
			credentialScopeHash: "a".repeat(64),
		},
		items: [{ type: "compaction", encrypted_content: encryptedContent }],
	};
}

function completedStream(message = assistantMessage([{ type: "text", text: "done" }])): MockAssistantStream {
	const stream = new MockAssistantStream();
	const reason = message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop";
	queueMicrotask(() => stream.push({ type: "done", reason, message }));
	return stream;
}

function declaredStream(streamFn: StreamFn): StreamFn {
	return declareStreamFnHandlesProviderContext(streamFn);
}

describe("Agent provider context", () => {
	it("deep-copies provider context and clears it on transcript replacement or reset", async () => {
		const input = providerContext();
		const streamFn = declaredStream(() => completedStream());
		const agent = new Agent({ streamFn });
		agent.replaceContext({
			messages: [{ role: "user", content: "before", timestamp: 1 }],
			providerContext: input,
		});

		(input.items[0] as { encrypted_content: string }).encrypted_content = "mutated-input";
		const firstRead = agent.state.providerContext!;
		const secondRead = agent.state.providerContext!;
		expect(firstRead.items[0]).toMatchObject({ encrypted_content: "opaque" });
		expect(firstRead).not.toBe(secondRead);
		expect(Object.isFrozen(firstRead)).toBe(true);
		expect(Object.isFrozen(firstRead.binding)).toBe(true);
		expect(Object.isFrozen(firstRead.items)).toBe(true);

		await agent.prompt("append normally");
		expect(agent.state.providerContext).toBeDefined();
		const exposedMessages = agent.state.messages;
		exposedMessages.push({ role: "user", content: "external mutation", timestamp: 2 });
		exposedMessages.splice(0, exposedMessages.length);
		expect(
			agent.state.messages.some((message) => message.role === "user" && message.content === "external mutation"),
		).toBe(false);
		expect(agent.state.providerContext).toBeDefined();

		agent.state.messages = [{ role: "user", content: "replacement", timestamp: 3 }];
		expect(agent.state.providerContext).toBeUndefined();
		agent.state.providerContext = providerContext();
		agent.reset();
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.providerContext).toBeUndefined();
	});

	it("replaces messages and provider context atomically and rejects invalid envelopes", () => {
		const agent = new Agent({ streamFn: () => completedStream() });
		agent.replaceContext({
			messages: [{ role: "user", content: "stable", timestamp: 1 }],
			providerContext: providerContext("stable"),
		});
		const previousContext = agent.state.providerContext;
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		for (const invalid of [
			null,
			false,
			0,
			"",
			{ ...providerContext(), items: [cyclic] },
			Object.defineProperty({}, "format", {
				enumerable: true,
				get() {
					throw new Error("UNSAFE_ACCESSOR");
				},
			}),
		]) {
			expect(() =>
				agent.replaceContext({
					messages: [{ role: "user", content: "must-not-commit", timestamp: 2 }],
					providerContext: invalid as ProviderContextEnvelope,
				}),
			).toThrow(NativeCompactionError);
			expect(agent.state.messages).toMatchObject([{ content: "stable" }]);
			expect(agent.state.providerContext).toEqual(previousContext);
		}

		const nextMessages = [{ role: "user" as const, content: "next", timestamp: 3 }];
		const nextContext = providerContext("next", "next-opaque");
		agent.replaceContext({ messages: nextMessages, providerContext: nextContext });
		nextMessages.push({ role: "user", content: "mutated-array", timestamp: 4 });
		(nextContext.items[0] as { encrypted_content: string }).encrypted_content = "mutated";
		expect(agent.state.messages).toMatchObject([{ content: "next" }]);
		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.providerContext?.items[0]).toMatchObject({ encrypted_content: "next-opaque" });
	});

	it("rejects invalid primitive provider contexts at constructor and state-setter boundaries", () => {
		expect(
			() =>
				new Agent({
					streamFn: () => completedStream(),
					initialState: { providerContext: null as never },
				}),
		).toThrowError(new NativeCompactionError("invalid_context"));

		const agent = new Agent({ streamFn: () => completedStream() });
		agent.state.providerContext = providerContext("stable");
		for (const invalid of [false, 0, ""]) {
			expect(() => {
				agent.state.providerContext = invalid as never;
			}).toThrowError(new NativeCompactionError("invalid_context"));
			expect(agent.state.providerContext?.binding.model).toBe("stable");
		}
	});

	it("rejects undeclared stream functions before transforms, credential reads, or dispatch", async () => {
		const transformContext = vi.fn(async (messages) => messages);
		const convertToLlm = vi.fn(async (messages) => messages as never);
		const getApiKey = vi.fn(async () => "unused");
		const streamFn = vi.fn(() => completedStream());
		const agent = new Agent({ streamFn, transformContext, convertToLlm, getApiKey });
		agent.replaceContext({ messages: [], providerContext: providerContext() });

		await agent.prompt("blocked");

		expect(transformContext).not.toHaveBeenCalled();
		expect(convertToLlm).not.toHaveBeenCalled();
		expect(getApiKey).not.toHaveBeenCalled();
		expect(streamFn).not.toHaveBeenCalled();
		expect(agent.state.errorMessage).toBe("Native compaction is not supported.");
	});

	it("forwards one frozen snapshot only to the exact declared stream function", async () => {
		const contexts: ProviderContextEnvelope[] = [];
		const base = declaredStream(
			vi.fn((_model, context) => {
				contexts.push(context.providerContext!);
				return completedStream();
			}),
		);
		const agent = new Agent({ streamFn: base });
		agent.replaceContext({ messages: [], providerContext: providerContext() });
		await agent.prompt("allowed");
		expect(base).toHaveBeenCalledTimes(1);
		expect(contexts).toHaveLength(1);
		expect(Object.isFrozen(contexts[0])).toBe(true);
		expect(Object.isFrozen(contexts[0]!.items)).toBe(true);

		const wrapper = vi.fn<StreamFn>((model, context, options) => base(model, context, options));
		const wrappedAgent = new Agent({ streamFn: wrapper });
		wrappedAgent.replaceContext({ messages: [], providerContext: providerContext() });
		await wrappedAgent.prompt("blocked wrapper");
		expect(wrapper).not.toHaveBeenCalled();
	});

	it("continues directly from an opaque provider context without synthesizing a user message", async () => {
		const seenMessageCounts: number[] = [];
		const seenConvertedCounts: number[] = [];
		const convertToLlm = vi.fn((messages: AgentMessage[]) => {
			seenConvertedCounts.push(messages.length);
			return identityConverter(messages);
		});
		const streamFn = declaredStream(
			vi.fn((_model, context) => {
				seenMessageCounts.push(context.messages.length);
				return completedStream(assistantMessage([{ type: "text", text: "continued" }]));
			}),
		);
		const agent = new Agent({ streamFn, convertToLlm, initialState: { model: model() } });
		agent.replaceContext({ messages: [], providerContext: providerContext() });

		await agent.continue();

		expect(streamFn).toHaveBeenCalledTimes(1);
		expect(convertToLlm).toHaveBeenCalledTimes(1);
		expect(seenConvertedCounts).toEqual([0]);
		expect(seenMessageCounts).toEqual([0]);
		expect(agent.state.messages).toHaveLength(1);
		expect(agent.state.messages[0]).toMatchObject({ role: "assistant", content: [{ text: "continued" }] });
		expect(agent.state.messages.some((message) => message.role === "user")).toBe(false);
	});

	it("keeps empty continuation closed without provider context or a declared consumer", async () => {
		const emptyAgent = new Agent({ streamFn: () => completedStream(), initialState: { model: model() } });
		await expect(emptyAgent.continue()).rejects.toThrow("No messages to continue from");

		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		const convertToLlm = vi.fn(identityConverter);
		const streamFn = vi.fn(() => completedStream());
		const undeclaredAgent = new Agent({
			streamFn,
			transformContext,
			convertToLlm,
			initialState: { model: model() },
		});
		undeclaredAgent.replaceContext({ messages: [], providerContext: providerContext() });

		await undeclaredAgent.continue();

		expect(transformContext).not.toHaveBeenCalled();
		expect(convertToLlm).not.toHaveBeenCalled();
		expect(streamFn).not.toHaveBeenCalled();
		expect(undeclaredAgent.state.errorMessage).toBe("Native compaction is not supported.");
	});

	it("synchronizes a complete prepareNextTurn context into the loop and Agent state", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const seenContexts: Array<ProviderContextEnvelope | undefined> = [];
		let calls = 0;
		const streamFn = declaredStream((_model, context) => {
			seenContexts.push(context.providerContext);
			calls++;
			return calls === 1
				? completedStream(
						assistantMessage([{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }], "toolUse"),
					)
				: completedStream();
		});
		const replacementContext = providerContext("replacement", "replacement-opaque");
		const agent = new Agent({
			streamFn,
			initialState: { tools: [tool] },
			prepareNextTurnWithContext: async (context) => ({
				context: {
					systemPrompt: "replacement prompt",
					messages: context.context.messages.slice(),
					tools: context.context.tools,
					providerContext: replacementContext,
				},
			}),
		});
		agent.replaceContext({ messages: [], providerContext: providerContext("original") });

		await agent.prompt("run tools");

		expect(calls).toBe(2);
		expect(seenContexts[0]?.binding.model).toBe("original");
		expect(seenContexts[1]?.binding.model).toBe("replacement");
		expect(agent.state.providerContext?.binding.model).toBe("replacement");
		expect(agent.state.systemPrompt).toBe("replacement prompt");
	});

	it("preserves omitted prepare context and clears provider context on an explicit complete replacement", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		for (const replacement of ["omit", "clear"] as const) {
			const seenContexts: Array<ProviderContextEnvelope | undefined> = [];
			let calls = 0;
			const streamFn = declaredStream((_model, context) => {
				seenContexts.push(context.providerContext);
				calls++;
				return calls === 1
					? completedStream(
							assistantMessage([{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }], "toolUse"),
						)
					: completedStream();
			});
			const agent = new Agent({
				streamFn,
				initialState: { tools: [tool] },
				prepareNextTurnWithContext: async (context) =>
					replacement === "omit"
						? {}
						: {
								context: {
									systemPrompt: context.context.systemPrompt,
									messages: context.context.messages.slice(),
									tools: context.context.tools,
								},
							},
			});
			agent.replaceContext({ messages: [], providerContext: providerContext("original") });

			await agent.prompt("run tools");

			expect(seenContexts[0]?.binding.model).toBe("original");
			if (replacement === "omit") {
				expect(seenContexts[1]?.binding.model).toBe("original");
				expect(agent.state.providerContext?.binding.model).toBe("original");
			} else {
				expect(seenContexts[1]).toBeUndefined();
				expect(agent.state.providerContext).toBeUndefined();
			}
		}
	});

	it("keeps Agent state intact when prepareNextTurn returns an invalid provider context", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let calls = 0;
		const streamFn = declaredStream(() => {
			calls++;
			return completedStream(
				assistantMessage([{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }], "toolUse"),
			);
		});
		const agent = new Agent({
			streamFn,
			initialState: { tools: [tool] },
			prepareNextTurnWithContext: async (context) => ({
				context: {
					systemPrompt: "must-not-commit",
					messages: context.context.messages.slice(),
					tools: context.context.tools,
					providerContext: null as never,
				},
			}),
		});
		agent.replaceContext({ messages: [], providerContext: providerContext("stable") });

		await agent.prompt("run tools");

		expect(calls).toBe(1);
		expect(agent.state.providerContext?.binding.model).toBe("stable");
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.errorMessage).toBe("Native compaction context is invalid.");
	});

	it("validates the complete prepareNextTurn update before committing any state", async () => {
		for (const failure of ["model-getter", "own-keys"] as const) {
			const initialModel = model();
			const streamFn = declaredStream(() => completedStream());
			const createInvalidUpdate = (context: AgentContext): AgentLoopTurnUpdate => {
				const replacement = {
					context: {
						systemPrompt: "must-not-commit",
						messages: [...context.messages, { role: "user" as const, content: "must-not-commit", timestamp: 99 }],
						providerContext: providerContext("must-not-commit"),
					},
				} satisfies AgentLoopTurnUpdate;
				if (failure === "own-keys") {
					return new Proxy(replacement, {
						ownKeys() {
							throw new Error("OWN_KEYS_SECRET");
						},
					});
				}
				return Object.defineProperty(replacement, "model", {
					enumerable: true,
					get() {
						throw new Error("MODEL_GETTER_SECRET");
					},
				}) as AgentLoopTurnUpdate;
			};
			const agent = new Agent({
				streamFn,
				initialState: {
					systemPrompt: "stable",
					model: initialModel,
					thinkingLevel: "high",
				},
				prepareNextTurnWithContext: async ({ context }) => createInvalidUpdate(context),
			});
			agent.replaceContext({ messages: [], providerContext: providerContext("stable") });

			await agent.prompt("run");

			expect(agent.state.systemPrompt).toBe("stable");
			expect(agent.state.model).toBe(initialModel);
			expect(agent.state.thinkingLevel).toBe("high");
			expect(agent.state.providerContext?.binding.model).toBe("stable");
			expect(
				agent.state.messages.some((message) => message.role === "user" && message.content === "must-not-commit"),
			).toBe(false);
			expect(agent.state.errorMessage).toBe("Native compaction context is invalid.");
			expect(agent.state.errorMessage).not.toContain("SECRET");
		}
	});

	it("rejects external replacement while a declared provider-context run is active", async () => {
		let activeStream: MockAssistantStream | undefined;
		const streamFn = declaredStream(
			vi.fn(() => {
				activeStream = new MockAssistantStream();
				return activeStream;
			}),
		);
		const agent = new Agent({ streamFn });
		agent.replaceContext({ messages: [], providerContext: providerContext() });
		const pending = agent.prompt("wait");
		await vi.waitFor(() => expect(streamFn).toHaveBeenCalledTimes(1));

		expect(() => agent.replaceContext({ messages: [] })).toThrow(
			"Cannot replace context while the agent is processing.",
		);
		expect(() => {
			agent.state.messages = [{ role: "user", content: "must-not-replace", timestamp: 2 }];
		}).toThrow("Cannot replace context while the agent is processing.");
		expect(() => {
			agent.state.providerContext = providerContext("must-not-replace");
		}).toThrow("Cannot replace context while the agent is processing.");
		const exposedMessages = agent.state.messages;
		exposedMessages.push({ role: "user", content: "must-not-append", timestamp: 3 });
		exposedMessages.length = 0;
		activeStream!.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text: "done" }]) });
		await pending;
		expect(agent.state.providerContext?.binding.model).toBe("mock");
		expect(
			agent.state.messages.some((message) => message.role === "user" && message.content === "must-not-replace"),
		).toBe(false);
		expect(
			agent.state.messages.some((message) => message.role === "user" && message.content === "must-not-append"),
		).toBe(false);
		expect(agent.state.messages.some((message) => message.role === "user" && message.content !== "")).toBe(true);
	});

	it("stops after an aborted transform without reading credentials or dispatching", async () => {
		let enterTransform = () => {};
		let releaseTransform = () => {};
		const transformEntered = new Promise<void>((resolve) => {
			enterTransform = resolve;
		});
		const transformGate = new Promise<void>((resolve) => {
			releaseTransform = resolve;
		});
		const transformContext = vi.fn(async (messages: AgentMessage[]) => {
			enterTransform();
			await transformGate;
			return messages;
		});
		const convertToLlm = vi.fn(identityConverter);
		const getApiKey = vi.fn(async () => "unused");
		const streamFn = declaredStream(vi.fn(() => completedStream()));
		const agent = new Agent({ streamFn, transformContext, convertToLlm, getApiKey });
		agent.replaceContext({ messages: [], providerContext: providerContext() });

		const pending = agent.prompt("abort while transforming");
		await transformEntered;
		agent.abort();
		releaseTransform();
		await pending;

		expect(convertToLlm).not.toHaveBeenCalled();
		expect(getApiKey).not.toHaveBeenCalled();
		expect(streamFn).not.toHaveBeenCalled();
		expect(agent.state.errorMessage).toBe("Native compaction was aborted.");
	});

	it("discards a normal stream result that resolves after abort", async () => {
		let enterResult = () => {};
		let releaseResult = () => {};
		const resultEntered = new Promise<void>((resolve) => {
			enterResult = resolve;
		});
		const resultGate = new Promise<void>((resolve) => {
			releaseResult = resolve;
		});
		const normalMessage = assistantMessage([{ type: "text", text: "must-not-commit" }]);
		const streamFn = declaredStream(() => {
			const stream = new DeferredResultAssistantStream(normalMessage, resultGate, enterResult);
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: normalMessage }));
			return stream;
		});
		const agent = new Agent({ streamFn });
		agent.replaceContext({ messages: [], providerContext: providerContext() });

		const pending = agent.prompt("abort while reading result");
		await resultEntered;
		agent.abort();
		releaseResult();
		await pending;

		expect(
			agent.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "text" && part.text === "must-not-commit"),
			),
		).toBe(false);
		expect(agent.state.errorMessage).toBe("Native compaction was aborted.");
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("discards prepareNextTurn state returned after abort", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let enterPrepare = () => {};
		let releasePrepare = () => {};
		const prepareEntered = new Promise<void>((resolve) => {
			enterPrepare = resolve;
		});
		const prepareGate = new Promise<void>((resolve) => {
			releasePrepare = resolve;
		});
		const streamFn = declaredStream(() =>
			completedStream(
				assistantMessage([{ type: "toolCall", id: "call-1", name: "noop", arguments: {} }], "toolUse"),
			),
		);
		const agent = new Agent({
			streamFn,
			initialState: { tools: [tool] },
			prepareNextTurnWithContext: async (context) => {
				enterPrepare();
				await prepareGate;
				return {
					context: {
						systemPrompt: "must-not-commit",
						messages: context.context.messages.slice(),
						tools: context.context.tools,
						providerContext: providerContext("must-not-commit"),
					},
				};
			},
		});
		agent.replaceContext({ messages: [], providerContext: providerContext("stable") });

		const pending = agent.prompt("abort while preparing");
		await prepareEntered;
		agent.abort();
		releasePrepare();
		await pending;

		expect(agent.state.providerContext?.binding.model).toBe("stable");
		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.errorMessage).toBe("Native compaction was aborted.");
	});

	it("settles both low-level loop entry points when provider-context dispatch is undeclared", async () => {
		for (const mode of ["prompt", "continue"] as const) {
			const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
			const convertToLlm = vi.fn(identityConverter);
			const getApiKey = vi.fn(async () => "unused");
			const streamFn = vi.fn(() => completedStream());
			const userMessage: AgentMessage = { role: "user", content: "blocked", timestamp: 1 };
			const context: AgentContext = {
				systemPrompt: "",
				messages: mode === "continue" ? [userMessage] : [],
				providerContext: providerContext(),
			};
			const config: AgentLoopConfig = { model: model(), transformContext, convertToLlm, getApiKey };
			const stream =
				mode === "prompt"
					? agentLoop([userMessage], context, config, undefined, streamFn)
					: agentLoopContinue(context, config, undefined, streamFn);
			const events = [];
			for await (const event of stream) events.push(event);
			const result = await stream.result();

			expect(events.map((event) => event.type)).toEqual(
				mode === "prompt"
					? [
							"agent_start",
							"turn_start",
							"message_start",
							"message_end",
							"message_start",
							"message_end",
							"turn_end",
							"agent_end",
						]
					: ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"],
			);
			expect(result.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: "Native compaction is not supported.",
			});
			expect(transformContext).not.toHaveBeenCalled();
			expect(convertToLlm).not.toHaveBeenCalled();
			expect(getApiKey).not.toHaveBeenCalled();
			expect(streamFn).not.toHaveBeenCalled();
		}
	});

	it("settles a low-level invalid context with a fixed error before dispatch", async () => {
		const convertToLlm = vi.fn(identityConverter);
		const streamFn = declaredStream(vi.fn(() => completedStream()));
		const context = {
			systemPrompt: "",
			messages: [],
			providerContext: "" as never,
		} satisfies AgentContext;
		const stream = agentLoop(
			[{ role: "user", content: "blocked", timestamp: 1 }],
			context,
			{ model: model(), convertToLlm },
			undefined,
			streamFn,
		);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(result.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "Native compaction context is invalid.",
		});
		expect(convertToLlm).not.toHaveBeenCalled();
		expect(streamFn).not.toHaveBeenCalled();
	});

	it("forwards only defined provider stream options across the Agent boundary", async () => {
		let receivedOptions: unknown;
		const streamFn = declaredStream((_model, _context, options) => {
			receivedOptions = options;
			return completedStream();
		});
		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		const getApiKey = vi.fn(async () => "dynamic-key");
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			providerContext: providerContext(),
		};
		const stream = agentLoop(
			[{ role: "user", content: "continue", timestamp: 1 }],
			context,
			{
				model: model(),
				convertToLlm: identityConverter,
				transformContext,
				getApiKey,
				temperature: 0,
				maxTokens: undefined,
				sessionId: "session-1",
				headers: { "x-test": "allowed" },
			},
			undefined,
			streamFn,
		);
		for await (const _event of stream) {
			// Drain the stream so the low-level loop reaches its final state.
		}
		await stream.result();

		expect(receivedOptions).toEqual({
			temperature: 0,
			apiKey: "dynamic-key",
			sessionId: "session-1",
			headers: { "x-test": "allowed" },
		});
		expect(receivedOptions).not.toHaveProperty("model");
		expect(receivedOptions).not.toHaveProperty("convertToLlm");
		expect(receivedOptions).not.toHaveProperty("transformContext");
		expect(receivedOptions).not.toHaveProperty("getApiKey");
		expect(receivedOptions).not.toHaveProperty("maxTokens");
	});

	it("opens a new error turn when prepareNextTurn validation fails after a completed turn", async () => {
		const streamFn = declaredStream(vi.fn(() => completedStream()));
		const userMessage: AgentMessage = { role: "user", content: "run", timestamp: 1 };
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			providerContext: providerContext(),
		};
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => ({
				context: {
					systemPrompt: currentContext.systemPrompt,
					messages: currentContext.messages.slice(),
					providerContext: null as never,
				},
			}),
		};
		const stream = agentLoop([userMessage], context, config, undefined, streamFn);
		const events = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"turn_start",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(result).toHaveLength(3);
		expect(result.at(-1)).toMatchObject({ errorMessage: "Native compaction context is invalid." });
		expect(streamFn).toHaveBeenCalledTimes(1);
	});
});
