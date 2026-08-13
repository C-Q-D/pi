import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, type Model, type ProviderContextEnvelope } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { recoverRemoteContextToLocal } from "../src/core/compaction/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const OPAQUE_SENTINEL = "OPAQUE_PROVIDER_CONTEXT_MUST_NOT_REACH_LOCAL_SUMMARY";

function providerContext(model: Model<string>): ProviderContextEnvelope {
	return {
		format: "openai-responses-compaction",
		version: 1,
		binding: {
			provider: model.provider,
			api: "openai-responses",
			model: model.id,
			endpoint: "https://binding.example.test/v1/compact",
			format: "openai-responses-compaction",
			protocol: "openai-responses-compact",
			credentialScopeHash: "a".repeat(64),
		},
		items: [{ type: "compaction", encrypted_content: OPAQUE_SENTINEL }],
	};
}

function appendRemoteCheckpoint(sessionManager: SessionManager, model: Model<string>): void {
	sessionManager.appendRemoteCompaction({
		entryId: `remote-${sessionManager.getEntries().length}`,
		operationId: `operation-${sessionManager.getEntries().length}`,
		summary: "Remote checkpoint",
		tokensBefore: 100,
		providerContext: providerContext(model),
		metadata: {
			requestedStrategy: "remote",
			effectiveStrategy: "remote",
			tokensBefore: 100,
			experimental: true,
		},
	});
}

describe("Binding Guard and portable local recovery", () => {
	const cleanup: Array<() => void> = [];

	afterEach(() => {
		while (cleanup.length > 0) cleanup.pop()?.();
	});

	it("restores remote provider context and lets the exact SDK ModelRuntime wrapper continue", async () => {
		const faux = fauxProvider({ provider: "sdk-native", nativeCompaction: {} });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const model = faux.getModel() as Model<"openai-responses">;
		faux.nativeCompaction!.setResults([
			(request) => ({
				providerContext: {
					format: "openai-responses-compaction",
					version: 1,
					binding: request.binding,
					items: [{ type: "compaction", encrypted_content: OPAQUE_SENTINEL }],
				},
			}),
		]);
		const compacted = await runtime.compact(model, { messages: [] });
		await runtime.assertCanConsumeProviderContext(model, compacted.providerContext);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "raw history", timestamp: 1 });
		sessionManager.appendRemoteCompaction({
			entryId: "sdk-remote",
			operationId: "sdk-operation",
			summary: "Remote checkpoint",
			tokensBefore: 100,
			providerContext: compacted.providerContext,
			metadata: {
				requestedStrategy: "remote",
				effectiveStrategy: "remote",
				tokensBefore: 100,
				experimental: true,
			},
		});
		const { session } = await createAgentSession({
			modelRuntime: runtime,
			model,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		cleanup.push(() => session.dispose());
		faux.setResponses([fauxAssistantMessage("continued")]);

		await session.prompt("continue after remote checkpoint");

		expect(session.agent.state.providerContext).toEqual(compacted.providerContext);
		const lastMessage = session.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.errorMessage).toBeUndefined();
			expect(lastMessage.stopReason).toBe("stop");
		}
		expect(faux.nativeCompaction!.state.consumerCallCount).toBe(2);
		expect(faux.state.callCount).toBe(1);
		expect(session.messages.some((message) => message.role === "assistant")).toBe(true);
	});

	it("builds a local summary only from flat raw ancestry, commits once, clears provider context, and deep-clones", async () => {
		const faux = fauxProvider({ provider: "local-recovery" });
		const model = faux.getModel();
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "raw prefix ".repeat(100), timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("raw assistant"));
		appendRemoteCheckpoint(sessionManager, model);
		sessionManager.appendMessage({ role: "user", content: "raw tail", timestamp: 2 });
		let summarizationPayload = "";
		faux.setResponses([
			(context) => {
				summarizationPayload = JSON.stringify(context);
				return fauxAssistantMessage("portable local summary");
			},
		]);
		let replacement: AgentMessage[] | undefined;

		const result = await recoverRemoteContextToLocal({
			sessionManager,
			model,
			settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
			streamFn: faux.provider.streamSimple,
			replaceContext(messages) {
				replacement = messages;
			},
		});

		expect(result.summary).toContain("portable local summary");
		expect(summarizationPayload).toContain("raw prefix");
		expect(summarizationPayload).not.toContain(OPAQUE_SENTINEL);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(sessionManager.buildSessionContext().providerContext).toBeUndefined();
		expect(replacement).toBeDefined();
		expect(replacement?.some((message) => message.role === "compactionSummary")).toBe(true);

		const storedBeforeMutation = structuredClone(sessionManager.buildSessionContext().messages);
		if (replacement?.[0]?.role === "compactionSummary") replacement[0].summary = "mutated replacement";
		expect(sessionManager.buildSessionContext().messages).toEqual(storedBeforeMutation);
	});

	it("keeps the active remote checkpoint and Agent replacement untouched when local summarization fails", async () => {
		const faux = fauxProvider({ provider: "failed-recovery" });
		const model = faux.getModel();
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "raw prefix ".repeat(100), timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("raw assistant"));
		appendRemoteCheckpoint(sessionManager, model);
		sessionManager.appendMessage({ role: "user", content: "raw tail", timestamp: 2 });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic summarization failure" }),
		]);
		const entriesBefore = structuredClone(sessionManager.getEntries());
		let replacementCalls = 0;

		await expect(
			recoverRemoteContextToLocal({
				sessionManager,
				model,
				settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
				streamFn: faux.provider.streamSimple,
				replaceContext() {
					replacementCalls++;
				},
			}),
		).rejects.toThrow("Summarization failed");
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
		expect(sessionManager.buildSessionContext().providerContext).toBeDefined();
		expect(replacementCalls).toBe(0);
	});

	it("restores the active remote branch when Agent context replacement fails after summarization", async () => {
		const faux = fauxProvider({ provider: "failed-replacement" });
		const model = faux.getModel();
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "raw prefix ".repeat(100), timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("raw assistant"));
		appendRemoteCheckpoint(sessionManager, model);
		sessionManager.appendMessage({ role: "user", content: "raw tail", timestamp: 2 });
		faux.setResponses([fauxAssistantMessage("successful local summary")]);
		const activeBranchBefore = structuredClone(sessionManager.getBranch());
		const activeContextBefore = structuredClone(sessionManager.buildSessionContext());

		await expect(
			recoverRemoteContextToLocal({
				sessionManager,
				model,
				settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
				streamFn: faux.provider.streamSimple,
				replaceContext() {
					throw new Error("synthetic replacement failure");
				},
			}),
		).rejects.toThrow("synthetic replacement failure");

		expect(sessionManager.getBranch()).toEqual(activeBranchBefore);
		expect(sessionManager.buildSessionContext()).toEqual(activeContextBefore);
		expect(sessionManager.buildSessionContext().providerContext).toBeDefined();
		expect(sessionManager.buildContextEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
