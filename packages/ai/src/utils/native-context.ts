import type { Context, JsonValue, Message, Tool } from "../types.ts";
import { createNativeCompactionError, sanitizeNativeCompactionError } from "./native-compaction.ts";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function cloneData(value: unknown, active: WeakSet<object>, allowTypeBoxKind = false): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw createNativeCompactionError("invalid_context");
		return value;
	}
	if (typeof value !== "object") throw createNativeCompactionError("invalid_context");
	if (active.has(value)) throw createNativeCompactionError("invalid_context");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype) {
				throw createNativeCompactionError("invalid_context");
			}
			const clone: JsonValue[] = [];
			for (const key of Reflect.ownKeys(value)) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
					throw createNativeCompactionError("invalid_context");
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					throw createNativeCompactionError("invalid_context");
				}
			}
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor)) throw createNativeCompactionError("invalid_context");
				clone.push(cloneData(descriptor.value, active, allowTypeBoxKind));
			}
			return Object.freeze(clone);
		}

		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw createNativeCompactionError("invalid_context");
		}
		const clone: Record<string, JsonValue> = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
				throw createNativeCompactionError("invalid_context");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (allowTypeBoxKind && key === "~kind" && descriptor && !descriptor.enumerable && "value" in descriptor) {
				continue;
			}
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				throw createNativeCompactionError("invalid_context");
			}
			clone[key] = cloneData(descriptor.value, active, allowTypeBoxKind);
		}
		return Object.freeze(clone);
	} finally {
		active.delete(value);
	}
}

function readProjectedObject(
	value: unknown,
	allowed: ReadonlySet<string>,
	omitted: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw createNativeCompactionError("invalid_context");
	}
	const properties = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || DANGEROUS_KEYS.has(key) || (!allowed.has(key) && !omitted.has(key))) {
			throw createNativeCompactionError("invalid_context");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (omitted.has(key)) continue;
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			throw createNativeCompactionError("invalid_context");
		}
		properties.set(key, descriptor.value);
	}
	return properties;
}

function mapPlainArray<T>(value: unknown, map: (entry: unknown) => T): readonly T[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		throw createNativeCompactionError("invalid_context");
	}
	for (const key of Reflect.ownKeys(value)) {
		if (key === "length") continue;
		if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
			throw createNativeCompactionError("invalid_context");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			throw createNativeCompactionError("invalid_context");
		}
	}
	const clone: T[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor)) throw createNativeCompactionError("invalid_context");
		clone.push(map(descriptor.value));
	}
	return Object.freeze(clone);
}

const MESSAGE_FIELDS = {
	user: new Set(["role", "content", "timestamp"]),
	assistant: new Set([
		"role",
		"content",
		"api",
		"provider",
		"model",
		"responseModel",
		"responseId",
		"diagnostics",
		"usage",
		"stopReason",
		"errorMessage",
		"rawStopReason",
		"timestamp",
	]),
	toolResult: new Set([
		"role",
		"toolCallId",
		"toolName",
		"content",
		"details",
		"usage",
		"addedToolNames",
		"isError",
		"timestamp",
	]),
} as const;

const MESSAGE_REQUIRED_FIELDS = {
	user: ["role", "content", "timestamp"],
	assistant: ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
	toolResult: ["role", "toolCallId", "toolName", "content", "isError", "timestamp"],
} as const;

function requireProjectedFields(properties: ReadonlyMap<string, unknown>, required: readonly string[]): void {
	for (const key of required) {
		if (!properties.has(key)) throw createNativeCompactionError("invalid_context");
	}
}

type MessageRole = "user" | "assistant" | "toolResult";

function cloneContentItem(value: unknown, role: MessageRole): JsonValue {
	const probe = readProjectedObject(
		value,
		new Set([
			"type",
			"text",
			"textSignature",
			"data",
			"mimeType",
			"thinking",
			"thinkingSignature",
			"redacted",
			"id",
			"name",
			"arguments",
			"thoughtSignature",
		]),
	);
	const type = probe.get("type");
	const allowedForRole = role === "assistant" ? new Set(["text", "thinking", "toolCall"]) : new Set(["text", "image"]);
	if (typeof type !== "string" || !allowedForRole.has(type)) {
		throw createNativeCompactionError("invalid_context");
	}
	const fields =
		type === "text"
			? { allowed: new Set(["type", "text", "textSignature"]), required: ["type", "text"] }
			: type === "image"
				? { allowed: new Set(["type", "data", "mimeType"]), required: ["type", "data", "mimeType"] }
				: type === "thinking"
					? {
							allowed: new Set(["type", "thinking", "thinkingSignature", "redacted"]),
							required: ["type", "thinking"],
						}
					: {
							allowed: new Set(["type", "id", "name", "arguments", "thoughtSignature"]),
							required: ["type", "id", "name", "arguments"],
						};
	const properties = readProjectedObject(value, fields.allowed);
	requireProjectedFields(properties, fields.required);
	const requiredStrings =
		type === "text"
			? ["text"]
			: type === "image"
				? ["data", "mimeType"]
				: type === "thinking"
					? ["thinking"]
					: ["id", "name"];
	for (const key of requiredStrings) {
		if (typeof properties.get(key) !== "string") throw createNativeCompactionError("invalid_context");
	}
	for (const key of ["textSignature", "thinkingSignature", "thoughtSignature"] as const) {
		if (properties.has(key) && typeof properties.get(key) !== "string") {
			throw createNativeCompactionError("invalid_context");
		}
	}
	if (properties.has("redacted") && typeof properties.get("redacted") !== "boolean") {
		throw createNativeCompactionError("invalid_context");
	}
	const clone: Record<string, JsonValue> = {};
	for (const [key, entry] of properties) {
		const cloned = cloneData(entry, new WeakSet());
		if (key === "arguments" && (typeof cloned !== "object" || cloned === null || Array.isArray(cloned))) {
			throw createNativeCompactionError("invalid_context");
		}
		clone[key] = cloned;
	}
	return Object.freeze(clone);
}

function cloneMessageContent(value: unknown, role: MessageRole): JsonValue {
	if (role === "user" && typeof value === "string") return value;
	return mapPlainArray(value, (entry) => cloneContentItem(entry, role));
}

function cloneUsage(value: unknown): JsonValue {
	const properties = readProjectedObject(
		value,
		new Set(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost"]),
	);
	requireProjectedFields(properties, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]);
	for (const key of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cacheWrite1h",
		"reasoning",
		"totalTokens",
	] as const) {
		if (!properties.has(key)) continue;
		const entry = properties.get(key);
		if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
			throw createNativeCompactionError("invalid_context");
		}
	}
	const cost = readProjectedObject(
		properties.get("cost"),
		new Set(["input", "output", "cacheRead", "cacheWrite", "total"]),
	);
	requireProjectedFields(cost, ["input", "output", "cacheRead", "cacheWrite", "total"]);
	for (const entry of cost.values()) {
		if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
			throw createNativeCompactionError("invalid_context");
		}
	}
	return cloneData(value, new WeakSet());
}

function cloneMessage(value: unknown): Message {
	const probe = readProjectedObject(
		value,
		new Set([...MESSAGE_FIELDS.user, ...MESSAGE_FIELDS.assistant, ...MESSAGE_FIELDS.toolResult]),
	);
	const role = probe.get("role");
	if (role !== "user" && role !== "assistant" && role !== "toolResult") {
		throw createNativeCompactionError("invalid_context");
	}
	const omitted =
		role === "toolResult"
			? new Set(["details"])
			: role === "assistant"
				? new Set(["diagnostics"])
				: new Set<string>();
	const properties = readProjectedObject(value, MESSAGE_FIELDS[role], omitted);
	requireProjectedFields(properties, MESSAGE_REQUIRED_FIELDS[role]);
	const content = properties.get("content");
	const timestamp = properties.get("timestamp");
	if (
		(role === "user" ? typeof content !== "string" && !Array.isArray(content) : !Array.isArray(content)) ||
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp)
	) {
		throw createNativeCompactionError("invalid_context");
	}
	if (
		(role === "assistant" &&
			(typeof properties.get("api") !== "string" ||
				typeof properties.get("provider") !== "string" ||
				typeof properties.get("model") !== "string" ||
				typeof properties.get("stopReason") !== "string")) ||
		(role === "toolResult" &&
			(typeof properties.get("toolCallId") !== "string" ||
				typeof properties.get("toolName") !== "string" ||
				typeof properties.get("isError") !== "boolean"))
	) {
		throw createNativeCompactionError("invalid_context");
	}
	if (role === "assistant") {
		if (
			!new Set(["pending", "stop", "length", "toolUse", "error", "aborted"]).has(
				properties.get("stopReason") as string,
			)
		) {
			throw createNativeCompactionError("invalid_context");
		}
		for (const key of ["responseModel", "responseId", "errorMessage", "rawStopReason"] as const) {
			if (properties.has(key) && typeof properties.get(key) !== "string") {
				throw createNativeCompactionError("invalid_context");
			}
		}
	}
	if (role === "toolResult" && properties.has("addedToolNames")) {
		mapPlainArray(properties.get("addedToolNames"), (entry) => {
			if (typeof entry !== "string") throw createNativeCompactionError("invalid_context");
			return entry;
		});
	}
	const clone: Record<string, JsonValue> = {};
	for (const [key, entry] of properties) {
		if (key === "content") clone.content = cloneMessageContent(entry, role);
		else if (key === "usage") clone.usage = cloneUsage(entry);
		else if (key === "addedToolNames") {
			clone.addedToolNames = mapPlainArray(entry, (name) => name as string);
		} else clone[key] = cloneData(entry, new WeakSet());
	}
	return Object.freeze(clone) as unknown as Message;
}

function cloneTool(value: unknown): Tool {
	const properties = readProjectedObject(value, new Set(["name", "description", "parameters", "constrainedSampling"]));
	if (!properties.has("name") || !properties.has("description") || !properties.has("parameters")) {
		throw createNativeCompactionError("invalid_context");
	}
	if (typeof properties.get("name") !== "string" || typeof properties.get("description") !== "string") {
		throw createNativeCompactionError("invalid_context");
	}
	const parameters = cloneData(properties.get("parameters"), new WeakSet(), true);
	if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
		throw createNativeCompactionError("invalid_context");
	}
	const clone: Record<string, JsonValue> = {};
	for (const [key, entry] of properties) {
		if (key === "parameters") clone.parameters = parameters;
		else if (key === "constrainedSampling") clone.constrainedSampling = cloneConstrainedSampling(entry);
		else clone[key] = cloneData(entry, new WeakSet());
	}
	return Object.freeze(clone) as unknown as Tool;
}

function cloneConstrainedSampling(value: unknown): JsonValue {
	if (value === false) return false;
	const probe = readProjectedObject(value, new Set(["type", "strict", "variants"]));
	const type = probe.get("type");
	if (type === "json_schema") {
		const properties = readProjectedObject(value, new Set(["type", "strict"]));
		requireProjectedFields(properties, ["type", "strict"]);
		if (properties.get("strict") !== "prefer" && properties.get("strict") !== "require") {
			throw createNativeCompactionError("invalid_context");
		}
		return cloneData(value, new WeakSet());
	}
	if (type === "grammar") {
		const properties = readProjectedObject(value, new Set(["type", "variants"]));
		requireProjectedFields(properties, ["type", "variants"]);
		const variants = readProjectedObject(properties.get("variants"), new Set(["openai_lark", "openai_regex"]));
		for (const entry of variants.values()) {
			if (typeof entry !== "string") throw createNativeCompactionError("invalid_context");
		}
		return cloneData(value, new WeakSet());
	}
	throw createNativeCompactionError("invalid_context");
}

/** Build the exact immutable Context snapshot used by native preflight and dispatch. */
export function cloneAndFreezeNativeContext(context: unknown): Readonly<Omit<Context, "providerContext">> {
	try {
		const properties = readProjectedObject(
			context,
			new Set(["systemPrompt", "messages", "tools", "providerContext"]),
		);
		const messages = properties.get("messages");
		const clone: Omit<Context, "providerContext"> = {
			messages: mapPlainArray(messages, cloneMessage) as Message[],
		};
		if (properties.has("systemPrompt")) {
			const systemPrompt = properties.get("systemPrompt");
			if (typeof systemPrompt !== "string") throw createNativeCompactionError("invalid_context");
			clone.systemPrompt = systemPrompt;
		}
		if (properties.has("tools")) {
			const tools = properties.get("tools");
			clone.tools = mapPlainArray(tools, cloneTool) as Tool[];
		}
		return Object.freeze(clone);
	} catch (error) {
		throw sanitizeNativeCompactionError(error, "invalid_context");
	}
}
