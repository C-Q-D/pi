import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createNativeCompactionError, type Model, type RetryCallbacks, type RetryPolicy } from "@earendil-works/pi-ai";
import type { SessionManager } from "../session-manager.ts";
import type { CompactionResult, CompactionSettings } from "./compaction.ts";
import { compact, estimateContextTokens, prepareCompaction } from "./compaction.ts";

export interface PortableLocalRecoveryOptions {
	readonly sessionManager: SessionManager;
	readonly model: Model<any>;
	readonly settings: CompactionSettings;
	readonly replaceContext: (messages: AgentMessage[]) => void;
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly env?: Record<string, string>;
	readonly customInstructions?: string;
	readonly signal?: AbortSignal;
	readonly thinkingLevel?: ThinkingLevel;
	readonly streamFn?: StreamFn;
	readonly retry?: RetryPolicy;
	readonly callbacks?: RetryCallbacks;
}

/**
 * Convert the active remote checkpoint into a provider-independent local summary.
 * The LLM only receives the flattened raw ancestry; the opaque provider payload is
 * never included. No session or Agent state is changed before summarization succeeds.
 */
export async function recoverRemoteContextToLocal(options: PortableLocalRecoveryOptions): Promise<CompactionResult> {
	const activeContext = options.sessionManager.buildSessionContext();
	if (activeContext.providerContext === undefined) {
		throw createNativeCompactionError("unsupported");
	}
	if (options.signal?.aborted) throw createNativeCompactionError("aborted");

	const startingLeafId = options.sessionManager.getLeafId();
	const portableEntries = options.sessionManager.buildPortableRawEntries();
	const preparation = prepareCompaction(portableEntries, options.settings);
	if (!preparation) {
		throw new Error("Nothing to compact (portable session too small)");
	}

	const result = await compact(
		preparation,
		options.model,
		options.apiKey,
		options.headers,
		options.customInstructions,
		options.signal,
		options.thinkingLevel,
		options.streamFn,
		options.env,
		options.retry,
		options.callbacks,
	);
	if (options.signal?.aborted) throw createNativeCompactionError("aborted");
	if (options.sessionManager.getLeafId() !== startingLeafId) {
		throw createNativeCompactionError("invalid_context");
	}

	options.sessionManager.appendCompaction(
		result.summary,
		result.firstKeptEntryId,
		result.tokensBefore,
		result.details,
		false,
		result.usage,
	);
	let messages: AgentMessage[];
	try {
		const rebuilt = options.sessionManager.buildSessionContext();
		if (rebuilt.providerContext !== undefined) {
			throw createNativeCompactionError("provider_error");
		}
		messages = structuredClone(rebuilt.messages);
		options.replaceContext(messages);
	} catch (error) {
		// Sessions are append-only. Restore the active leaf so the failed Local
		// checkpoint remains an abandoned sibling and the Remote context stays active.
		if (startingLeafId === null) options.sessionManager.resetLeaf();
		else options.sessionManager.branch(startingLeafId);
		throw error;
	}
	return {
		...result,
		estimatedTokensAfter: estimateContextTokens(messages).tokens,
	};
}
