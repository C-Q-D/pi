import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createSanitizedCompactionResult } from "../src/core/compaction/index.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type RpcRecord = Record<string, unknown>;

function parsedOutput(): RpcRecord[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RpcRecord);
}

async function send(command: RpcRecord): Promise<RpcRecord> {
	rpcIo.lineHandler?.(JSON.stringify(command));
	await vi.waitFor(() => {
		expect(parsedOutput().some((record) => record.id === command.id && record.type === "response")).toBe(true);
	});
	return parsedOutput().find((record) => record.id === command.id && record.type === "response")!;
}

describe("RPC compaction strategy", () => {
	const originalSigtermListeners = new Set(process.listeners("SIGTERM"));
	const originalInputEndListeners = new Set(process.stdin.listeners("end"));
	const settingsManager = SettingsManager.inMemory();
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

	beforeAll(async () => {
		const session = {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			agent: { subscribe: vi.fn(() => () => {}) },
			model: undefined,
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			sessionFile: undefined,
			sessionId: "rpc-strategy-session",
			sessionName: undefined,
			autoCompactionEnabled: true,
			get compactionStrategy() {
				return settingsManager.getCompactionStrategy();
			},
			messages: [],
			pendingMessageCount: 0,
			setCompactionStrategy: (strategy: "local" | "remote" | "auto") =>
				settingsManager.setCompactionStrategy(strategy),
			compact,
		};
		const runtimeHost = {
			session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {}),
		} as unknown as AgentSessionRuntime;

		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	});

	afterAll(() => {
		for (const listener of process.listeners("SIGTERM")) {
			if (!originalSigtermListeners.has(listener)) process.off("SIGTERM", listener);
		}
		for (const listener of process.stdin.listeners("end")) {
			if (!originalInputEndListeners.has(listener)) process.stdin.off("end", listener as () => void);
		}
	});

	it("returns, sets, and runtime-validates the persistent strategy", async () => {
		expect(await send({ id: "state-local", type: "get_state" })).toMatchObject({
			success: true,
			data: { compactionStrategy: "local" },
		});
		expect(await send({ id: "set-auto", type: "set_compaction_strategy", strategy: "auto" })).toMatchObject({
			success: true,
		});
		expect(await send({ id: "state-auto", type: "get_state" })).toMatchObject({
			success: true,
			data: { compactionStrategy: "auto" },
		});

		expect(await send({ id: "set-invalid", type: "set_compaction_strategy", strategy: "surprise" })).toMatchObject({
			success: false,
			error: "Invalid compaction strategy",
		});
		expect(settingsManager.getCompactionStrategy()).toBe("auto");
	});

	it.each([null, 123, { unexpected: true }])(
		"rejects invalid compact instructions %j before calling the Session",
		async (customInstructions) => {
			compact.mockClear();

			const response = await send({
				id: `compact-invalid-${JSON.stringify(customInstructions)}`,
				type: "compact",
				customInstructions,
			});

			expect(response).toMatchObject({ success: false, error: "Invalid compact customInstructions" });
			expect(compact).not.toHaveBeenCalled();
		},
	);

	it("distinguishes configured optionless compact from legacy string instructions, including empty text", async () => {
		compact.mockClear();

		await send({ id: "compact-configured", type: "compact" });
		await send({ id: "compact-empty-legacy", type: "compact", customInstructions: "" });

		expect(compact.mock.calls).toEqual([[undefined], [""]]);
	});
});
