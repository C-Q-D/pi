/**
 * 原生远端压缩的离线生命周期组合回归。
 *
 * 这里不重复证明单个 Adapter 或 Builder 的细节，而是把真实入口、Session 持久化、
 * 自动压缩、队列、分支和隐私投影串成纵向链，防止跨模块组合后丢历史或重复提交。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	createNativeCompactionError,
	createProvider,
	type FauxCompactionFactory,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
	type NativeCompactionResult,
	type OAuthAuth,
	type ProviderContextBinding,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openAICodexResponsesApi } from "../../../ai/src/api/openai-codex-responses.lazy.ts";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	createExternalSessionEntries,
	createExternalSessionTree,
	createSanitizedCompactionEntry,
} from "../../src/core/compaction/index.ts";
import { exportFromFile } from "../../src/core/export-html/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { CompactionSummaryMessage } from "../../src/core/messages.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import {
	createReadonlySessionManager,
	type SessionManager,
	SessionManager as WritableSessionManager,
} from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { CompactionSummaryMessageComponent } from "../../src/modes/interactive/components/compaction-summary-message.ts";
import { TreeSelectorComponent } from "../../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestResourceLoader } from "../utilities.ts";

const OPAQUE_PREFIX = "LIFECYCLE_OPAQUE_SENTINEL";

interface FauxLifecycleHarness {
	readonly session: AgentSession;
	readonly sessionManager: WritableSessionManager;
	readonly runtime: ModelRuntime;
	readonly model: Model<"openai-responses">;
	readonly faux: FauxProviderHandle;
	readonly events: AgentSessionEvent[];
	readonly tempDir: string;
}

const cleanups: Array<() => void> = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	while (cleanups.length > 0) cleanups.pop()?.();
});

function createTempDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}

function nativeResult(label: string): FauxCompactionFactory {
	return (request) => ({
		providerContext: {
			format: "openai-responses-compaction",
			version: 1,
			binding: request.binding,
			items: [{ type: "compaction", encrypted_content: `${OPAQUE_PREFIX}:${label}` }],
		},
		usage: { inputTokens: 120, outputTokens: 12, totalTokens: 132 },
	});
}

function overflowResponse(label: string) {
	return fauxAssistantMessage(label, {
		stopReason: "error",
		errorMessage: "prompt is too long",
	});
}

async function createFauxLifecycleHarness(options: {
	readonly provider: string;
	readonly strategy?: "local" | "remote" | "auto";
	readonly persistent?: boolean;
}): Promise<FauxLifecycleHarness> {
	const tempDir = createTempDirectory(`pi-remote-lifecycle-${options.provider}-`);
	const faux = fauxProvider({ provider: options.provider, nativeCompaction: {} });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const model = faux.getModel() as Model<"openai-responses">;
	const sessionManager = options.persistent
		? WritableSessionManager.create(tempDir, tempDir)
		: WritableSessionManager.inMemory(tempDir);
	sessionManager.appendMessage({ role: "user", content: `raw prefix ${"context ".repeat(80)}`, timestamp: 1 });
	sessionManager.appendMessage(fauxAssistantMessage("raw assistant context"));
	sessionManager.appendMessage({ role: "user", content: "raw tail", timestamp: 2 });
	const settingsManager = SettingsManager.inMemory({ compaction: { strategy: options.strategy } });
	settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1_000 } });
	const { session } = await createAgentSession({
		cwd: tempDir,
		modelRuntime: runtime,
		model,
		sessionManager,
		settingsManager,
		resourceLoader: createTestResourceLoader(),
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	cleanups.push(() => session.dispose());
	return { session, sessionManager, runtime, model, faux, events, tempDir };
}

/**
 * 用真实公共投影、TUI 组件和 HTML Export 审计一个已提交生命周期。
 * RPC 与 Extension 都消费同一 External DTO，因此这里同时保留两种最终 JSON 形状。
 */
async function expectSafeExternalOutputs(
	sessionManager: SessionManager,
	events: readonly AgentSessionEvent[],
	forbidden: readonly string[],
): Promise<void> {
	const entries = createExternalSessionEntries(sessionManager.getEntries());
	const tree = createExternalSessionTree(sessionManager.getTree());
	const readonlySession = createReadonlySessionManager(sessionManager);
	const checkpoint = [...sessionManager.getBranch()]
		.reverse()
		.find((entry) => entry.type === "compaction" || entry.type === "remote_compaction");
	const sanitizedCheckpoint = checkpoint ? createSanitizedCompactionEntry(checkpoint) : undefined;
	let summaryOutput = "";
	if (checkpoint && sanitizedCheckpoint) {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: sanitizedCheckpoint.summary,
			tokensBefore: sanitizedCheckpoint.tokensBefore,
			timestamp: 1,
			details: checkpoint,
		} as CompactionSummaryMessage);
		component.setExpanded(true);
		summaryOutput = component.render(100).map(stripVTControlCharacters).join("\n");
	}
	const selector = new TreeSelectorComponent(
		sessionManager.getTree(),
		sessionManager.getLeafId(),
		24,
		() => {},
		() => {},
	);
	const treeOutput = selector.render(100).map(stripVTControlCharacters).join("\n");
	const rpcOutput = {
		get_entries: { entries, leafId: sessionManager.getLeafId() },
		get_tree: { tree, leafId: sessionManager.getLeafId() },
	};
	const extensionOutput = {
		entries: readonlySession.getEntries(),
		branch: readonlySession.getBranch(),
		checkpoint: sanitizedCheckpoint,
		events: events.filter((event) => event.type === "compaction_end"),
	};
	let htmlSessionData = "";
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile) {
		const outputPath = join(sessionManager.getSessionDir(), `audit-${sessionManager.getSessionId()}.html`);
		await exportFromFile(sessionFile, { outputPath });
		const html = readFileSync(outputPath, "utf8");
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		htmlSessionData = Buffer.from(encoded ?? "", "base64").toString("utf8");
	}
	const output = JSON.stringify({
		tui: { summaryOutput, treeOutput, selected: selector.getTreeList().getSelectedNode() },
		rpc: rpcOutput,
		extension: extensionOutput,
		htmlSessionData,
	});
	for (const sentinel of forbidden) expect(output).not.toContain(sentinel);
}

function sse(events: readonly unknown[]): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function compactSse(encryptedContent: string): string {
	return sse([
		{
			type: "response.output_item.done",
			item: { type: "compaction", id: "cmp_lifecycle", encrypted_content: encryptedContent },
		},
		{
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
		},
	]);
}

function ordinarySse(text: string): string {
	return sse([
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${text}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${text}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
		},
	]);
}

function eventStreamResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "retry-after-ms": "0" },
	});
}

function createAccessToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

describe("ATOM-16 remote compaction lifecycle combinations", () => {
	it("Scenario A: Manual Codex V2 continues before and after close/resume", async () => {
		const tempDir = createTempDirectory("pi-codex-v2-lifecycle-");
		const providerId = "codex-v2-lifecycle";
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-codex-lifecycle",
			name: "Codex lifecycle",
			api: "openai-codex-responses",
			provider: providerId,
			baseUrl: "https://chatgpt.example.test/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		};
		const credentials = AuthStorage.inMemory();
		const token = createAccessToken("stable-account");
		await credentials.modify(providerId, async () => ({
			type: "oauth",
			access: token,
			refresh: "offline-refresh",
			expires: Date.now() + 60 * 60 * 1_000,
			accountId: "stable-account",
		}));
		const oauth: OAuthAuth = {
			name: "Offline Codex",
			login: async () => {
				throw new Error("Offline lifecycle must not login");
			},
			refresh: async (credential) => credential,
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(
			createProvider({ id: providerId, auth: { oauth }, models: [model], api: openAICodexResponsesApi() }),
		);
		await runtime.refresh({ allowNetwork: false });
		const responses = [
			eventStreamResponse(compactSse(`${OPAQUE_PREFIX}:codex-v2`)),
			eventStreamResponse(ordinarySse("continued-before-close")),
			eventStreamResponse(ordinarySse("continued-after-resume")),
		];
		const fetch = vi.fn(async () => {
			const next = responses.shift();
			if (!next) throw new Error("Unexpected extra Codex request");
			return next;
		});
		vi.stubGlobal("fetch", fetch);
		const sessionManager = WritableSessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({
			role: "user",
			content: `Codex raw history ${"context ".repeat(80)}`,
			timestamp: 1,
		});
		sessionManager.appendMessage({
			...fauxAssistantMessage("Codex raw assistant"),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		sessionManager.appendMessage({ role: "user", content: "Codex raw tail", timestamp: 2 });
		const settingsManager = SettingsManager.inMemory();
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1_000 } });
		const first = await createAgentSession({
			cwd: tempDir,
			modelRuntime: runtime,
			model,
			sessionManager,
			settingsManager,
			resourceLoader: createTestResourceLoader(),
		});
		const events: AgentSessionEvent[] = [];
		first.session.subscribe((event) => events.push(event));
		await first.session.compact({ requestedStrategy: "remote" });
		await first.session.prompt("continue before close");
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		first.session.dispose();

		const reopened = WritableSessionManager.open(sessionFile!, tempDir, tempDir);
		const resumed = await createAgentSession({
			cwd: tempDir,
			modelRuntime: runtime,
			model,
			sessionManager: reopened,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(() => resumed.session.dispose());
		await resumed.session.prompt("continue after resume");

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(responses).toHaveLength(0);
		expect(reopened.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
		for (const prompt of ["continue before close", "continue after resume"]) {
			expect(
				reopened
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(prompt),
					),
			).toHaveLength(1);
		}
		expect(resumed.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		await expectSafeExternalOutputs(reopened, events, [`${OPAQUE_PREFIX}:codex-v2`]);
	});

	it("Scenario B: Remote to Remote to portable Local then switches Provider and continues", async () => {
		const harness = await createFauxLifecycleHarness({ provider: "lifecycle-b-primary", persistent: true });
		const secondary = fauxProvider({ provider: "lifecycle-b-secondary" });
		harness.runtime.registerNativeProvider(secondary.provider);
		await harness.runtime.refresh({ allowNetwork: false });
		harness.faux.nativeCompaction!.setResults([nativeResult("b-first"), nativeResult("b-second")]);

		await harness.session.compact({ requestedStrategy: "remote" });
		harness.faux.setResponses([fauxAssistantMessage("between remote checkpoints")]);
		await harness.session.prompt("continue between remote checkpoints");
		await harness.session.compact({ requestedStrategy: "remote" });
		harness.faux.setResponses([
			fauxAssistantMessage("portable local summary"),
			fauxAssistantMessage("portable truncated turn prefix summary"),
		]);
		await harness.session.compact({ requestedStrategy: "local" });
		await harness.session.setModel(secondary.getModel());
		secondary.setResponses([fauxAssistantMessage("continued on secondary Provider")]);
		await harness.session.prompt("continue after Provider switch");

		expect(harness.faux.nativeCompaction!.state.compactCallCount).toBe(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.sessionManager.buildSessionContext().providerContext).toBeUndefined();
		expect(harness.session.model?.provider).toBe("lifecycle-b-secondary");
		expect(secondary.state.callCount).toBe(1);
		expect(JSON.stringify(harness.sessionManager.buildPortableRawEntries())).toContain("raw prefix");
		await expectSafeExternalOutputs(harness.sessionManager, harness.events, [
			`${OPAQUE_PREFIX}:b-first`,
			`${OPAQUE_PREFIX}:b-second`,
		]);
	});

	it("Scenario C: Threshold Auto falls back once and flushes a queued follow-up", async () => {
		const harness = await createFauxLifecycleHarness({
			provider: "lifecycle-c-auto",
			strategy: "auto",
			persistent: true,
		});
		harness.session.settingsManager.applyOverrides({
			compaction: {
				enabled: true,
				keepRecentTokens: 1,
				reserveTokens: harness.model.contextWindow - 1,
			},
		});
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.faux.nativeCompaction!.setResults([
			async () => {
				markStarted?.();
				await gate;
				throw createNativeCompactionError("provider_error");
			},
		]);
		harness.faux.setResponses([
			fauxAssistantMessage("threshold trigger response"),
			fauxAssistantMessage("threshold local fallback summary"),
			fauxAssistantMessage("threshold truncated turn prefix summary"),
			fauxAssistantMessage("queued threshold follow-up completed"),
		]);

		const pending = harness.session.prompt("threshold auto trigger");
		await started;
		await harness.session.followUp("queued during threshold fallback");
		release?.();
		await pending;

		expect(harness.faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(harness.events.filter((event) => event.type === "compaction_end")).toEqual([
			expect.objectContaining({
				reason: "threshold",
				result: expect.objectContaining({
					metadata: expect.objectContaining({
						requestedStrategy: "auto",
						effectiveStrategy: "local",
						fallbackCode: "provider_error",
					}),
				}),
			}),
		]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ text: "queued threshold follow-up completed" }],
		});
		await expectSafeExternalOutputs(harness.sessionManager, harness.events, [OPAQUE_PREFIX]);
	});

	it("Scenario D: Overflow excludes the raw error, retries once, then stops on the second overflow", async () => {
		const harness = await createFauxLifecycleHarness({
			provider: "lifecycle-d-overflow",
			strategy: "remote",
			persistent: true,
		});
		harness.faux.setResponses([overflowResponse("D_FIRST_OVERFLOW"), overflowResponse("D_SECOND_OVERFLOW")]);
		harness.faux.nativeCompaction!.setResults([nativeResult("d-overflow")]);

		await harness.session.prompt("overflow lifecycle turn");

		const checkpoint = harness.sessionManager.getEntries().find((entry) => entry.type === "remote_compaction");
		const firstOverflow = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("D_FIRST_OVERFLOW"),
			);
		expect(checkpoint).toMatchObject({
			type: "remote_compaction",
			excludedEntryIds: firstOverflow ? [firstOverflow.id] : [],
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.faux.nativeCompaction!.state.compactCallCount).toBe(1);
		expect(harness.events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(harness.events.filter((event) => event.type === "compaction_end")).toEqual([
			expect.objectContaining({ reason: "overflow", result: expect.any(Object), willRetry: true }),
			expect.objectContaining({
				reason: "overflow",
				result: undefined,
				willRetry: false,
				errorCode: "capacity",
			}),
		]);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("D_FIRST_OVERFLOW");
		expect(JSON.stringify(harness.faux.nativeCompaction!.state.compactCalls[0]?.context.messages)).not.toContain(
			"D_FIRST_OVERFLOW",
		);
		await expectSafeExternalOutputs(harness.sessionManager, harness.events, [`${OPAQUE_PREFIX}:d-overflow`]);
	});

	it("Scenario E: branch clones and forks resume different leaves without reading siblings", async () => {
		const harness = await createFauxLifecycleHarness({ provider: "lifecycle-e-branch", persistent: true });
		harness.faux.nativeCompaction!.setResults([nativeResult("e-shared")]);
		await harness.session.compact({ requestedStrategy: "remote" });
		const commonId = harness.sessionManager.appendMessage({
			role: "user",
			content: "shared after remote",
			timestamp: 3,
		});
		const leafA = harness.sessionManager.appendMessage({ role: "user", content: "BRANCH_A_ONLY", timestamp: 4 });
		harness.sessionManager.branch(commonId);
		const leafB = harness.sessionManager.appendMessage({ role: "user", content: "BRANCH_B_ONLY", timestamp: 5 });
		const sourceFile = harness.sessionManager.getSessionFile();
		expect(sourceFile).toBeDefined();

		const sourceA = WritableSessionManager.open(sourceFile!, harness.tempDir, harness.tempDir);
		const cloneAFile = sourceA.createBranchedSession(leafA);
		const sourceB = WritableSessionManager.open(sourceFile!, harness.tempDir, harness.tempDir);
		const cloneBFile = sourceB.createBranchedSession(leafB);
		expect(cloneAFile).toBeDefined();
		expect(cloneBFile).toBeDefined();
		const forkADir = createTempDirectory("pi-remote-lifecycle-fork-a-");
		const forkBDir = createTempDirectory("pi-remote-lifecycle-fork-b-");
		const forkA = WritableSessionManager.forkFrom(cloneAFile!, forkADir, forkADir, { id: "lifecycle-fork-a" });
		const forkB = WritableSessionManager.forkFrom(cloneBFile!, forkBDir, forkBDir, { id: "lifecycle-fork-b" });
		harness.faux.setResponses([fauxAssistantMessage("branch A resumed"), fauxAssistantMessage("branch B resumed")]);
		const resumedA = await createAgentSession({
			cwd: forkADir,
			modelRuntime: harness.runtime,
			model: harness.model,
			sessionManager: forkA,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		const resumedB = await createAgentSession({
			cwd: forkBDir,
			modelRuntime: harness.runtime,
			model: harness.model,
			sessionManager: forkB,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(
			() => resumedA.session.dispose(),
			() => resumedB.session.dispose(),
		);
		await resumedA.session.prompt("continue branch A");
		await resumedB.session.prompt("continue branch B");

		const branchA = JSON.stringify(forkA.getBranch());
		const branchB = JSON.stringify(forkB.getBranch());
		expect(branchA).toContain("BRANCH_A_ONLY");
		expect(branchA).not.toContain("BRANCH_B_ONLY");
		expect(branchB).toContain("BRANCH_B_ONLY");
		expect(branchB).not.toContain("BRANCH_A_ONLY");
		expect(forkA.buildSessionContext().providerContext).toBeDefined();
		expect(forkB.buildSessionContext().providerContext).toBeDefined();
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.faux.nativeCompaction!.state.compactCallCount).toBe(1);
		await expectSafeExternalOutputs(forkA, [], [`${OPAQUE_PREFIX}:e-shared`, "BRANCH_B_ONLY"]);
		await expectSafeExternalOutputs(forkB, [], [`${OPAQUE_PREFIX}:e-shared`, "BRANCH_A_ONLY"]);
	});

	it("Scenario F: binding changes block before Provider dispatch while same-account OAuth refresh remains usable", async () => {
		const mutableAuth = { key: "key-a" };
		const mutableEndpoint = { value: "https://binding.example.test/v1/responses/compact" };
		const publicModels: [Model<"openai-responses">, Model<"openai-responses">] = [
			{
				id: "binding-model-a",
				name: "Binding A",
				api: "openai-responses",
				provider: "lifecycle-f-public",
				baseUrl: "https://binding.example.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 1_000,
			},
			{
				id: "binding-model-b",
				name: "Binding B",
				api: "openai-responses",
				provider: "lifecycle-f-public",
				baseUrl: "https://binding.example.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 1_000,
			},
		];
		let compactCalls = 0;
		let consumerCalls = 0;
		const publicStreams: ProviderStreams<"openai-responses"> = {
			stream: () => {
				throw new Error("Provider stream must not dispatch");
			},
			streamSimple: () => {
				throw new Error("Provider stream must not dispatch");
			},
			compact: async (request) => {
				compactCalls++;
				return {
					providerContext: {
						format: "openai-responses-compaction",
						version: 1,
						binding: request.binding,
						items: [{ type: "compaction", encrypted_content: `${OPAQUE_PREFIX}:f-public` }],
					},
				};
			},
			canConsumeProviderContext: async () => {
				consumerCalls++;
				return true;
			},
			resolveNativeCompactionRoutes: () => ({
				primary: { endpoint: mutableEndpoint.value, protocol: "openai-responses-compact" },
				fallbacks: [],
			}),
		};
		const publicRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		publicRuntime.registerNativeProvider(
			createProvider({
				id: "lifecycle-f-public",
				auth: {
					apiKey: {
						name: "Mutable offline key",
						resolve: async () => ({ auth: { apiKey: mutableAuth.key }, source: "offline test" }),
					},
				},
				models: publicModels,
				api: publicStreams,
			}),
		);
		await publicRuntime.refresh({ allowNetwork: false });
		const compacted = await publicRuntime.compact(publicModels[0], { messages: [] });
		expect(compactCalls).toBe(1);

		mutableAuth.key = "key-b";
		await expect(
			publicRuntime.assertCanConsumeProviderContext(publicModels[0], compacted.providerContext),
		).rejects.toMatchObject({
			code: "binding_mismatch",
			bindingDimension: "credential",
		});
		mutableAuth.key = "key-a";
		mutableEndpoint.value = "https://other.example.test/v1/responses/compact";
		await expect(
			publicRuntime.assertCanConsumeProviderContext(publicModels[0], compacted.providerContext),
		).rejects.toMatchObject({
			code: "binding_mismatch",
			bindingDimension: "endpoint",
		});
		mutableEndpoint.value = "https://binding.example.test/v1/responses/compact";
		await expect(
			publicRuntime.assertCanConsumeProviderContext(publicModels[1], compacted.providerContext),
		).rejects.toMatchObject({
			code: "binding_mismatch",
			bindingDimension: "model",
		});
		expect(compactCalls).toBe(1);
		expect(consumerCalls).toBe(0);

		const oauthCredentials = AuthStorage.inMemory();
		await oauthCredentials.modify("lifecycle-f-oauth", async () => ({
			type: "oauth",
			access: "expired-token-a",
			refresh: "offline-refresh",
			expires: 0,
			accountId: "account-a",
		}));
		let refreshCalls = 0;
		let oauthCompactCalls = 0;
		let oauthConsumerCalls = 0;
		const oauth: OAuthAuth = {
			name: "Offline OAuth",
			login: async () => {
				throw new Error("Offline lifecycle must not login");
			},
			refresh: async () => {
				refreshCalls++;
				return {
					type: "oauth",
					access: "refreshed-token-a",
					refresh: "offline-refresh",
					expires: Date.now() + 60 * 60 * 1_000,
					accountId: "account-a",
				};
			},
			getStableSubject: async (credential) =>
				typeof credential.accountId === "string" ? credential.accountId : undefined,
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const oauthModel: Model<"openai-codex-responses"> = {
			id: "oauth-binding-model",
			name: "OAuth binding",
			api: "openai-codex-responses",
			provider: "lifecycle-f-oauth",
			baseUrl: "https://chatgpt.example.test/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};
		const oauthStreams: ProviderStreams<"openai-codex-responses"> = {
			stream: () => {
				throw new Error("Provider stream must not dispatch");
			},
			streamSimple: () => {
				throw new Error("Provider stream must not dispatch");
			},
			compact: async (request) => {
				oauthCompactCalls++;
				return compactedResult(request.binding, `${OPAQUE_PREFIX}:f-oauth`);
			},
			canConsumeProviderContext: async () => {
				oauthConsumerCalls++;
				return true;
			},
			resolveNativeCompactionRoutes: () => ({
				primary: {
					endpoint: "https://chatgpt.example.test/backend-api/codex/responses",
					protocol: "openai-codex-remote-v2",
				},
				fallbacks: [],
			}),
		};
		const oauthRuntime = await ModelRuntime.create({
			credentials: oauthCredentials,
			modelsPath: null,
			allowModelNetwork: false,
		});
		oauthRuntime.registerNativeProvider(
			createProvider({
				id: "lifecycle-f-oauth",
				auth: { oauth },
				models: [oauthModel],
				api: oauthStreams,
			}),
		);
		await oauthRuntime.refresh({ allowNetwork: false });
		refreshCalls = 0;
		const oauthCompacted = await oauthRuntime.compact(oauthModel, { messages: [] });
		expect(refreshCalls).toBe(1);
		expect(oauthCompactCalls).toBe(1);
		await oauthCredentials.modify("lifecycle-f-oauth", async () => ({
			type: "oauth",
			access: "rotated-token-a",
			refresh: "rotated-refresh-a",
			expires: Date.now() + 60 * 60 * 1_000,
			accountId: "account-a",
		}));
		await expect(
			oauthRuntime.assertCanConsumeProviderContext(oauthModel, oauthCompacted.providerContext),
		).resolves.toBeUndefined();
		expect(oauthConsumerCalls).toBe(1);
		await oauthCredentials.modify("lifecycle-f-oauth", async () => ({
			type: "oauth",
			access: "valid-token-b",
			refresh: "offline-refresh-b",
			expires: Date.now() + 60 * 60 * 1_000,
			accountId: "account-b",
		}));
		await expect(
			oauthRuntime.assertCanConsumeProviderContext(oauthModel, oauthCompacted.providerContext),
		).rejects.toMatchObject({
			code: "binding_mismatch",
			bindingDimension: "credential",
		});
		expect(oauthCompactCalls).toBe(1);
		expect(oauthConsumerCalls).toBe(1);
	});
});

function compactedResult(binding: ProviderContextBinding, encryptedContent: string): NativeCompactionResult {
	return {
		providerContext: {
			format: "openai-responses-compaction",
			version: 1,
			binding,
			items: [{ type: "compaction", encrypted_content: encryptedContent }],
		},
	};
}
