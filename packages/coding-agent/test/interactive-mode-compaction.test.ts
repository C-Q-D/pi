import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createSanitizedCompactionResult } from "../src/core/compaction/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { RemoteCompactionEntry } from "../src/core/session-manager.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { InteractiveMode, parseCompactCommandArguments } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("/compact strategy arguments", () => {
	test.each([
		[undefined, {}],
		["", {}],
		["focus on decisions", { requestedStrategy: "local", customInstructions: "focus on decisions" }],
		["focus on --remote behavior", { requestedStrategy: "local", customInstructions: "focus on --remote behavior" }],
		["--local", { requestedStrategy: "local" }],
		["--local focus on decisions", { requestedStrategy: "local", customInstructions: "focus on decisions" }],
		["--local -- --remote is text", { requestedStrategy: "local", customInstructions: "--remote is text" }],
		["-- --remote is text", { requestedStrategy: "local", customInstructions: "--remote is text" }],
		["--remote", { requestedStrategy: "remote" }],
		["--remote --", { requestedStrategy: "remote" }],
	])("parses %j without changing legacy Local instructions", (input, options) => {
		expect(parseCompactCommandArguments(input)).toEqual({ ok: true, options });
	});

	test.each(["--remote custom prompt", "--remote -- custom prompt", "--local --remote", "--remote --local"])(
		"rejects ambiguous or unsupported arguments %j",
		(input) => {
			expect(parseCompactCommandArguments(input)).toEqual({
				ok: false,
				error:
					input.startsWith("--remote") && !input.endsWith("--local")
						? "Remote compaction does not accept custom instructions."
						: "Choose only one compaction strategy.",
			});
		},
	);

	test.each(["--unknown", "--local --unknown"])("rejects unknown leading flags %j", (input) => {
		expect(parseCompactCommandArguments(input)).toEqual({
			ok: false,
			error: "Usage: /compact [--local [instructions] | --remote | instructions]",
		});
	});

	test("does not start a Session attempt when parsing fails", async () => {
		const fakeThis = {
			clearStatusIndicator: vi.fn(),
			showError: vi.fn(),
			session: { compact: vi.fn() },
		};
		const handleCompactCommand = Reflect.get(InteractiveMode.prototype, "handleCompactCommand") as (
			this: typeof fakeThis,
			argumentsText?: string,
		) => Promise<void>;

		await handleCompactCommand.call(fakeThis, "--remote custom prompt");

		expect(fakeThis.session.compact).not.toHaveBeenCalled();
		expect(fakeThis.showError).toHaveBeenCalledWith("Remote compaction does not accept custom instructions.");
	});

	test.each([
		["", {}],
		["--remote", { requestedStrategy: "remote" }],
		["--local focus on decisions", { requestedStrategy: "local", customInstructions: "focus on decisions" }],
		["legacy instructions", { requestedStrategy: "local", customInstructions: "legacy instructions" }],
	])("passes parsed arguments %j to the single AgentSession entry point", async (input, options) => {
		const fakeThis = {
			clearStatusIndicator: vi.fn(),
			showError: vi.fn(),
			session: { compact: vi.fn().mockResolvedValue(undefined) },
		};
		const handleCompactCommand = Reflect.get(InteractiveMode.prototype, "handleCompactCommand") as (
			this: typeof fakeThis,
			argumentsText?: string,
		) => Promise<void>;

		await handleCompactCommand.call(fakeThis, input);

		expect(fakeThis.session.compact).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.compact).toHaveBeenCalledWith(options);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("preserves empty legacy instructions through the Interactive shortcut facade", async () => {
		let markComplete: (() => void) | undefined;
		const completed = new Promise<void>((resolve) => {
			markComplete = resolve;
		});
		const compact = vi.fn().mockResolvedValue(
			createSanitizedCompactionResult({
				type: "compaction",
				summary: "local",
				tokensBefore: 10,
				metadata: {
					requestedStrategy: "local",
					effectiveStrategy: "local",
					tokensBefore: 10,
					experimental: true,
				},
			}),
		);
		const defaultEditor: { onExtensionShortcut?: (data: string) => void } = {};
		const fakeThis = {
			keybindings: { getEffectiveConfig: () => ({}) },
			sessionManager: {
				getCwd: () => "F:/tmp",
				getSessionDir: () => "F:/tmp",
				getSessionId: () => "session",
				getSessionFile: () => undefined,
				getLeafId: () => null,
				getLeafEntry: () => undefined,
				getEntry: () => undefined,
				getLabel: () => undefined,
				getBranch: () => [],
				buildContextEntries: () => [],
				buildPortableRawEntries: () => [],
				getHeader: () => null,
				getEntries: () => [],
				getTree: () => [],
				getSessionName: () => undefined,
			},
			createExtensionUIContext: () => ({}),
			session: {
				model: undefined,
				scopedModels: [],
				thinkingLevel: "medium",
				isIdle: true,
				agent: { signal: undefined },
				compact,
				getContextUsage: () => undefined,
				systemPrompt: "test",
			},
			settingsManager: { isProjectTrusted: () => true },
			restoreQueuedMessagesToEditor: vi.fn(),
			shutdownRequested: false,
			defaultEditor,
		};
		const extensionRunner = {
			getShortcuts: () =>
				new Map([
					[
						"ctrl+x",
						{
							handler: (ctx: { compact: (options: object) => void }) => {
								ctx.compact({ customInstructions: "", onComplete: () => markComplete?.() });
							},
						},
					],
				]),
			getModelRegistry: () => ({}),
		};
		const setupExtensionShortcuts = Reflect.get(InteractiveMode.prototype, "setupExtensionShortcuts") as (
			this: typeof fakeThis,
			runner: typeof extensionRunner,
		) => void;

		setupExtensionShortcuts.call(fakeThis, extensionRunner);
		defaultEditor.onExtensionShortcut?.("\x18");
		await completed;

		expect(compact).toHaveBeenCalledWith({ requestedStrategy: undefined, customInstructions: "" });
	});
});

describe("InteractiveMode compaction events", () => {
	test("rebuilds a successful compaction only from the committed Session entry", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addCompactionToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addCompactionToChat).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("renders one checkpoint component when rebuilding from one committed Remote entry", () => {
		const remoteEntry: RemoteCompactionEntry = {
			type: "remote_compaction",
			id: "remote-entry",
			parentId: "parent-entry",
			timestamp: "2026-08-13T00:00:00.000Z",
			operationId: "operation-1",
			summary: "IGNORED_REMOTE_SUMMARY",
			firstKeptEntryId: "remote-entry",
			tokensBefore: 123,
			providerContext: {
				format: "openai-responses-compaction",
				version: 1,
				binding: {
					provider: "openai",
					api: "openai-responses",
					model: "gpt-test",
					endpoint: "https://example.invalid/v1/responses/compact",
					format: "openai-responses-compaction",
					protocol: "openai-responses-compact",
					credentialScopeHash: "a".repeat(64),
				},
				items: [{ type: "compaction", encrypted_content: "PRIVATE_OPAQUE_PAYLOAD" }],
			},
			metadata: {
				attemptId: "attempt-1",
				operationId: "operation-1",
				reason: "manual",
				requestedStrategy: "remote",
				effectiveStrategy: "remote",
				protocol: "openai-responses-compact",
				provider: "openai",
				model: "gpt-test",
				tokensBefore: 123,
				experimental: true,
			},
		};
		const children: unknown[] = [];
		const fakeThis = {
			chatContainer: {
				clear: vi.fn(() => children.splice(0)),
				addChild: vi.fn((child: unknown) => children.push(child)),
			},
			pendingTools: new Map(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: {
				buildContextEntries: () => [remoteEntry],
				getEntries: () => [remoteEntry],
			},
			session: { modelRuntime: undefined },
			ui: { requestRender: vi.fn() },
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: () => undefined,
			addCompactionToChat: Reflect.get(InteractiveMode.prototype, "addCompactionToChat"),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
			renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
		};
		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
		) => void;

		rebuildChatFromMessages.call(fakeThis);

		expect(children.filter((child) => child instanceof CompactionSummaryMessageComponent)).toHaveLength(1);
	});

	test("projects a resumed Remote checkpoint into safe strategy metadata for TUI rendering", () => {
		const remoteEntry: RemoteCompactionEntry = {
			type: "remote_compaction",
			id: "remote-entry",
			parentId: "parent-entry",
			timestamp: "2026-08-13T00:00:00.000Z",
			operationId: "operation-1",
			summary: "",
			firstKeptEntryId: "remote-entry",
			tokensBefore: 12_345,
			estimatedTokensAfter: 2_345,
			providerContext: {
				format: "openai-responses-compaction",
				version: 1,
				binding: {
					provider: "openai",
					api: "openai-responses",
					model: "gpt-test",
					endpoint: "https://PRIVATE_ENDPOINT.example/v1/responses/compact",
					format: "openai-responses-compaction",
					protocol: "openai-responses-compact",
					credentialScopeHash: "a".repeat(64),
				},
				items: [{ type: "compaction", encrypted_content: "PRIVATE_OPAQUE_PAYLOAD" }],
			},
			metadata: {
				attemptId: "attempt-1",
				operationId: "operation-1",
				reason: "manual",
				requestedStrategy: "remote",
				effectiveStrategy: "remote",
				protocol: "openai-responses-compact",
				provider: "openai",
				model: "gpt-test",
				tokensBefore: 12_345,
				estimatedTokensAfter: 2_345,
				experimental: true,
			},
		};
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: RemoteCompactionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, [remoteEntry]);

		const items = fakeThis.renderSessionItems.mock.calls[0]?.[0];
		expect(items).toEqual([
			expect.objectContaining({
				kind: "compaction",
				result: expect.objectContaining({
					metadata: expect.objectContaining({
						requestedStrategy: "remote",
						effectiveStrategy: "remote",
						provider: "openai",
						model: "gpt-test",
						protocol: "openai-responses-compact",
					}),
				}),
			}),
		]);
		expect(JSON.stringify(items)).not.toContain("PRIVATE_OPAQUE_PAYLOAD");
		expect(JSON.stringify(items)).not.toContain("PRIVATE_ENDPOINT");
	});

	test("renders strategy, binding, token, and fallback metadata without a remote payload", () => {
		const result = createSanitizedCompactionResult({
			type: "compaction",
			summary: "portable local summary",
			tokensBefore: 12_345,
			metadata: {
				requestedStrategy: "auto",
				effectiveStrategy: "local",
				protocol: "openai-responses-compact",
				provider: "openai",
				model: "gpt-test",
				tokensBefore: 12_345,
				estimatedTokensAfter: 2_345,
				fallbackCode: "provider_error",
				experimental: true,
			},
		});
		const component = new CompactionSummaryMessageComponent(result);
		component.setExpanded(true);

		const output = component.render(100).map(stripVTControlCharacters).join("\n");

		expect(output).toContain("Requested: auto");
		expect(output).toContain("Effective: local");
		expect(output).toContain("Provider: openai");
		expect(output).toContain("Model: gpt-test");
		expect(output).toContain("Protocol: openai-responses-compact");
		expect(output).toContain("Compacted from 12,345 tokens");
		expect(output).toContain("Estimated after: 2,345 tokens");
		expect(output).toContain("Fallback: provider_error");
		expect(output).not.toContain("encrypted_content");
	});

	test("ignores a Remote pseudo-summary and renders the fixed opaque notice", () => {
		const result = createSanitizedCompactionResult({
			type: "remote_compaction",
			summary: "PRIVATE_FAKE_REMOTE_SUMMARY",
			tokensBefore: 10,
			metadata: {
				requestedStrategy: "remote",
				effectiveStrategy: "remote",
				tokensBefore: 10,
				experimental: true,
			},
		});
		const component = new CompactionSummaryMessageComponent(result);
		component.setExpanded(true);

		const output = component.render(100).map(stripVTControlCharacters).join("\n");

		expect(output).toContain("Opaque provider context (content is not readable).");
		expect(output).not.toContain("PRIVATE_FAKE_REMOTE_SUMMARY");
	});

	test("removes terminal controls from displayed Provider metadata", () => {
		const result = createSanitizedCompactionResult({
			type: "remote_compaction",
			summary: "",
			tokensBefore: 10,
			metadata: {
				requestedStrategy: "remote",
				effectiveStrategy: "remote",
				provider: "openai\nINJECTED\u001b[31m",
				model: "gpt-test\u001b]0;PRIVATE_TITLE\u0007",
				protocol: "openai-responses-compact\tPRIVATE_TAB",
				tokensBefore: 10,
				experimental: true,
			},
		});
		const component = new CompactionSummaryMessageComponent(result);
		component.setExpanded(true);

		const rendered = component.render(100).join("\n");

		expect(rendered).not.toContain("\u001b]0;PRIVATE_TITLE");
		expect(rendered).not.toContain("\u001b[31m");
		expect(stripVTControlCharacters(rendered)).toContain("Provider: openai INJECTED");
		expect(stripVTControlCharacters(rendered)).toContain("Protocol: openai-responses-compact PRIVATE_TAB");
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
