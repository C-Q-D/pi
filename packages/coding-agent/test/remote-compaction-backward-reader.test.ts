import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/remote-compaction-backward-reader/", import.meta.url));

function openFixture(name: string): SessionManager {
	const fixturePath = fileURLToPath(
		new URL(name, new URL("./fixtures/remote-compaction-backward-reader/", import.meta.url)),
	);
	return SessionManager.open(fixturePath, fixtureDirectory, fixtureDirectory);
}

describe("remote compaction backward reader", () => {
	it("accepts a higher session version and recovers raw history across an unknown entry", () => {
		const session = openFixture("no-local-compaction.jsonl");

		expect(session.getHeader()?.version).toBe(4);
		expect(session.getBranch().map((entry) => [entry.id, entry.type])).toEqual([
			["raw-before", "message"],
			["remote-raw", "remote_compaction"],
			["raw-after", "message"],
		]);
		expect(session.buildSessionContext().messages).toEqual([
			{ role: "user", content: "raw before remote", timestamp: 1 },
			{ role: "user", content: "raw after remote", timestamp: 2 },
		]);
	});

	it("keeps the latest local compaction fallback and messages after the unknown entry", () => {
		const session = openFixture("latest-local-compaction.jsonl");

		expect(session.buildContextEntries().map((entry) => entry.id)).toEqual([
			"latest-local",
			"kept-by-latest",
			"remote-after-local",
			"message-after-remote",
		]);
		expect(session.buildSessionContext().messages).toEqual([
			{
				role: "compactionSummary",
				summary: "latest local summary",
				tokensBefore: 42,
				timestamp: Date.parse("2025-01-01T00:00:04.000Z"),
			},
			{ role: "user", content: "kept by latest local compaction", timestamp: 2 },
			{ role: "user", content: "message after remote compaction", timestamp: 3 },
		]);
	});

	it.each([
		{
			name: "fork",
			fixture: "fork-leaf-ancestry.jsonl",
			expectedIds: ["fork-root", "fork-remote", "fork-leaf"],
			expectedMessages: ["fork root", "fork selected leaf"],
		},
		{
			name: "clone",
			fixture: "clone-leaf-ancestry.jsonl",
			expectedIds: ["clone-root", "clone-remote", "clone-leaf"],
			expectedMessages: ["clone root", "clone selected leaf"],
		},
	])("follows only the selected $name leaf ancestry", ({ fixture, expectedIds, expectedMessages }) => {
		const session = openFixture(fixture);

		expect(session.getBranch().map((entry) => entry.id)).toEqual(expectedIds);
		expect(session.buildSessionContext().messages).toEqual(
			expectedMessages.map((content, index) => ({ role: "user", content, timestamp: index * 2 + 1 })),
		);
	});

	// 旧 Reader 会索引未知 Entry 以保留父链，但消息转换的默认分支会返回空数组。
	// 因此回退版本既能越过未来的远端记录恢复祖先消息，也不会把未知载荷发送给模型。
	it("retains the unknown parent chain without projecting its payload into context", () => {
		const session = openFixture("no-local-compaction.jsonl");
		const remoteEntry = session.getEntry("remote-raw");

		expect(remoteEntry?.parentId).toBe("raw-before");
		expect(session.getEntry("raw-after")?.parentId).toBe("remote-raw");
		expect(session.buildSessionContext().messages).not.toContainEqual(
			expect.objectContaining({ encrypted_content: "fixture-only" }),
		);
	});
});
