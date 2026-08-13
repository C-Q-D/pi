import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";
import { getNativeCompactionErrorMetadata } from "./native-compaction.ts";

function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	const timestamp = Date.now();
	const nativeMetadata = getNativeCompactionErrorMetadata(error);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		...(nativeMetadata === undefined
			? {}
			: {
					diagnostics: [
						{
							type: "native_compaction",
							timestamp,
							details: {
								code: nativeMetadata.code,
								...(nativeMetadata.bindingDimension === undefined
									? {}
									: { bindingDimension: nativeMetadata.bindingDimension }),
							},
						},
					],
				}),
		timestamp,
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}
