import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
import { resolveOpenAIResponsesCompactionEndpoint } from "./openai-responses-shared.ts";

export const openAIResponsesApi = (): ProviderStreams<"openai-responses"> =>
	lazyApi(() => import("./openai-responses.ts"), {
		nativeCompaction: { resolveNativeCompactionEndpoint: resolveOpenAIResponsesCompactionEndpoint },
	});
