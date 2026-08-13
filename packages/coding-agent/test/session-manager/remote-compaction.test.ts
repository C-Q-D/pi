import type { Message, ProviderContextEnvelope } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { createCompactionMetadata } from "../../src/core/compaction/metadata.ts";
import {
	buildPortableRawEntries,
	CURRENT_SESSION_VERSION,
	type RemoteCompactionEntry,
	SessionContextError,
	SessionManager,
} from "../../src/core/session-manager.ts";

const CREDENTIAL_SCOPE_HASH = "a".repeat(64);
const ORIGINAL_SENTINEL = "REMOTE_SESSION_PAYLOAD_SENTINEL";
const MUTATED_SENTINEL = "MUTATED_AFTER_APPEND";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirectories.push(directory);
	return directory;
}

function createProviderContext(sentinel = ORIGINAL_SENTINEL, model = "gpt-test") {
	return {
		format: "openai-responses-compaction" as const,
		version: 1 as const,
		binding: {
			provider: "openai",
			api: "openai-responses",
			model,
			endpoint: "https://api.openai.com/v1/responses/compact",
			format: "openai-responses-compaction" as const,
			protocol: "openai-responses-compact" as const,
			credentialScopeHash: CREDENTIAL_SCOPE_HASH,
		},
		items: [{ type: "compaction", encrypted_content: sentinel }],
	};
}

function createRemoteMetadata(operationId: string, providerContext: ProviderContextEnvelope, tokensBefore = 120) {
	return createCompactionMetadata({
		type: "remote_compaction",
		attemptId: `attempt-${operationId}`,
		operationId,
		reason: "manual",
		requestedStrategy: "remote",
		effectiveStrategy: "remote",
		protocol: providerContext.binding.protocol,
		provider: providerContext.binding.provider,
		model: providerContext.binding.model,
		tokensBefore,
		estimatedTokensAfter: 24,
		usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
		experimental: true,
	});
}

function createLocalMetadata(operationId: string, tokensBefore = 120) {
	return createCompactionMetadata({
		type: "compaction",
		attemptId: `attempt-${operationId}`,
		operationId,
		reason: "manual",
		requestedStrategy: "local",
		effectiveStrategy: "local",
		tokensBefore,
		experimental: true,
	});
}

function assistantMessage(text: string, stopReason: "stop" | "error" = "stop"): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason,
		...(stopReason === "error" ? { errorMessage: "prompt is too long" } : {}),
		timestamp: 2,
	};
}

function appendConversationPrefix(session: SessionManager): { userId: string; assistantId: string } {
	const userId = session.appendMessage({ role: "user", content: "before remote", timestamp: 1 });
	const assistantId = session.appendMessage(assistantMessage("before remote response"));
	return { userId, assistantId };
}

function appendRemote(
	session: SessionManager,
	entryId: string,
	operationId: string,
	providerContext = createProviderContext(),
): RemoteCompactionEntry {
	return session.appendRemoteCompaction({
		entryId,
		operationId,
		timestamp: "2026-08-13T00:00:00.000Z",
		summary: "Remote context checkpoint",
		tokensBefore: 120,
		estimatedTokensAfter: 24,
		usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
		providerContext,
		metadata: createRemoteMetadata(operationId, providerContext),
	});
}

/** 构造可用于 JSONL Resume 的 Local 或 Remote Overflow 排除图。 */
function createExclusionFixtureEntries(
	directory: string,
	checkpointType: "local" | "remote",
	excludedEntryId: string,
): object[] {
	const providerContext = createProviderContext("EXCLUSION_AUDIT_SENTINEL");
	const checkpoint =
		checkpointType === "local"
			? {
					type: "compaction",
					id: "checkpoint",
					parentId: "trigger-assistant",
					timestamp: "2026-08-13T00:00:04.000Z",
					operationId: "operation-exclusion",
					summary: "local summary",
					firstKeptEntryId: "root-user",
					tokensBefore: 120,
					metadata: createLocalMetadata("operation-exclusion"),
					excludedEntryIds: [excludedEntryId],
				}
			: {
					type: "remote_compaction",
					id: "checkpoint",
					parentId: "trigger-assistant",
					timestamp: "2026-08-13T00:00:04.000Z",
					operationId: "operation-exclusion",
					summary: "remote checkpoint",
					firstKeptEntryId: "checkpoint",
					tokensBefore: 120,
					providerContext,
					metadata: createRemoteMetadata("operation-exclusion", providerContext),
					excludedEntryIds: [excludedEntryId],
				};
	return [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: `${checkpointType}-exclusion-session`,
			timestamp: "2026-08-13T00:00:00.000Z",
			cwd: directory,
		},
		{
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-08-13T00:00:01.000Z",
			message: { role: "user", content: "audit user", timestamp: 1 },
		},
		{
			type: "message",
			id: "trigger-assistant",
			parentId: "root-user",
			timestamp: "2026-08-13T00:00:02.000Z",
			message: assistantMessage("overflow audit trigger", "error"),
		},
		{
			type: "message",
			id: "sibling-assistant",
			parentId: "root-user",
			timestamp: "2026-08-13T00:00:03.000Z",
			message: assistantMessage("sibling overflow", "error"),
		},
		checkpoint,
		{
			type: "message",
			id: "descendant-user",
			parentId: "checkpoint",
			timestamp: "2026-08-13T00:00:05.000Z",
			message: { role: "user", content: "audit descendant", timestamp: 5 },
		},
	];
}

describe("remote compaction session v4", () => {
	it("reads the committed static v4 fixture as an active provider context", () => {
		const fixturePath = fileURLToPath(new URL("../fixtures/remote-compaction-v4/valid-entry.jsonl", import.meta.url));
		const session = SessionManager.open(fixturePath, undefined, "/fixture/project");

		expect(session.getBranch().map((entry) => entry.id)).toEqual([
			"fixture-before",
			"fixture-remote",
			"fixture-after",
		]);
		expect(session.findByOperationId("fixture-operation")).toMatchObject({
			id: "fixture-remote",
			firstKeptEntryId: "fixture-remote",
		});
		expect(session.buildSessionContext()).toMatchObject({
			messages: [{ role: "user", content: "fixture suffix", timestamp: 2 }],
			providerContext: {
				binding: { model: "gpt-fixture" },
				items: [{ type: "compaction", encrypted_content: "STATIC_V4_PROVIDER_PAYLOAD" }],
			},
		});
	});

	it("persists, reloads, and deep-clones a real remote entry without sending its summary", () => {
		const directory = createTempDirectory("pi-remote-session-");
		const session = SessionManager.create(directory, directory, { id: "remote-roundtrip" });
		appendConversationPrefix(session);
		const providerContext = createProviderContext();
		const entry = appendRemote(session, "remote-entry", "operation-roundtrip", providerContext);
		session.appendMessage({ role: "user", content: "after remote", timestamp: 3 });

		providerContext.items[0].encrypted_content = MUTATED_SENTINEL;
		const firstContext = session.buildSessionContext();
		const secondContext = session.buildSessionContext();
		expect(firstContext.messages).toEqual([{ role: "user", content: "after remote", timestamp: 3 }]);
		expect(firstContext.messages).not.toContainEqual(expect.objectContaining({ summary: entry.summary }));
		expect(firstContext.providerContext?.items[0]).toEqual({
			type: "compaction",
			encrypted_content: ORIGINAL_SENTINEL,
		});
		expect(firstContext.providerContext).not.toBe(entry.providerContext);
		expect(firstContext.providerContext).not.toBe(secondContext.providerContext);
		expect(firstContext.providerContext?.items).not.toBe(secondContext.providerContext?.items);
		expect(Object.isFrozen(firstContext.providerContext)).toBe(true);
		expect(Object.isFrozen(firstContext.providerContext?.items[0])).toBe(true);

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(readFileSync(sessionFile!, "utf8")).toContain(ORIGINAL_SENTINEL);
		expect(readFileSync(sessionFile!, "utf8")).not.toContain(MUTATED_SENTINEL);

		const reopened = SessionManager.open(sessionFile!, directory, directory);
		const reopenedEntry = reopened.findByOperationId("operation-roundtrip");
		expect(reopened.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
		expect(reopenedEntry).toMatchObject({
			id: "remote-entry",
			firstKeptEntryId: "remote-entry",
			operationId: "operation-roundtrip",
			usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 },
		});
		expect(reopened.buildSessionContext().providerContext?.items[0]).toEqual({
			type: "compaction",
			encrypted_content: ORIGINAL_SENTINEL,
		});
	});

	it("returns the committed remote entry only when operation and entry identities both match", () => {
		const session = SessionManager.inMemory();
		appendConversationPrefix(session);
		const committed = appendRemote(session, "remote-first", "operation-stable");
		const leafAfterCommit = session.getLeafId();
		const duplicate = appendRemote(
			session,
			"remote-first",
			"operation-stable",
			createProviderContext("SHOULD_NOT_BE_COMMITTED"),
		);

		expect(duplicate).toBe(committed);
		expect(() => appendRemote(session, "remote-duplicate", "operation-stable")).toThrow();
		expect(session.getLeafId()).toBe(leafAfterCommit);
		expect(session.getEntries().filter((entry) => entry.type === "remote_compaction")).toHaveLength(1);
		expect(session.getEntry("remote-duplicate")).toBeUndefined();
	});

	it("returns the committed local entry only when operation and entry identities both match", () => {
		const session = SessionManager.inMemory();
		const { userId } = appendConversationPrefix(session);
		const options = {
			entryId: "local-first",
			operationId: "operation-local-stable",
			timestamp: "2026-08-13T00:00:00.000Z",
			summary: "Local checkpoint",
			firstKeptEntryId: userId,
			tokensBefore: 120,
			metadata: createLocalMetadata("operation-local-stable"),
		};
		const committed = session.appendCompactionTransaction(options);
		const leafAfterCommit = session.getLeafId();

		expect(session.appendCompactionTransaction(options)).toBe(committed);
		expect(() => session.appendCompactionTransaction({ ...options, entryId: "local-duplicate" })).toThrow();
		expect(session.getLeafId()).toBe(leafAfterCommit);
		expect(session.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(session.getEntry("local-duplicate")).toBeUndefined();
	});

	it("rolls back in-memory state when the session append fails", () => {
		const directory = createTempDirectory("pi-remote-append-failure-");
		const session = SessionManager.create(directory, directory, { id: "remote-append-failure" });
		appendConversationPrefix(session);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const previousLeafId = session.getLeafId();
		const previousEntryCount = session.getEntries().length;
		rmSync(sessionFile);
		mkdirSync(sessionFile);

		expect(() => appendRemote(session, "remote-failed", "operation-failed")).toThrow();
		expect(session.getLeafId()).toBe(previousLeafId);
		expect(session.getEntries()).toHaveLength(previousEntryCount);
		expect(session.findByOperationId("operation-failed")).toBeUndefined();
	});

	it("uses whichever local or remote checkpoint is latest on the active branch", () => {
		const session = SessionManager.inMemory();
		const { userId } = appendConversationPrefix(session);
		session.appendCompaction("local before remote", userId, 100);
		appendRemote(session, "remote-one", "operation-one", createProviderContext("REMOTE_ONE"));
		const afterFirstRemote = session.appendMessage({ role: "user", content: "between remotes", timestamp: 3 });
		appendRemote(session, "remote-two", "operation-two", createProviderContext("REMOTE_TWO", "gpt-test-2"));
		session.appendMessage({ role: "user", content: "after second remote", timestamp: 4 });

		const remoteContext = session.buildSessionContext();
		expect(remoteContext.messages).toEqual([{ role: "user", content: "after second remote", timestamp: 4 }]);
		expect(remoteContext.providerContext?.binding.model).toBe("gpt-test-2");

		session.appendCompaction("local after remote", afterFirstRemote, 80);
		const localContext = session.buildSessionContext();
		expect(localContext.providerContext).toBeUndefined();
		expect(localContext.messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "user"]);
		expect(localContext.messages[1]).toMatchObject({ content: "between remotes" });
		expect(localContext.messages[2]).toMatchObject({ content: "after second remote" });
	});

	it("builds one flat portable raw ancestry and excludes checkpoints, siblings, and selected entries", () => {
		const session = SessionManager.inMemory();
		const { userId, assistantId } = appendConversationPrefix(session);
		appendRemote(session, "remote-portable", "operation-portable");
		const customDetails = { nested: { value: "original" } };
		const customId = session.appendCustomMessageEntry("portable-note", "custom message", false, customDetails);
		const branchSummaryId = session.branchWithSummary(customId, "branch facts", { source: "abandoned" });
		const excludedId = session.appendMessage(assistantMessage("overflow trigger result", "error"));
		const keptId = session.appendMessage({ role: "user", content: "kept tail", timestamp: 5 });

		const portable = session.buildPortableRawEntries(new Set([excludedId]));
		expect(portable.map((entry) => entry.id)).toEqual([userId, assistantId, customId, branchSummaryId, keptId]);
		expect(portable.map((entry) => entry.parentId)).toEqual([null, userId, assistantId, customId, branchSummaryId]);
		expect(portable.find((entry) => entry.id === branchSummaryId)).toMatchObject({ fromId: customId });
		expect(JSON.stringify(portable)).not.toContain(ORIGINAL_SENTINEL);
		expect(portable.some((entry) => entry.type === "compaction" || entry.type === "remote_compaction")).toBe(false);

		const portableCustom = portable.find((entry) => entry.id === customId);
		if (portableCustom?.type !== "custom_message") throw new Error("Expected portable custom message");
		const clonedDetails = portableCustom.details as { nested: { value: string } };
		clonedDetails.nested.value = "mutated portable copy";
		expect(customDetails.nested.value).toBe("original");

		session.branch(assistantId);
		const siblingId = session.appendMessage({ role: "user", content: "sibling", timestamp: 6 });
		expect(session.buildPortableRawEntries().map((entry) => entry.id)).toEqual([userId, assistantId, siblingId]);

		const functionResult = buildPortableRawEntries(session.getEntries(), keptId);
		expect(functionResult.map((entry) => entry.id)).toContain(keptId);
		expect(functionResult.map((entry) => entry.id)).not.toContain(siblingId);
	});

	it("preserves valid remote entries across resume, branch clone, and fork without sharing payload identity", () => {
		const sourceDirectory = createTempDirectory("pi-remote-source-");
		const forkDirectory = createTempDirectory("pi-remote-fork-");
		mkdirSync(forkDirectory, { recursive: true });
		const session = SessionManager.create(sourceDirectory, sourceDirectory, { id: "remote-source" });
		appendConversationPrefix(session);
		const sourceRemote = appendRemote(session, "remote-shared", "operation-shared");
		const leafId = session.appendMessage({ role: "user", content: "selected leaf", timestamp: 3 });
		const sourceFile = session.getSessionFile();
		expect(sourceFile).toBeDefined();

		const resumed = SessionManager.open(sourceFile!, sourceDirectory, sourceDirectory);
		expect(resumed.getBranch().map((entry) => entry.id)).toEqual([
			expect.any(String),
			expect.any(String),
			"remote-shared",
			leafId,
		]);
		expect(resumed.buildSessionContext().providerContext?.items[0]).toEqual(sourceRemote.providerContext.items[0]);

		const clonedFile = session.createBranchedSession(leafId);
		expect(clonedFile).toBeDefined();
		const clonedRemote = session.findByOperationId("operation-shared");
		expect(clonedRemote?.providerContext).not.toBe(sourceRemote.providerContext);
		expect(session.buildSessionContext().messages).toEqual([
			{ role: "user", content: "selected leaf", timestamp: 3 },
		]);

		const forked = SessionManager.forkFrom(sourceFile!, forkDirectory, forkDirectory, { id: "remote-fork" });
		const forkedRemote = forked.findByOperationId("operation-shared");
		expect(forkedRemote?.parentId).toBe(sourceRemote.parentId);
		expect(forkedRemote?.providerContext).not.toBe(sourceRemote.providerContext);
		expect(forked.buildSessionContext().providerContext?.items[0]).toEqual(sourceRemote.providerContext.items[0]);
	});

	it("blocks a malformed current remote entry while keeping portable raw ancestry recoverable", () => {
		const directory = createTempDirectory("pi-invalid-remote-");
		const sessionFile = join(directory, "invalid.jsonl");
		const invalidProviderContext = { ...createProviderContext("INVALID_REMOTE_SENTINEL"), unexpected: true };
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "invalid-remote-session",
					timestamp: "2026-08-13T00:00:00.000Z",
					cwd: directory,
				}),
				JSON.stringify({
					type: "message",
					id: "raw-before",
					parentId: null,
					timestamp: "2026-08-13T00:00:01.000Z",
					message: { role: "user", content: "raw before", timestamp: 1 },
				}),
				JSON.stringify({
					type: "remote_compaction",
					id: "invalid-remote",
					parentId: "raw-before",
					timestamp: "2026-08-13T00:00:02.000Z",
					operationId: "operation-invalid",
					summary: "must not be sent",
					firstKeptEntryId: "invalid-remote",
					tokensBefore: 20,
					providerContext: invalidProviderContext,
					metadata: { requestedStrategy: "remote", effectiveStrategy: "remote", experimental: true },
				}),
				JSON.stringify({
					type: "message",
					id: "raw-after",
					parentId: "invalid-remote",
					timestamp: "2026-08-13T00:00:03.000Z",
					message: { role: "user", content: "raw after", timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		const session = SessionManager.open(sessionFile, directory, directory);
		let contextError: unknown;
		try {
			session.buildSessionContext();
		} catch (error) {
			contextError = error;
		}
		expect(contextError).toBeInstanceOf(SessionContextError);
		expect(contextError).toMatchObject({ code: "invalid_remote_compaction" });
		expect(String(contextError)).not.toContain("INVALID_REMOTE_SENTINEL");
		expect(JSON.stringify(session.getEntry("invalid-remote"))).not.toContain("INVALID_REMOTE_SENTINEL");
		expect(session.buildPortableRawEntries()).toEqual([
			expect.objectContaining({ id: "raw-before", parentId: null }),
			expect.objectContaining({ id: "raw-after", parentId: "raw-before" }),
		]);
		expect(readFileSync(sessionFile, "utf8")).toContain("INVALID_REMOTE_SENTINEL");
	});

	it("does not downgrade a current remote entry with a missing identity to an unknown entry", () => {
		const directory = createTempDirectory("pi-missing-remote-id-");
		const sessionFile = join(directory, "missing-id.jsonl");
		const providerContext = createProviderContext("MISSING_ID_SENTINEL");
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "missing-id-session",
					timestamp: "2026-08-13T00:00:00.000Z",
					cwd: directory,
				}),
				JSON.stringify({
					type: "message",
					id: "raw-prefix",
					parentId: null,
					timestamp: "2026-08-13T00:00:01.000Z",
					message: { role: "user", content: "recoverable prefix", timestamp: 1 },
				}),
				JSON.stringify({
					type: "remote_compaction",
					parentId: "raw-prefix",
					timestamp: "2026-08-13T00:00:02.000Z",
					operationId: "operation-missing-id",
					summary: "invalid identity",
					firstKeptEntryId: "planned-remote-id",
					tokensBefore: 20,
					providerContext,
					metadata: createRemoteMetadata("operation-missing-id", providerContext, 20),
				}),
				JSON.stringify({
					type: "message",
					id: "raw-suffix",
					parentId: "planned-remote-id",
					timestamp: "2026-08-13T00:00:03.000Z",
					message: { role: "user", content: "recoverable suffix", timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		const session = SessionManager.open(sessionFile, directory, directory);
		expect(() => session.buildSessionContext()).toThrowError(SessionContextError);
		const invalidEntry = session.getEntries().find((entry) => entry.type === "remote_compaction");
		expect(invalidEntry).toMatchObject({ id: "planned-remote-id", invalid: true, errorCode: "invalid_context" });
		expect(JSON.stringify(invalidEntry)).not.toContain("MISSING_ID_SENTINEL");
		expect(
			session
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		).toEqual(["raw-prefix", "raw-suffix"]);
		expect(session.buildPortableRawEntries().map((entry) => entry.id)).toEqual(["raw-prefix", "raw-suffix"]);
	});

	it("does not let an invalid remote sibling poison a clean selected branch", () => {
		const directory = createTempDirectory("pi-invalid-remote-sibling-");
		const sessionFile = join(directory, "invalid-sibling.jsonl");
		const invalidProviderContext = { ...createProviderContext("INVALID_SIBLING_SENTINEL"), unexpected: true };
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "invalid-sibling-session",
					timestamp: "2026-08-13T00:00:00.000Z",
					cwd: directory,
				}),
				JSON.stringify({
					type: "message",
					id: "sibling-root",
					parentId: null,
					timestamp: "2026-08-13T00:00:01.000Z",
					message: { role: "user", content: "shared root", timestamp: 1 },
				}),
				JSON.stringify({
					type: "remote_compaction",
					id: "invalid-sibling",
					parentId: "sibling-root",
					timestamp: "2026-08-13T00:00:02.000Z",
					operationId: "operation-invalid-sibling",
					summary: "invalid sibling",
					firstKeptEntryId: "invalid-sibling",
					tokensBefore: 20,
					providerContext: invalidProviderContext,
				}),
				JSON.stringify({
					type: "message",
					id: "clean-leaf",
					parentId: "sibling-root",
					timestamp: "2026-08-13T00:00:03.000Z",
					message: { role: "user", content: "clean branch", timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		const session = SessionManager.open(sessionFile, directory, directory);
		expect(session.buildSessionContext()).toMatchObject({
			messages: [
				{ role: "user", content: "shared root", timestamp: 1 },
				{ role: "user", content: "clean branch", timestamp: 2 },
			],
		});
		session.branch("invalid-sibling");
		expect(() => session.buildSessionContext()).toThrowError(SessionContextError);
	});

	it.each([
		{ checkpointType: "local" as const, target: "root-user", caseName: "user entry" },
		{ checkpointType: "local" as const, target: "sibling-assistant", caseName: "sibling entry" },
		{ checkpointType: "local" as const, target: "descendant-user", caseName: "descendant entry" },
		{ checkpointType: "local" as const, target: "unknown-entry", caseName: "unknown entry" },
		{ checkpointType: "remote" as const, target: "root-user", caseName: "user entry" },
		{ checkpointType: "remote" as const, target: "sibling-assistant", caseName: "sibling entry" },
		{ checkpointType: "remote" as const, target: "descendant-user", caseName: "descendant entry" },
		{ checkpointType: "remote" as const, target: "unknown-entry", caseName: "unknown entry" },
	])("rejects a corrupted $checkpointType exclusion targeting a $caseName", ({ checkpointType, target }) => {
		const directory = createTempDirectory(`pi-${checkpointType}-exclusion-corruption-`);
		const sessionFile = join(directory, "corrupted-exclusion.jsonl");
		const entries = createExclusionFixtureEntries(directory, checkpointType, target);
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(sessionFile, directory, directory);
		expect(() => session.buildSessionContext()).toThrowError(SessionContextError);
		expect(() => session.buildPortableRawEntries()).toThrowError(SessionContextError);
		const rawFile = readFileSync(sessionFile, "utf8");
		expect(rawFile).toContain("audit user");
		expect(rawFile).toContain("overflow audit trigger");
		expect(rawFile).toContain("audit descendant");
	});

	it.each(["local", "remote"] as const)(
		"resumes a valid %s overflow exclusion while preserving the raw error record",
		(checkpointType) => {
			const directory = createTempDirectory(`pi-${checkpointType}-valid-exclusion-`);
			const sessionFile = join(directory, "valid-exclusion.jsonl");
			const entries = createExclusionFixtureEntries(directory, checkpointType, "trigger-assistant");
			writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			const session = SessionManager.open(sessionFile, directory, directory);
			const context = session.buildSessionContext();
			expect(JSON.stringify(context.messages)).not.toContain("overflow audit trigger");
			expect(session.buildPortableRawEntries().map((entry) => entry.id)).toEqual(["root-user", "descendant-user"]);
			expect(readFileSync(sessionFile, "utf8")).toContain("overflow audit trigger");
		},
	);

	it.each([
		{
			name: "self cycle",
			entries: (providerContext: ProviderContextEnvelope) => [
				{
					type: "remote_compaction",
					id: "remote-cycle",
					parentId: "remote-cycle",
					timestamp: "2026-08-13T00:00:01.000Z",
					operationId: "operation-cycle",
					summary: "cycle",
					firstKeptEntryId: "remote-cycle",
					tokensBefore: 20,
					providerContext,
					metadata: createRemoteMetadata("operation-cycle", providerContext, 20),
				},
			],
		},
		{
			name: "multi-node cycle",
			entries: (providerContext: ProviderContextEnvelope) => [
				{
					type: "remote_compaction",
					id: "remote-cycle",
					parentId: "message-cycle",
					timestamp: "2026-08-13T00:00:01.000Z",
					operationId: "operation-cycle",
					summary: "cycle",
					firstKeptEntryId: "remote-cycle",
					tokensBefore: 20,
					providerContext,
					metadata: createRemoteMetadata("operation-cycle", providerContext, 20),
				},
				{
					type: "message",
					id: "message-cycle",
					parentId: "remote-cycle",
					timestamp: "2026-08-13T00:00:02.000Z",
					message: { role: "user", content: "cycle tail", timestamp: 2 },
				},
			],
		},
		{
			name: "orphan remote",
			entries: (providerContext: ProviderContextEnvelope) => [
				{
					type: "remote_compaction",
					id: "remote-cycle",
					parentId: "missing-parent",
					timestamp: "2026-08-13T00:00:01.000Z",
					operationId: "operation-cycle",
					summary: "orphan",
					firstKeptEntryId: "remote-cycle",
					tokensBefore: 20,
					providerContext,
					metadata: createRemoteMetadata("operation-cycle", providerContext, 20),
				},
			],
		},
	])("rejects a $name without hanging or returning provider context", ({ entries }) => {
		const directory = createTempDirectory("pi-invalid-remote-graph-");
		const sessionFile = join(directory, "invalid-graph.jsonl");
		const providerContext = createProviderContext("INVALID_GRAPH_SENTINEL");
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: "invalid-graph-session",
					timestamp: "2026-08-13T00:00:00.000Z",
					cwd: directory,
				}),
				...entries(providerContext).map((entry) => JSON.stringify(entry)),
			].join("\n")}\n`,
		);

		const session = SessionManager.open(sessionFile, directory, directory);
		expect(() => session.buildSessionContext()).toThrowError(SessionContextError);
		expect(() => session.buildPortableRawEntries()).toThrowError(SessionContextError);
	});
});
