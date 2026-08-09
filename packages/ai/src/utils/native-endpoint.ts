import type { NativeCompactionApi, NativeCompactionEndpoint, NativeCompactionRouteSet } from "../types.ts";
import { createNativeCompactionError } from "./native-compaction.ts";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** 在调用 Adapter Resolver 前按首版原生 API 白名单 Fail Closed。 */
export function assertNativeCompactionApi(api: unknown): asserts api is NativeCompactionApi {
	if (api !== "openai-responses" && api !== "openai-codex-responses") {
		throw createNativeCompactionError("protocol");
	}
}

/** 校验并冻结单个 Endpoint Identity。 */
function validateNativeCompactionEndpoint<TApi extends NativeCompactionApi>(
	api: TApi,
	value: unknown,
): NativeCompactionEndpoint<TApi> {
	try {
		assertNativeCompactionApi(api);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw createNativeCompactionError("protocol");
		}
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw createNativeCompactionError("protocol");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 2 || !keys.includes("endpoint") || !keys.includes("protocol")) {
			throw createNativeCompactionError("protocol");
		}
		const endpointDescriptor = Object.getOwnPropertyDescriptor(value, "endpoint");
		const protocolDescriptor = Object.getOwnPropertyDescriptor(value, "protocol");
		if (
			!endpointDescriptor?.enumerable ||
			!("value" in endpointDescriptor) ||
			!protocolDescriptor?.enumerable ||
			!("value" in protocolDescriptor)
		) {
			throw createNativeCompactionError("protocol");
		}
		const endpoint = endpointDescriptor.value;
		const protocol = protocolDescriptor.value;
		const protocolMatchesApi =
			api === "openai-responses"
				? protocol === "openai-responses-compact"
				: protocol === "openai-codex-remote-v2" || protocol === "openai-codex-compact-legacy";
		if (
			typeof endpoint !== "string" ||
			endpoint.length === 0 ||
			CONTROL_CHARACTER_PATTERN.test(endpoint) ||
			endpoint.includes("#")
		) {
			throw createNativeCompactionError("protocol");
		}
		const parsed = new URL(endpoint);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.username.length > 0 ||
			parsed.password.length > 0 ||
			parsed.hash.length > 0 ||
			!protocolMatchesApi
		) {
			throw createNativeCompactionError("protocol");
		}
		return Object.freeze({
			endpoint,
			protocol: protocol as NativeCompactionEndpoint<TApi>["protocol"],
		});
	} catch {
		throw createNativeCompactionError("protocol");
	}
}

/** 校验并深冻结 Adapter 在发网前声明的闭合 Route Set。 */
export function validateNativeCompactionRouteSet<TApi extends NativeCompactionApi>(
	api: TApi,
	value: unknown,
): NativeCompactionRouteSet<TApi> {
	try {
		assertNativeCompactionApi(api);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw createNativeCompactionError("protocol");
		}
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw createNativeCompactionError("protocol");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 2 || !keys.includes("primary") || !keys.includes("fallbacks")) {
			throw createNativeCompactionError("protocol");
		}
		const primaryDescriptor = Object.getOwnPropertyDescriptor(value, "primary");
		const fallbacksDescriptor = Object.getOwnPropertyDescriptor(value, "fallbacks");
		if (
			!primaryDescriptor?.enumerable ||
			!("value" in primaryDescriptor) ||
			!fallbacksDescriptor?.enumerable ||
			!("value" in fallbacksDescriptor)
		) {
			throw createNativeCompactionError("protocol");
		}
		const rawFallbacks = fallbacksDescriptor.value;
		if (!Array.isArray(rawFallbacks) || Object.getPrototypeOf(rawFallbacks) !== Array.prototype) {
			throw createNativeCompactionError("protocol");
		}
		const fallbackKeys = Reflect.ownKeys(rawFallbacks);
		if (
			fallbackKeys.length !== rawFallbacks.length + 1 ||
			fallbackKeys.at(-1) !== "length" ||
			fallbackKeys.slice(0, -1).some((key, index) => key !== String(index))
		) {
			throw createNativeCompactionError("protocol");
		}
		const primary = validateNativeCompactionEndpoint(api, primaryDescriptor.value);
		const fallbacks: NativeCompactionEndpoint<TApi>[] = [];
		for (let index = 0; index < rawFallbacks.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(rawFallbacks, String(index));
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				throw createNativeCompactionError("protocol");
			}
			fallbacks.push(validateNativeCompactionEndpoint(api, descriptor.value));
		}
		const identities = new Set<string>();
		for (const route of [primary, ...fallbacks]) {
			const identity = `${route.protocol}\u0000${route.endpoint}`;
			if (identities.has(identity)) throw createNativeCompactionError("protocol");
			identities.add(identity);
		}
		return Object.freeze({ primary, fallbacks: Object.freeze(fallbacks) });
	} catch {
		throw createNativeCompactionError("protocol");
	}
}
