/** OpenAI Codex Responses 的 SDK-free Endpoint 解析边界。 */

import type { Model, NativeCompactionPublicOptionsMap, NativeCompactionRouteSet } from "../types.ts";
import { createNativeCompactionError } from "../utils/native-compaction.ts";
import { validateNativeCompactionRouteSet } from "../utils/native-endpoint.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** 按普通 Codex Stream 的既有规则解析 Responses Endpoint。 */
export function resolveOpenAICodexResponsesUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

/** 返回与实际 V2 请求一致、可参与精确 Binding 的 Codex Route Set。 */
export function resolveOpenAICodexCompactionRoutes(
	model: Readonly<Model<"openai-codex-responses">>,
	_options: Readonly<NativeCompactionPublicOptionsMap["openai-codex-responses"]>,
): NativeCompactionRouteSet<"openai-codex-responses"> {
	try {
		if (model.baseUrl.includes("?") || model.baseUrl.includes("#")) {
			throw createNativeCompactionError("protocol");
		}
		const baseUrl = new URL(model.baseUrl);
		if (baseUrl.search || baseUrl.hash) throw createNativeCompactionError("protocol");
		return validateNativeCompactionRouteSet("openai-codex-responses", {
			primary: {
				endpoint: resolveOpenAICodexResponsesUrl(model.baseUrl),
				protocol: "openai-codex-remote-v2",
			},
			fallbacks: [],
		});
	} catch {
		throw createNativeCompactionError("protocol");
	}
}
