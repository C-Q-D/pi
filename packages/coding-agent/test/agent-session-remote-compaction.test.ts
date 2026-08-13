import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createNativeCompactionError,
	type FauxCompactionFactory,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, CompactOptions } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CompactionBoundaryError, type SanitizedCompactionResult } from "../src/core/compaction/index.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import {
	type AppendCompactionOptions,
	type AppendRemoteCompactionOptions,
	type RemoteCompactionEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const OPAQUE_SENTINEL = "REMOTE_COMPACTION_OPAQUE_SENTINEL";

interface HarnessOptions {
	readonly persistent?: boolean;
	readonly extension?: ExtensionFactory;
	readonly provider?: string;
}

interface Harness {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly runtime: ModelRuntime;
	readonly model: Model<"openai-responses">;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly tempDir: string;
}

function nativeResult(label: string): FauxCompactionFactory {
	return (request) => ({
		providerContext: {
			format: "openai-responses-compaction",
			version: 1,
			binding: request.binding,
			items: [{ type: "compaction", encrypted_content: `${OPAQUE_SENTINEL}:${label}` }],
		},
		usage: { inputTokens: 120, outputTokens: 12, totalTokens: 132 },
	});
}

describe("AgentSession manual remote compaction transaction", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
		const tempDir = join(tmpdir(), `pi-remote-compaction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = fauxProvider({
			provider: options.provider ?? `manual-native-${Math.random().toString(36).slice(2)}`,
			nativeCompaction: {},
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const model = faux.getModel() as Model<"openai-responses">;
		const sessionManager = options.persistent ? SessionManager.create(tempDir, tempDir) : SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: `raw prefix ${"context ".repeat(80)}`,
			timestamp: 1,
		});
		sessionManager.appendMessage(fauxAssistantMessage("raw assistant context"));
		sessionManager.appendMessage({ role: "user", content: "raw tail", timestamp: 2 });
		const settingsManager = SettingsManager.inMemory();
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1_000 } });
		const extensionsResult = options.extension
			? await createTestExtensionsResult([options.extension], tempDir)
			: undefined;
		const { session } = await createAgentSession({
			cwd: tempDir,
			modelRuntime: runtime,
			model,
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		cleanups.push(() => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		});
		return { session, sessionManager, runtime, model, faux, tempDir };
	}

	async function expectBoundaryCode(promise: Promise<unknown>, code: CompactionBoundaryError["code"]): Promise<void> {
		try {
			await promise;
			expect.fail(`Expected CompactionBoundaryError(${code})`);
		} catch (error) {
			expect(error).toBeInstanceOf(CompactionBoundaryError);
			expect((error as CompactionBoundaryError).code).toBe(code);
		}
	}

	it("runs remote, continues with the opaque checkpoint, then compacts remotely again", async () => {
		const { session, sessionManager, faux } = await createHarness();
		faux.nativeCompaction!.setResults([nativeResult("first"), nativeResult("second")]);

		const first = await session.compact({ requestedStrategy: "remote" });
		expect(first.summary).toBe("");
		expect(first.metadata).toMatchObject({ requestedStrategy: "remote", effectiveStrategy: "remote" });
		expect(JSON.stringify(first)).not.toContain(OPAQUE_SENTINEL);
		expect(session.agent.state.providerContext).toBeDefined();

		faux.setResponses([fauxAssistantMessage("continued after remote checkpoint")]);
		await session.prompt("continue after remote checkpoint");
		const second = await session.compact({ requestedStrategy: "remote" });

		expect(second.metadata.effectiveStrategy).toBe("remote");
		expect(faux.nativeCompaction!.state.compactCallCount).toBe(2);
		expect(faux.state.callCount).toBe(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(2);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "message").length).toBeGreaterThan(3);
		expect(JSON.stringify(sessionManager.buildSessionContext())).toContain(`${OPAQUE_SENTINEL}:second`);
	});

	it("converts an active remote checkpoint to Local without exposing opaque data to the summarizer", async () => {
		const { session, sessionManager, faux } = await createHarness();
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		faux.nativeCompaction!.setResults([nativeResult("remote-before-local")]);
		await session.compact({ requestedStrategy: "remote" });
		let localPayload = "";
		faux.setResponses([
			(context) => {
				localPayload = JSON.stringify(context);
				return fauxAssistantMessage("portable local summary");
			},
		]);

		const local = await session.compact("focus on durable decisions");

		expect(local.summary).toContain("portable local summary");
		expect(local.metadata).toMatchObject({ requestedStrategy: "local", effectiveStrategy: "local" });
		expect(localPayload).toContain("raw prefix");
		expect(localPayload).not.toContain(OPAQUE_SENTINEL);
		expect(session.agent.state.providerContext).toBeUndefined();
		expect(sessionManager.buildSessionContext().providerContext).toBeUndefined();
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "compaction_end").at(-1)).toMatchObject({
			type: "compaction_end",
			result: { metadata: { requestedStrategy: "local", effectiveStrategy: "local" } },
			aborted: false,
		});
	});

	it("supports remote to remote to Local and preserves append-only raw ancestry", async () => {
		const { session, sessionManager, faux } = await createHarness();
		faux.nativeCompaction!.setResults([nativeResult("one"), nativeResult("two")]);
		await session.compact({ requestedStrategy: "remote" });
		faux.setResponses([fauxAssistantMessage("continued")]);
		await session.prompt("continue once");
		await session.compact({ requestedStrategy: "remote" });
		faux.setResponses([
			fauxAssistantMessage("final portable summary"),
			fauxAssistantMessage("truncated turn prefix summary"),
		]);

		const local = await session.compact({ requestedStrategy: "local" });

		expect(local.metadata.effectiveStrategy).toBe("local");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(2);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(sessionManager.buildPortableRawEntries().some((entry) => entry.type === "remote_compaction")).toBe(false);
		expect(JSON.stringify(sessionManager.buildPortableRawEntries())).toContain("raw prefix");
	});

	it("restores a same-binding remote checkpoint and continues after reopening the Session", async () => {
		const firstHarness = await createHarness({ persistent: true, provider: "resume-native" });
		firstHarness.faux.nativeCompaction!.setResults([nativeResult("resume")]);
		await firstHarness.session.compact({ requestedStrategy: "remote" });
		const sessionFile = firstHarness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		firstHarness.session.dispose();

		const reopened = SessionManager.open(sessionFile!);
		const { session } = await createAgentSession({
			cwd: firstHarness.tempDir,
			modelRuntime: firstHarness.runtime,
			model: firstHarness.model,
			sessionManager: reopened,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(() => session.dispose());
		firstHarness.faux.setResponses([fauxAssistantMessage("resumed")]);

		await session.prompt("continue resumed session");

		expect(session.agent.state.providerContext).toBeDefined();
		expect(firstHarness.faux.state.callCount).toBe(1);
		expect(firstHarness.faux.nativeCompaction!.state.consumerCallCount).toBeGreaterThan(0);
	});

	it("keeps explicit Remote failure pre-commit and lets Auto fall back exactly once", async () => {
		const explicit = await createHarness();
		explicit.faux.nativeCompaction!.setResults([
			() => {
				throw createNativeCompactionError("provider_error");
			},
		]);
		await expectBoundaryCode(explicit.session.compact({ requestedStrategy: "remote" }), "provider_error");
		expect(explicit.sessionManager.getEntries().some((entry) => entry.type.includes("compaction"))).toBe(false);
		expect(explicit.faux.nativeCompaction!.state.compactCallCount).toBe(1);

		const automatic = await createHarness();
		automatic.faux.nativeCompaction!.setResults([
			() => {
				throw createNativeCompactionError("provider_error");
			},
		]);
		automatic.faux.setResponses([fauxAssistantMessage("fallback local summary")]);
		const fallback = await automatic.session.compact({ requestedStrategy: "auto" });

		expect(fallback.metadata).toMatchObject({
			requestedStrategy: "auto",
			effectiveStrategy: "local",
			fallbackCode: "provider_error",
		});
		expect(automatic.faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(automatic.faux.state.callCount).toBe(1);
		expect(automatic.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("rejects a Remote custom hook result before provider dispatch but lets Auto accept it as Local", async () => {
		const requestedStrategies: string[] = [];
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => {
				requestedStrategies.push(event.requestedStrategy);
				return {
					compaction: {
						summary: "extension local summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		};
		const remote = await createHarness({ extension });
		await expectBoundaryCode(remote.session.compact({ requestedStrategy: "remote" }), "invalid_hook_result");
		expect(remote.faux.nativeCompaction!.state.compactCallCount).toBe(0);
		expect(remote.sessionManager.getEntries().some((entry) => entry.type.includes("compaction"))).toBe(false);

		const automatic = await createHarness({ extension });
		const result = await automatic.session.compact({ requestedStrategy: "auto" });
		expect(result).toMatchObject({ summary: "extension local summary" });
		expect(result.metadata.effectiveStrategy).toBe("local");
		expect(automatic.faux.nativeCompaction!.state.compactCallCount).toBe(0);
		expect(requestedStrategies).toEqual(["remote", "auto"]);
	});

	it("enforces single-flight while one native attempt is waiting", async () => {
		const { session, sessionManager, faux } = await createHarness();
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.nativeCompaction!.setResults([
			async (request) => {
				markStarted?.();
				await gate;
				return nativeResult("single-flight")(request, faux.nativeCompaction!.state);
			},
		]);

		const first = session.compact({ requestedStrategy: "remote" });
		await started;
		await expectBoundaryCode(session.compact({ requestedStrategy: "remote" }), "in_progress");
		release?.();
		await first;

		expect(faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
	});

	it("aborts a native attempt while the provider is waiting and commits nothing", async () => {
		const { session, sessionManager, faux } = await createHarness();
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.nativeCompaction!.setResults([
			async (request) => {
				markStarted?.();
				await gate;
				return nativeResult("aborted")(request, faux.nativeCompaction!.state);
			},
		]);

		const pending = session.compact({ requestedStrategy: "remote" });
		await started;
		session.abortCompaction();
		release?.();

		await expectBoundaryCode(pending, "aborted");
		expect(faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(sessionManager.getEntries().some((entry) => entry.type.includes("compaction"))).toBe(false);
	});

	it("rejects a branch mutation made by a compaction hook before provider dispatch", async () => {
		const managerRef: { current?: SessionManager } = {};
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", () => {
				managerRef.current?.appendMessage({ role: "user", content: "concurrent branch change", timestamp: 3 });
			});
		};
		const { session, sessionManager, faux } = await createHarness({ extension });
		managerRef.current = sessionManager;

		await expectBoundaryCode(session.compact({ requestedStrategy: "remote" }), "stale_branch");

		expect(faux.nativeCompaction!.state.compactCallCount).toBe(0);
		expect(sessionManager.getEntries().filter((entry) => entry.type.includes("compaction"))).toHaveLength(0);
		expect(sessionManager.getEntries().at(-1)).toMatchObject({
			type: "message",
			message: { content: "concurrent branch change" },
		});
	});

	it("rechecks the branch after Local auth resolution and before summary dispatch", async () => {
		const { session, sessionManager, runtime, faux } = await createHarness();
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(runtime, "getAuth").mockImplementation(async () => {
			markStarted?.();
			await gate;
			return undefined;
		});

		const pending = session.compact({ requestedStrategy: "local" });
		await started;
		sessionManager.appendMessage({ role: "user", content: "changed during auth", timestamp: 3 });
		release?.();

		await expectBoundaryCode(pending, "stale_branch");
		expect(faux.state.callCount).toBe(0);
		expect(sessionManager.getEntries().filter((entry) => entry.type.includes("compaction"))).toHaveLength(0);
	});

	it("rechecks the branch after message conversion and before native dispatch", async () => {
		const { session, sessionManager, faux } = await createHarness();
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalConvert = session.agent.convertToLlm;
		session.agent.convertToLlm = async (messages) => {
			markStarted?.();
			await gate;
			return originalConvert(messages);
		};
		faux.nativeCompaction!.setResults([nativeResult("must-not-dispatch")]);

		const pending = session.compact({ requestedStrategy: "remote" });
		await started;
		sessionManager.appendMessage({ role: "user", content: "changed during conversion", timestamp: 3 });
		release?.();

		await expectBoundaryCode(pending, "stale_branch");
		expect(faux.nativeCompaction!.state.compactCallCount).toBe(0);
		expect(sessionManager.getEntries().filter((entry) => entry.type.includes("compaction"))).toHaveLength(0);
	});

	it("reloads after an append exception, recognizes the committed operation, and never resends", async () => {
		const { session, sessionManager, faux } = await createHarness({ persistent: true });
		faux.nativeCompaction!.setResults([nativeResult("ambiguous-commit")]);
		const originalAppend = sessionManager.appendRemoteCompaction.bind(sessionManager);
		sessionManager.appendRemoteCompaction = (options: AppendRemoteCompactionOptions): RemoteCompactionEntry => {
			originalAppend(options);
			throw new Error("synthetic exception after durable append");
		};

		const result = await session.compact({ requestedStrategy: "remote" });

		expect(result.metadata.effectiveStrategy).toBe("remote");
		expect(faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
	});

	it("rejects a Local checkpoint that collides with a Remote attempt operation identity", async () => {
		const { session, sessionManager, faux } = await createHarness();
		faux.nativeCompaction!.setResults([nativeResult("remote-local-collision")]);
		const appendLocal = sessionManager.appendCompactionTransaction.bind(sessionManager);
		sessionManager.appendRemoteCompaction = (options: AppendRemoteCompactionOptions): RemoteCompactionEntry => {
			appendLocal({
				entryId: options.entryId,
				operationId: options.operationId,
				timestamp: options.timestamp,
				summary: "conflicting local checkpoint",
				firstKeptEntryId: sessionManager.getBranch()[0]!.id,
				tokensBefore: options.tokensBefore,
				metadata: options.metadata,
			});
			throw new Error("synthetic cross-type collision");
		};

		await expectBoundaryCode(session.compact({ requestedStrategy: "remote" }), "commit_indeterminate");

		expect(faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(0);
	});

	it("rejects a Remote checkpoint that collides with a Local attempt operation identity", async () => {
		const { session, sessionManager, runtime, model, faux } = await createHarness();
		faux.nativeCompaction!.setResults([nativeResult("local-remote-collision")]);
		const remoteSeed = await runtime.compact(model, { messages: [] });
		faux.setResponses([fauxAssistantMessage("local summary before collision")]);
		const appendRemote = sessionManager.appendRemoteCompaction.bind(sessionManager);
		sessionManager.appendCompactionTransaction = <T>(options: AppendCompactionOptions<T>) => {
			appendRemote({
				entryId: options.entryId,
				operationId: options.operationId,
				timestamp: options.timestamp,
				summary: "",
				tokensBefore: options.tokensBefore,
				providerContext: remoteSeed.providerContext,
				metadata: options.metadata,
			});
			throw new Error("synthetic cross-type collision");
		};

		await expectBoundaryCode(session.compact({ requestedStrategy: "local" }), "commit_indeterminate");

		expect(faux.state.callCount).toBe(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("keeps a committed result successful when an external event listener throws", async () => {
		const { session, sessionManager, faux } = await createHarness();
		const observed: AgentSessionEvent[] = [];
		faux.nativeCompaction!.setResults([nativeResult("listener-throw")]);
		session.subscribe((event) => {
			if (event.type === "compaction_end" && !event.errorCode) throw new Error("PRIVATE_LISTENER_SENTINEL");
		});
		session.subscribe((event) => observed.push(event));

		const result = await session.compact({ requestedStrategy: "remote" });

		expect(result.metadata.effectiveStrategy).toBe("remote");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
		expect(observed.filter((event) => event.type === "compaction_end")).toEqual([
			expect.objectContaining({ type: "compaction_end", aborted: false, result }),
		]);
		expect(JSON.stringify(observed)).not.toContain("PRIVATE_LISTENER_SENTINEL");
	});

	it("does not turn an Extension onComplete callback failure into a transaction failure", async () => {
		let onCompleteCalls = 0;
		let onErrorCalls = 0;
		let markCallbackSettled: (() => void) | undefined;
		const callbackSettled = new Promise<void>((resolve) => {
			markCallbackSettled = resolve;
		});
		const extension: ExtensionFactory = (pi) => {
			pi.registerCommand("remote-callback-failure", {
				description: "Exercise remote compaction callback isolation",
				handler: async (_args, ctx) => {
					ctx.compact({
						requestedStrategy: "remote",
						onComplete: () => {
							onCompleteCalls++;
							queueMicrotask(() => markCallbackSettled?.());
							throw new Error("PRIVATE_ON_COMPLETE_SENTINEL");
						},
						onError: () => {
							onErrorCalls++;
							markCallbackSettled?.();
						},
					});
				},
			});
		};
		const { session, sessionManager, faux } = await createHarness({ extension });
		const observed: AgentSessionEvent[] = [];
		session.subscribe((event) => observed.push(event));
		faux.nativeCompaction!.setResults([nativeResult("extension-callback")]);

		await session.prompt("/remote-callback-failure");
		await callbackSettled;

		expect(onCompleteCalls).toBe(1);
		expect(onErrorCalls).toBe(0);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
		expect(observed.filter((event) => event.type === "compaction_end")).toHaveLength(1);
		expect(JSON.stringify(observed)).not.toContain("PRIVATE_ON_COMPLETE_SENTINEL");
	});

	it("reports an unconfirmed append without retrying and marks rebuild failure as post-commit", async () => {
		const unconfirmed = await createHarness({ persistent: true });
		unconfirmed.faux.nativeCompaction!.setResults([nativeResult("unconfirmed")]);
		unconfirmed.sessionManager.appendRemoteCompaction = (
			_options: AppendRemoteCompactionOptions,
		): RemoteCompactionEntry => {
			throw new Error("synthetic exception before append");
		};
		await expectBoundaryCode(unconfirmed.session.compact({ requestedStrategy: "remote" }), "commit_indeterminate");
		expect(unconfirmed.faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(
			unconfirmed.sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction"),
		).toHaveLength(0);

		const committed = await createHarness();
		committed.faux.nativeCompaction!.setResults([nativeResult("committed-rebuild-failure")]);
		committed.session.agent.replaceContext = () => {
			throw new Error("synthetic replacement failure");
		};
		await expectBoundaryCode(
			committed.session.compact({ requestedStrategy: "remote" }),
			"committed_restart_required",
		);
		expect(committed.sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(
			1,
		);
		expect(committed.sessionManager.buildSessionContext().providerContext).toBeDefined();
	});

	it("keeps the object options type independently usable by SDK callers", () => {
		const options: CompactOptions = { requestedStrategy: "auto", customInstructions: "focus on decisions" };
		const result: SanitizedCompactionResult | undefined = undefined;
		expect(options.requestedStrategy).toBe("auto");
		expect(result).toBeUndefined();
	});
});
