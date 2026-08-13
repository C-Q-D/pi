import { describe, expect, it } from "vitest";
import { getHandoffMessages } from "../examples/extensions/handoff.ts";
import { createCompactionMetadata } from "../src/core/compaction/metadata.ts";
import { createReadonlySessionManager, SessionManager } from "../src/core/session-manager.ts";

const PAYLOAD_SENTINEL = "HANDOFF_PROVIDER_PAYLOAD_SENTINEL";

describe("handoff remote compaction", () => {
	it("uses the privacy-safe portable raw ancestry before and after a remote checkpoint", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "before remote", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "before response" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const providerContext = {
			format: "openai-responses-compaction" as const,
			version: 1 as const,
			binding: {
				provider: "openai",
				api: "openai-responses",
				model: "gpt-test",
				endpoint: "https://api.openai.com/v1/responses/compact",
				format: "openai-responses-compaction" as const,
				protocol: "openai-responses-compact" as const,
				credentialScopeHash: "e".repeat(64),
			},
			items: [{ type: "compaction", encrypted_content: PAYLOAD_SENTINEL }],
		};
		const metadata = createCompactionMetadata({
			type: "remote_compaction",
			operationId: "handoff-operation",
			requestedStrategy: "remote",
			effectiveStrategy: "remote",
			tokensBefore: 40,
			experimental: true,
		});
		session.appendRemoteCompaction({
			entryId: "handoff-remote",
			operationId: "handoff-operation",
			summary: "remote checkpoint",
			tokensBefore: 40,
			providerContext,
			metadata,
		});
		session.appendMessage({ role: "user", content: "after remote", timestamp: 3 });

		const messages = getHandoffMessages(createReadonlySessionManager(session));
		const serialized = JSON.stringify(messages);
		expect(serialized).toContain("before remote");
		expect(serialized).toContain("before response");
		expect(serialized).toContain("after remote");
		expect(serialized).not.toContain("remote checkpoint");
		expect(serialized).not.toContain(PAYLOAD_SENTINEL);
	});

	it("keeps the latest local summary when an older remote checkpoint remains in the kept suffix", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "discarded raw history", timestamp: 1 });
		const providerContext = {
			format: "openai-responses-compaction" as const,
			version: 1 as const,
			binding: {
				provider: "openai",
				api: "openai-responses",
				model: "gpt-test",
				endpoint: "https://api.openai.com/v1/responses/compact",
				format: "openai-responses-compaction" as const,
				protocol: "openai-responses-compact" as const,
				credentialScopeHash: "f".repeat(64),
			},
			items: [{ type: "compaction", encrypted_content: PAYLOAD_SENTINEL }],
		};
		session.appendRemoteCompaction({
			entryId: "older-remote",
			operationId: "older-remote-operation",
			summary: "older remote checkpoint",
			tokensBefore: 30,
			providerContext,
			metadata: createCompactionMetadata({
				type: "remote_compaction",
				operationId: "older-remote-operation",
				requestedStrategy: "remote",
				effectiveStrategy: "remote",
				tokensBefore: 30,
				experimental: true,
			}),
		});
		const keptId = session.appendMessage({ role: "user", content: "kept after remote", timestamp: 2 });
		session.appendCompaction("latest local summary", "older-remote", 40);
		session.appendMessage({ role: "user", content: "tail after local", timestamp: 3 });

		const messages = getHandoffMessages(createReadonlySessionManager(session));
		const serialized = JSON.stringify(messages);
		expect(messages[0]).toMatchObject({ role: "compactionSummary", summary: "latest local summary" });
		expect(serialized).not.toContain("discarded raw history");
		expect(serialized).toContain("kept after remote");
		expect(serialized).toContain("tail after local");
		expect(serialized).not.toContain("older remote checkpoint");
		expect(serialized).not.toContain(PAYLOAD_SENTINEL);
		expect(session.getEntry(keptId)).toBeDefined();
	});
});
