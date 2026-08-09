import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import { resolveOpenAICodexCompactionEndpoint } from "./openai-codex-responses-shared.ts";

export const openAICodexResponsesApi = (): ProviderStreams<"openai-codex-responses"> =>
	lazyApi(() => import("./openai-codex-responses.ts"), {
		nativeCompaction: { resolveNativeCompactionEndpoint: resolveOpenAICodexCompactionEndpoint },
	});
