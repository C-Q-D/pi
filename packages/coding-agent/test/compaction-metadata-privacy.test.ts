/**
 * 压缩元数据外部边界的离线隐私回归测试。
 *
 * 测试用不同 Sentinel 模拟 Provider Context、Endpoint、Credential、请求体、响应体和错误文本，
 * 并验证 TUI、Tree、RPC 形状、Extension 事件形状与 HTML Export 的最终输出都不包含它们。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { NativeCompactionError } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
	createExternalSessionEntries,
	createExternalSessionTree,
	createSanitizedCompactionEntry,
	createSanitizedCompactionResult,
	type ExternalSessionEntry,
	sanitizeCompactionError,
} from "../src/core/compaction/index.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CompactionSummaryMessage } from "../src/core/messages.ts";
import {
	createReadonlySessionManager,
	type SessionEntry,
	SessionManager,
	type SessionTreeNode,
} from "../src/core/session-manager.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** 每类禁止公开的数据使用不同 Sentinel，便于确认具体泄漏来源。 */
const FORBIDDEN_SENTINELS = [
	"SENTINEL_ENCRYPTED_CONTENT",
	"SENTINEL_ENDPOINT",
	"SENTINEL_CREDENTIAL_HASH",
	"c".repeat(64),
	"SENTINEL_REQUEST_BODY",
	"SENTINEL_RESPONSE_BODY",
	"SENTINEL_PROVIDER_ERROR",
] as const;

/** 每个测试创建的临时目录，结束后统一删除。 */
const temporaryDirectories: string[] = [];

/** 构造包含允许字段和所有禁止字段的 Future Remote Entry。 */
function createSyntheticRemoteEntry(): Record<string, unknown> {
	return {
		type: "remote_compaction",
		id: "remote-entry-1",
		parentId: "parent-entry-1",
		timestamp: "2026-08-13T00:00:00.000Z",
		summary: "保留给用户查看的本地摘要",
		tokensBefore: 12_345,
		estimatedTokensAfter: 2_345,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 127,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			providerResponse: "SENTINEL_RESPONSE_BODY",
		},
		metadata: {
			attemptId: "attempt-1",
			operationId: "operation-1",
			reason: "overflow",
			requestedStrategy: "auto",
			effectiveStrategy: "remote",
			protocol: "openai-responses-compact",
			provider: "openai",
			model: "gpt-test",
			fallbackCode: "capacity",
			credentialScopeHash: "SENTINEL_CREDENTIAL_HASH",
			resolvedEndpoint: "SENTINEL_ENDPOINT",
			requestBody: "SENTINEL_REQUEST_BODY",
		},
		providerContext: {
			items: [{ type: "compaction", encrypted_content: "SENTINEL_ENCRYPTED_CONTENT" }],
		},
		providerResponse: "SENTINEL_RESPONSE_BODY",
		providerError: "SENTINEL_PROVIDER_ERROR",
	};
}

/** 构造能被 Session v4 Reader 接受的真实 Remote Entry，并在所有私有位置放入 Sentinel。 */
function createRealRemoteEntry(): Record<string, unknown> {
	return {
		type: "remote_compaction",
		id: "remote-entry-1",
		parentId: "parent-entry-1",
		timestamp: "2026-08-13T00:00:00.000Z",
		operationId: "operation-1",
		summary: "保留给用户查看的本地摘要",
		firstKeptEntryId: "remote-entry-1",
		tokensBefore: 12_345,
		estimatedTokensAfter: 2_345,
		usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
		providerContext: {
			format: "openai-responses-compaction",
			version: 1,
			binding: {
				provider: "openai",
				api: "openai-responses",
				model: "gpt-test",
				endpoint: "https://SENTINEL_ENDPOINT.example/v1/responses/compact",
				format: "openai-responses-compaction",
				protocol: "openai-responses-compact",
				credentialScopeHash: "c".repeat(64),
			},
			items: [{ type: "compaction", encrypted_content: "SENTINEL_ENCRYPTED_CONTENT" }],
		},
		metadata: {
			attemptId: "attempt-1",
			operationId: "operation-1",
			reason: "overflow",
			requestedStrategy: "auto",
			effectiveStrategy: "remote",
			protocol: "openai-responses-compact",
			provider: "openai",
			model: "gpt-test",
			tokensBefore: 12_345,
			estimatedTokensAfter: 2_345,
			requestBody: "SENTINEL_REQUEST_BODY",
			experimental: true,
		},
		providerResponse: "SENTINEL_RESPONSE_BODY",
		providerError: "SENTINEL_PROVIDER_ERROR",
	};
}

/** 断言最终序列化输出不包含任何禁止 Sentinel。 */
function expectNoForbiddenSentinel(value: unknown): void {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	for (const sentinel of FORBIDDEN_SENTINELS) {
		expect(serialized).not.toContain(sentinel);
	}
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("压缩 Metadata Privacy Gate", () => {
	test("公共 Entry 类型不接受带 Provider Context 的原始远端 Entry", () => {
		const rawRemoteEntry = {
			...createSanitizedCompactionEntry(createSyntheticRemoteEntry()),
			providerContext: {
				items: [{ type: "compaction", encrypted_content: "SENTINEL_ENCRYPTED_CONTENT" }],
			},
		};
		// @ts-expect-error 原始远端 Entry 必须先经过白名单 Builder，不能直接作为公共 Entry。
		const externalEntry: ExternalSessionEntry = rawRemoteEntry;
		expect(externalEntry).toBe(rawRemoteEntry);
	});

	test("统一 Builder 只复制白名单并保留本地摘要", () => {
		const source = createSyntheticRemoteEntry();
		const entry = createSanitizedCompactionEntry(source);
		const result = createSanitizedCompactionResult(source);

		expect(entry).toEqual(
			expect.objectContaining({
				type: "remote_compaction",
				id: "remote-entry-1",
				summary: "保留给用户查看的本地摘要",
				tokensBefore: 12_345,
			}),
		);
		expect(entry.metadata).toEqual(
			expect.objectContaining({
				attemptId: "attempt-1",
				operationId: "operation-1",
				reason: "overflow",
				requestedStrategy: "auto",
				effectiveStrategy: "remote",
				protocol: "openai-responses-compact",
				provider: "openai",
				model: "gpt-test",
				fallbackCode: "capacity",
				experimental: true,
			}),
		);
		expect(Object.keys(entry.metadata).sort()).toEqual(
			[
				"attemptId",
				"effectiveStrategy",
				"errorCode",
				"estimatedTokensAfter",
				"experimental",
				"fallbackCode",
				"model",
				"operationId",
				"protocol",
				"provider",
				"reason",
				"requestedStrategy",
				"tokensBefore",
				"usage",
			].sort(),
		);
		expect(result.summary).toBe("保留给用户查看的本地摘要");
		expect(result.usage).toEqual({
			input: 100,
			output: 20,
			cacheRead: 3,
			cacheWrite: 4,
			cacheWrite1h: undefined,
			reasoning: undefined,
			totalTokens: 127,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		});
		expect(Object.isFrozen(entry)).toBe(true);
		expect(Object.isFrozen(entry.metadata)).toBe(true);
		expectNoForbiddenSentinel(entry);
		expectNoForbiddenSentinel(result);
	});

	test("RPC 与 Extension 的最终 JSON 形状只包含净化后的压缩 DTO", () => {
		const source = createSyntheticRemoteEntry();
		const entries = createExternalSessionEntries([source as unknown as SessionEntry]);
		const tree = createExternalSessionTree([
			{ entry: source as unknown as SessionEntry, children: [] },
		] as SessionTreeNode[]);
		const result = createSanitizedCompactionResult(source);
		const rpcResponses = [
			{ type: "response", command: "compact", success: true, data: result },
			{ type: "response", command: "get_entries", success: true, data: { entries, leafId: "remote-entry-1" } },
			{ type: "response", command: "get_tree", success: true, data: { tree, leafId: "remote-entry-1" } },
		];
		const extensionEvents = [
			{ type: "session_before_compact", branchEntries: entries },
			{ type: "session_compact", compactionEntry: createSanitizedCompactionEntry(source) },
		];

		expectNoForbiddenSentinel(rpcResponses);
		expectNoForbiddenSentinel(extensionEvents);
		expect(JSON.stringify(rpcResponses)).toContain("operation-1");
		expect(JSON.stringify(extensionEvents)).toContain("保留给用户查看的本地摘要");
	});

	test("真实 v4 Entry 通过 Parse、Reload、Build、TUI、RPC、Extension 与 HTML 全边界", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-real-remote-privacy-"));
		temporaryDirectories.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		const outputPath = join(directory, "session.html");
		writeFileSync(
			sessionPath,
			`${[
				JSON.stringify({
					type: "session",
					version: 4,
					id: "real-privacy-session",
					timestamp: "2026-08-13T00:00:00.000Z",
					cwd: directory,
				}),
				JSON.stringify({
					type: "message",
					id: "parent-entry-1",
					parentId: null,
					timestamp: "2026-08-13T00:00:01.000Z",
					message: { role: "user", content: "raw ancestor", timestamp: 1 },
				}),
				JSON.stringify(createRealRemoteEntry()),
				JSON.stringify({
					type: "message",
					id: "after-remote",
					parentId: "remote-entry-1",
					timestamp: "2026-08-13T00:00:02.000Z",
					message: { role: "user", content: "after remote", timestamp: 2 },
				}),
			].join("\n")}\n`,
			"utf8",
		);

		const session = SessionManager.open(sessionPath, directory, directory);
		const internalContext = session.buildSessionContext();
		expect(JSON.stringify(internalContext.providerContext)).toContain("SENTINEL_ENCRYPTED_CONTENT");
		expect(internalContext.messages).toEqual([{ role: "user", content: "after remote", timestamp: 2 }]);

		const rawRemote = session.getEntry("remote-entry-1");
		expect(rawRemote).toBeDefined();
		const extensionSessionManager = createReadonlySessionManager(session);
		const extensionSessionOutputs = [
			extensionSessionManager.getEntry("remote-entry-1"),
			extensionSessionManager.getLeafEntry(),
			extensionSessionManager.getBranch(),
			extensionSessionManager.buildContextEntries(),
			extensionSessionManager.getEntries(),
			extensionSessionManager.getTree(),
		];
		const entries = createExternalSessionEntries(session.getEntries());
		const tree = createExternalSessionTree(session.getTree());
		const sanitizedEntry = createSanitizedCompactionEntry(rawRemote);
		const rpcResponses = [
			{ type: "response", command: "get_entries", success: true, data: { entries, leafId: session.getLeafId() } },
			{ type: "response", command: "get_tree", success: true, data: { tree, leafId: session.getLeafId() } },
		];
		const extensionEvents = [
			{ type: "session_before_compact", branchEntries: entries },
			{ type: "session_compact", compactionEntry: sanitizedEntry },
		];

		const summaryMessage = {
			role: "compactionSummary",
			summary: sanitizedEntry.summary,
			tokensBefore: sanitizedEntry.tokensBefore,
			timestamp: 1,
			details: rawRemote,
		} as CompactionSummaryMessage;
		const summaryComponent = new CompactionSummaryMessageComponent(summaryMessage);
		summaryComponent.setExpanded(true);
		const summaryOutput = summaryComponent.render(100).map(stripVTControlCharacters).join("\n");
		const selector = new TreeSelectorComponent(
			session.getTree(),
			"after-remote",
			24,
			() => {},
			() => {},
		);
		const treeOutput = selector.render(100).map(stripVTControlCharacters).join("\n");

		await exportFromFile(sessionPath, { outputPath });
		const html = readFileSync(outputPath, "utf8");
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		const sessionData = Buffer.from(encoded ?? "", "base64").toString("utf8");

		expectNoForbiddenSentinel(entries);
		expectNoForbiddenSentinel(extensionSessionOutputs);
		expectNoForbiddenSentinel(tree);
		expectNoForbiddenSentinel(rpcResponses);
		expectNoForbiddenSentinel(extensionEvents);
		expectNoForbiddenSentinel(summaryOutput);
		expectNoForbiddenSentinel(treeOutput);
		expectNoForbiddenSentinel(selector.getTreeList().getSelectedNode());
		expectNoForbiddenSentinel(sessionData);
		expect(sessionData).toContain("operation-1");
		expect(sessionData).toContain("保留给用户查看的本地摘要");
	});

	test("TUI 摘要组件与 Tree 只渲染安全摘要和 Token 信息", () => {
		const source = createSyntheticRemoteEntry();
		const message = {
			role: "compactionSummary",
			summary: "保留给用户查看的本地摘要",
			tokensBefore: 12_345,
			timestamp: 1,
			details: source,
		} as CompactionSummaryMessage;
		const summaryComponent = new CompactionSummaryMessageComponent(message);
		summaryComponent.setExpanded(true);
		const summaryOutput = summaryComponent.render(100).map(stripVTControlCharacters).join("\n");

		const tree = [{ entry: source as unknown as SessionEntry, children: [] }] as SessionTreeNode[];
		const selector = new TreeSelectorComponent(
			tree,
			"remote-entry-1",
			24,
			() => {},
			() => {},
		);
		const treeOutput = selector.render(100).map(stripVTControlCharacters).join("\n");

		expect(summaryOutput).toContain("保留给用户查看的本地摘要");
		expect(treeOutput).toContain("remote compaction");
		expectNoForbiddenSentinel(summaryOutput);
		expectNoForbiddenSentinel(treeOutput);
		expectNoForbiddenSentinel(selector.getTreeList().getSelectedNode());
	});

	test("HTML Export 的 Base64 Session Data 不包含原始远端 Payload", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-compaction-privacy-"));
		temporaryDirectories.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		const outputPath = join(directory, "session.html");
		const header = {
			type: "session",
			version: 4,
			id: "privacy-session",
			timestamp: "2026-08-13T00:00:00.000Z",
			cwd: directory,
		};
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(createRealRemoteEntry())}\n`, "utf8");

		await exportFromFile(sessionPath, { outputPath });
		const html = readFileSync(outputPath, "utf8");
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		expect(encoded).toBeDefined();
		const sessionData = Buffer.from(encoded ?? "", "base64").toString("utf8");

		expect(sessionData).toContain("保留给用户查看的本地摘要");
		expect(sessionData).toContain("operation-1");
		expectNoForbiddenSentinel(sessionData);
	});

	test("错误边界保留固定错误码但不复制 Provider 错误文本", () => {
		const unknownError = sanitizeCompactionError(new Error("SENTINEL_PROVIDER_ERROR"));
		const nativeError = sanitizeCompactionError(new NativeCompactionError("protocol"));
		const localError = sanitizeCompactionError(new Error("Already compacted"));
		const repeatedError = sanitizeCompactionError(nativeError);
		const output = [
			{ code: unknownError.code, message: unknownError.message, stack: unknownError.stack },
			{ code: nativeError.code, message: nativeError.message, stack: nativeError.stack },
			{ code: localError.code, message: localError.message, stack: localError.stack },
			{ code: repeatedError.code, message: repeatedError.message, stack: repeatedError.stack },
		];

		expect(output).toEqual([
			{ code: "unknown", message: "Compaction failed.", stack: undefined },
			{ code: "protocol", message: "Remote compaction protocol is incompatible.", stack: undefined },
			{ code: "already_compacted", message: "The current context is already compacted.", stack: undefined },
			{ code: "protocol", message: "Remote compaction protocol is incompatible.", stack: undefined },
		]);
		expectNoForbiddenSentinel(output);
	});

	test("Accessor 不会在白名单复制时执行", () => {
		let accessCount = 0;
		const source = Object.defineProperty(createSyntheticRemoteEntry(), "provider", {
			enumerable: true,
			get: () => {
				accessCount += 1;
				return "SENTINEL_PROVIDER_ERROR";
			},
		});

		const result = createSanitizedCompactionResult(source);

		expect(accessCount).toBe(0);
		expect(result.metadata.provider).toBe("openai");
		expectNoForbiddenSentinel(result);
	});

	test("一万二千层的 Session Tree 通过迭代 Privacy Gate", () => {
		let child: SessionTreeNode | undefined;
		for (let index = 11_999; index >= 0; index--) {
			const id = `entry-${index}`;
			const entry: SessionEntry = {
				type: "session_info",
				id,
				parentId: index === 0 ? null : `entry-${index - 1}`,
				timestamp: "2026-08-13T00:00:00.000Z",
				name: `node-${index}`,
			};
			child = { entry, children: child ? [child] : [] };
		}
		const tree = child ? [child] : [];

		const externalTree = createExternalSessionTree(tree);
		const selector = new TreeSelectorComponent(
			tree,
			"entry-11999",
			24,
			() => {},
			() => {},
			undefined,
			"entry-11999",
			"all",
		);

		expect(externalTree[0]?.entry.id).toBe("entry-0");
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe("entry-11999");
	});
});
