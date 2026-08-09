/** Provider 原生压缩纯数据契约的运行时回归测试。 */

import { describe, expect, it } from "vitest";
import {
	cloneAndFreezeJson,
	cloneAndFreezeProviderContext,
	createNativeCompactionError,
	NativeCompactionError,
	validateNativeCompactionResult,
} from "../src/index.ts";
import type { NativeCompactionErrorCode } from "../src/types.ts";

const SAFE_HASH = "a".repeat(64);
const SENTINEL = "native-compaction-sensitive-sentinel";

/** 创建一个可突变的合法 Provider Context 输入。 */
function createProviderContextInput(): Record<string, unknown> {
	return {
		format: "openai-responses-compaction",
		version: 1,
		binding: {
			provider: "openai",
			api: "openai-responses",
			model: "gpt-test",
			endpoint: "https://api.openai.com/v1",
			format: "openai-responses-compaction",
			protocol: "openai-responses-compact",
			credentialScopeHash: SAFE_HASH,
		},
		items: [{ type: "message", content: [{ type: "input_text", text: "" }] }],
	};
}

/** 断言回调抛出指定的固定安全错误码。 */
function expectNativeError(callback: () => unknown, code: NativeCompactionErrorCode): void {
	try {
		callback();
		expect.unreachable("预期抛出 NativeCompactionError");
	} catch (error) {
		expect(error).toBeInstanceOf(NativeCompactionError);
		expect((error as NativeCompactionError).code).toBe(code);
	}
}

describe("Provider Context JSON 契约", () => {
	it("深复制并冻结合法 JSON，同时允许普通空字符串", () => {
		const input = { text: "", nested: [{ value: 1 }] };
		const cloned = cloneAndFreezeJson(input);

		(input.nested[0] as { value: number }).value = 9;
		expect(cloned).toEqual({ text: "", nested: [{ value: 1 }] });
		expect(Object.isFrozen(cloned)).toBe(true);
		const clonedObject = cloned as { readonly nested: readonly { readonly value: number }[] };
		expect(Object.isFrozen(clonedObject.nested)).toBe(true);
		expect(Object.isFrozen(clonedObject.nested[0])).toBe(true);
	});

	it.each([
		["undefined", undefined],
		["function", () => undefined],
		["bigint", 1n],
		["symbol", Symbol("value")],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["Date", new Date()],
		["Map", new Map()],
		["Set", new Set()],
		["TypedArray", new Uint8Array([1])],
	])("拒绝非纯 JSON 值：%s", (_name, value) => {
		expectNativeError(() => cloneAndFreezeJson(value), "invalid_context");
	});

	it("拒绝循环引用和稀疏数组", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const sparse = new Array(2);
		sparse[1] = "value";

		expectNativeError(() => cloneAndFreezeJson(cyclic), "invalid_context");
		expectNativeError(() => cloneAndFreezeJson(sparse), "invalid_context");
	});

	it("拒绝 Accessor、非枚举字段、自定义 Prototype 和 Symbol Key", () => {
		const accessor: Record<string, unknown> = {};
		Object.defineProperty(accessor, "value", {
			enumerable: true,
			get() {
				throw new Error(SENTINEL);
			},
		});
		const nonEnumerable = { visible: true };
		Object.defineProperty(nonEnumerable, "hidden", { value: SENTINEL, enumerable: false });
		const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
		customPrototype.value = true;
		const symbolKey = { visible: true };
		Object.defineProperty(symbolKey, Symbol("hidden"), { value: SENTINEL, enumerable: true });

		for (const value of [accessor, nonEnumerable, customPrototype, symbolKey]) {
			expectNativeError(() => cloneAndFreezeJson(value), "invalid_context");
		}
	});

	it("把 Proxy Trap 抛出的原始异常或伪造安全错误统一净化", () => {
		const rawFailure = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error(SENTINEL);
				},
			},
		);
		const forgedFailure = new Proxy(
			{},
			{
				ownKeys() {
					throw createNativeCompactionError("provider_error");
				},
			},
		);
		const nestedProxyFailure = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error(SENTINEL);
				},
			},
		);
		const nestedFailure = new Proxy(
			{},
			{
				ownKeys() {
					throw nestedProxyFailure;
				},
			},
		);

		expectNativeError(() => cloneAndFreezeJson(rawFailure), "invalid_context");
		expectNativeError(() => cloneAndFreezeJson(forgedFailure), "invalid_context");
		expectNativeError(() => cloneAndFreezeJson(nestedFailure), "invalid_context");
	});

	it.each(["__proto__", "prototype", "constructor"])("全深度拒绝危险键：%s", (key) => {
		const value = JSON.parse(`{"nested":{"${key}":{"secret":"${SENTINEL}"}}}`) as unknown;
		expectNativeError(() => cloneAndFreezeJson(value), "invalid_context");
	});

	it("全深度拒绝 compaction_trigger", () => {
		const value = { nested: [{ type: "compaction_trigger", encrypted_content: SENTINEL }] };
		expectNativeError(() => cloneAndFreezeJson(value), "invalid_context");
	});
});

describe("Provider Context Envelope", () => {
	it("深复制并冻结 Envelope，且原始输入突变不影响结果", () => {
		const input = createProviderContextInput();
		const cloned = cloneAndFreezeProviderContext(input);
		const inputItems = input.items as Array<Record<string, unknown>>;
		inputItems[0].type = "changed";
		const binding = input.binding as Record<string, unknown>;
		binding.model = "changed-model";

		expect(cloned.binding.model).toBe("gpt-test");
		expect(cloned.items[0]).toMatchObject({ type: "message" });
		expect(Object.isFrozen(cloned)).toBe(true);
		expect(Object.isFrozen(cloned.binding)).toBe(true);
		expect(Object.isFrozen(cloned.items)).toBe(true);
	});

	it("拒绝 Envelope 顶层 protocol 和其他额外字段", () => {
		const input = createProviderContextInput();
		input.protocol = "openai-responses-compact";
		expectNativeError(() => cloneAndFreezeProviderContext(input), "invalid_context");
	});

	it.each([
		["错误 format", "format", "other", "protocol"],
		["错误 version", "version", 2, "protocol"],
	])("%s 使用固定 protocol 错误", (_name, key, value, code) => {
		const input = createProviderContextInput();
		input[key as string] = value;
		expectNativeError(() => cloneAndFreezeProviderContext(input), code as NativeCompactionErrorCode);
	});

	it("拒绝错误 Binding Protocol、空结构字段和非 SHA-256 Scope Hash", () => {
		const wrongProtocol = createProviderContextInput();
		(wrongProtocol.binding as Record<string, unknown>).protocol = "other";
		const emptyModel = createProviderContextInput();
		(emptyModel.binding as Record<string, unknown>).model = "";
		const wrongHash = createProviderContextInput();
		(wrongHash.binding as Record<string, unknown>).credentialScopeHash = "short";

		expectNativeError(() => cloneAndFreezeProviderContext(wrongProtocol), "protocol");
		expectNativeError(() => cloneAndFreezeProviderContext(emptyModel), "invalid_context");
		expectNativeError(() => cloneAndFreezeProviderContext(wrongHash), "invalid_context");
	});
});

describe("Native Compaction Result", () => {
	it("接受并冻结精确的公开 Usage", () => {
		const result = validateNativeCompactionResult({
			providerContext: createProviderContextInput(),
			usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
		});

		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.usage)).toBe(true);
	});

	it.each([
		["缺少字段", { inputTokens: 1, outputTokens: 2 }],
		["额外字段", { inputTokens: 1, outputTokens: 2, totalTokens: 3, details: {} }],
		["负数", { inputTokens: -1, outputTokens: 2, totalTokens: 1 }],
		["小数", { inputTokens: 1.5, outputTokens: 2, totalTokens: 3.5 }],
		["无限值", { inputTokens: 1, outputTokens: 2, totalTokens: Number.POSITIVE_INFINITY }],
	])("拒绝非法 Usage：%s", (_name, usage) => {
		expectNativeError(
			() => validateNativeCompactionResult({ providerContext: createProviderContextInput(), usage }),
			"invalid_context",
		);
	});

	it("拒绝 Result 额外字段", () => {
		expectNativeError(
			() => validateNativeCompactionResult({ providerContext: createProviderContextInput(), raw: SENTINEL }),
			"invalid_context",
		);
	});
});

describe("Sanitized Native Error", () => {
	it.each([
		["unsupported", "Native compaction is not supported."],
		["invalid_context", "Native compaction context is invalid."],
		["binding_mismatch", "Native compaction context binding does not match the active provider."],
		["capacity", "Native compaction input exceeds the supported capacity."],
		["protocol", "Native compaction protocol is incompatible."],
		["aborted", "Native compaction was aborted."],
		["provider_error", "Native compaction provider request failed."],
	] satisfies Array<[NativeCompactionErrorCode, string]>)("错误码 %s 只有固定安全消息", (code, message) => {
		const error = createNativeCompactionError(code);

		expect(error.message).toBe(message);
		expect(error.name).toBe("NativeCompactionError");
		expect(Object.isFrozen(error)).toBe(true);
		expect("cause" in error).toBe(false);
		expect(JSON.stringify(error)).not.toContain(SENTINEL);
		expect(String(error)).not.toContain(SENTINEL);
		expect(error.stack).not.toContain(SENTINEL);
	});
});
