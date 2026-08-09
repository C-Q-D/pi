import type { NativeCompactionApi, NativeCompactionEndpoint } from "../types.ts";
import { createNativeCompactionError } from "./native-compaction.ts";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** 在调用 Adapter Resolver 前按首版原生 API 白名单 Fail Closed。 */
export function assertNativeCompactionApi(api: unknown): asserts api is NativeCompactionApi {
	if (api !== "openai-responses" && api !== "openai-codex-responses") {
		throw createNativeCompactionError("protocol");
	}
}

/** 校验并冻结 Adapter 返回的 Endpoint Identity。 */
export function validateNativeCompactionEndpoint<TApi extends NativeCompactionApi>(
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
