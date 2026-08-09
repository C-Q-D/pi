/**
 * Provider 原生压缩的纯数据安全边界。
 *
 * 本模块不解析认证、不选择 Endpoint，也不调用网络；它只负责闭合结构校验、
 * 防御性复制、深冻结和固定错误净化。
 */

import type {
	JsonObject,
	JsonValue,
	NativeCompactionErrorCode,
	NativeCompactionProtocol,
	NativeCompactionResult,
	NativeCompactionUsage,
	ProviderContextBinding,
	ProviderContextEnvelope,
} from "../types.ts";

const PROVIDER_CONTEXT_FORMAT = "openai-responses-compaction";
const PROVIDER_CONTEXT_VERSION = 1;
const CREDENTIAL_SCOPE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const NATIVE_COMPACTION_PROTOCOLS = new Set<NativeCompactionProtocol>([
	"openai-responses-compact",
	"openai-codex-remote-v2",
	"openai-codex-compact-legacy",
]);

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const NATIVE_COMPACTION_ERROR_MESSAGES = {
	unsupported: "Native compaction is not supported.",
	invalid_context: "Native compaction context is invalid.",
	binding_mismatch: "Native compaction context binding does not match the active provider.",
	capacity: "Native compaction input exceeds the supported capacity.",
	protocol: "Native compaction protocol is incompatible.",
	aborted: "Native compaction was aborted.",
	provider_error: "Native compaction provider request failed.",
} as const satisfies Record<NativeCompactionErrorCode, string>;

const VALIDATION_FAILURE_CODES = new WeakMap<object, NativeCompactionErrorCode>();

/** 仅在模块内部流转、不会暴露原异常内容的校验失败。 */
class NativeCompactionValidationFailure extends Error {
	constructor(code: NativeCompactionErrorCode) {
		super(code);
		VALIDATION_FAILURE_CODES.set(this, code);
	}
}

/** 只携带固定错误码和固定安全消息的原生压缩错误。 */
export class NativeCompactionError extends Error {
	/** 可供上层稳定分支处理的安全错误码。 */
	readonly code: NativeCompactionErrorCode;

	constructor(code: NativeCompactionErrorCode) {
		super(NATIVE_COMPACTION_ERROR_MESSAGES[code]);
		this.name = "NativeCompactionError";
		this.code = code;
		Object.freeze(this);
	}
}

/** 创建不接受自定义消息、Cause 或 Details 的固定安全错误。 */
export function createNativeCompactionError(code: NativeCompactionErrorCode): NativeCompactionError {
	return new NativeCompactionError(code);
}

/** 把未知异常统一替换为指定安全错误，不复制原异常文本。 */
function sanitizeFailure(error: unknown, fallbackCode: NativeCompactionErrorCode): NativeCompactionError {
	const isObject = (typeof error === "object" && error !== null) || typeof error === "function";
	const code = (isObject ? VALIDATION_FAILURE_CODES.get(error) : undefined) ?? fallbackCode;
	return createNativeCompactionError(code);
}

/** 在模块内部中止校验，并只携带固定错误码。 */
function failValidation(code: NativeCompactionErrorCode): never {
	throw new NativeCompactionValidationFailure(code);
}

/** 读取一个只含可枚举字符串数据属性的普通对象。 */
function readPlainObject(value: unknown): ReadonlyMap<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		failValidation("invalid_context");
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) {
		failValidation("invalid_context");
	}

	const properties = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
			failValidation("invalid_context");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
			failValidation("invalid_context");
		}
		properties.set(key, descriptor.value);
	}
	return properties;
}

/** 确保结构对象只包含允许字段，并返回已经安全读取的属性。 */
function readExactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): ReadonlyMap<string, unknown> {
	const properties = readPlainObject(value);
	const allowed = new Set([...required, ...optional]);
	for (const key of properties.keys()) {
		if (!allowed.has(key)) {
			failValidation("invalid_context");
		}
	}
	for (const key of required) {
		if (!properties.has(key)) {
			failValidation("invalid_context");
		}
	}
	return properties;
}

/** 读取结构字段中的非空安全字符串。 */
function readStructuralString(properties: ReadonlyMap<string, unknown>, key: string): string {
	const value = properties.get(key);
	if (typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
		failValidation("invalid_context");
	}
	return value;
}

/** 递归复制纯 JSON，并拒绝所有非 JSON 状态和不安全对象形状。 */
function cloneJsonValue(value: unknown, activeObjects: WeakSet<object>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			failValidation("invalid_context");
		}
		return value;
	}
	if (typeof value !== "object") {
		failValidation("invalid_context");
	}
	if (activeObjects.has(value)) {
		failValidation("invalid_context");
	}

	activeObjects.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				failValidation("invalid_context");
			}
			const keys = Reflect.ownKeys(value);
			for (const key of keys) {
				if (key === "length") {
					continue;
				}
				if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
					failValidation("invalid_context");
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
					failValidation("invalid_context");
				}
			}
			const clone: JsonValue[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) {
					failValidation("invalid_context");
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor === undefined || !("value" in descriptor)) {
					failValidation("invalid_context");
				}
				clone.push(cloneJsonValue(descriptor.value, activeObjects));
			}
			return Object.freeze(clone);
		}

		const properties = readPlainObject(value);
		if (properties.get("type") === "compaction_trigger") {
			failValidation("invalid_context");
		}
		const clone: Record<string, JsonValue> = {};
		for (const [key, propertyValue] of properties) {
			clone[key] = cloneJsonValue(propertyValue, activeObjects);
		}
		return Object.freeze(clone) as JsonObject;
	} finally {
		activeObjects.delete(value);
	}
}

/** 校验、深复制并深冻结一个纯 JSON 值。 */
export function cloneAndFreezeJson(value: unknown): JsonValue {
	try {
		return cloneJsonValue(value, new WeakSet());
	} catch (error) {
		throw sanitizeFailure(error, "invalid_context");
	}
}

/** 校验并复制 Provider Context Binding。 */
function cloneBinding(value: unknown): ProviderContextBinding {
	const properties = readExactObject(value, [
		"provider",
		"api",
		"model",
		"endpoint",
		"format",
		"protocol",
		"credentialScopeHash",
	]);
	const format = readStructuralString(properties, "format");
	const protocol = readStructuralString(properties, "protocol");
	if (format !== PROVIDER_CONTEXT_FORMAT || !NATIVE_COMPACTION_PROTOCOLS.has(protocol as NativeCompactionProtocol)) {
		failValidation("protocol");
	}
	const credentialScopeHash = readStructuralString(properties, "credentialScopeHash");
	if (!CREDENTIAL_SCOPE_HASH_PATTERN.test(credentialScopeHash)) {
		failValidation("invalid_context");
	}

	return Object.freeze({
		provider: readStructuralString(properties, "provider"),
		api: readStructuralString(properties, "api"),
		model: readStructuralString(properties, "model"),
		endpoint: readStructuralString(properties, "endpoint"),
		format: PROVIDER_CONTEXT_FORMAT,
		protocol: protocol as NativeCompactionProtocol,
		credentialScopeHash,
	});
}

/** 在模块内部校验并复制 Provider Context，保留固定失败码。 */
function cloneProviderContext(value: unknown): ProviderContextEnvelope {
	const properties = readExactObject(value, ["format", "version", "binding", "items"]);
	if (properties.get("format") !== PROVIDER_CONTEXT_FORMAT || properties.get("version") !== PROVIDER_CONTEXT_VERSION) {
		failValidation("protocol");
	}
	const items = properties.get("items");
	if (!Array.isArray(items)) {
		failValidation("invalid_context");
	}
	const clonedItems = cloneJsonValue(items, new WeakSet());
	if (!Array.isArray(clonedItems)) {
		failValidation("invalid_context");
	}

	return Object.freeze({
		format: PROVIDER_CONTEXT_FORMAT,
		version: PROVIDER_CONTEXT_VERSION,
		binding: cloneBinding(properties.get("binding")),
		items: clonedItems,
	});
}

/** 校验、深复制并深冻结 Provider Context Envelope。 */
export function cloneAndFreezeProviderContext(value: unknown): ProviderContextEnvelope {
	try {
		return cloneProviderContext(value);
	} catch (error) {
		throw sanitizeFailure(error, "invalid_context");
	}
}

/** 校验并复制公开的最小 Token 用量。 */
function cloneUsage(value: unknown): NativeCompactionUsage {
	const properties = readExactObject(value, ["inputTokens", "outputTokens", "totalTokens"]);
	const readTokenCount = (key: string): number => {
		const count = properties.get(key);
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
			failValidation("invalid_context");
		}
		return count;
	};
	return Object.freeze({
		inputTokens: readTokenCount("inputTokens"),
		outputTokens: readTokenCount("outputTokens"),
		totalTokens: readTokenCount("totalTokens"),
	});
}

/** 校验 Provider 原生压缩结果的精确字段并返回不可变副本。 */
export function validateNativeCompactionResult(value: unknown): NativeCompactionResult {
	try {
		const properties = readExactObject(value, ["providerContext"], ["usage"]);
		const result: {
			providerContext: ProviderContextEnvelope;
			usage?: NativeCompactionUsage;
		} = {
			providerContext: cloneProviderContext(properties.get("providerContext")),
		};
		if (properties.has("usage")) {
			result.usage = cloneUsage(properties.get("usage"));
		}
		return Object.freeze(result);
	} catch (error) {
		throw sanitizeFailure(error, "invalid_context");
	}
}
