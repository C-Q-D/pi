import { assertNativeCompactionProviderRequest } from "../models.ts";
import type {
	NativeCompactionApi,
	NativeCompactionEndpoint,
	NativeCompactionProviderCapabilities,
	NativeCompactionProviderRequest,
	NativeCompactionResult,
	ProviderContextBinding,
	ProviderStreamMethods,
	ProviderStreams,
} from "../types.ts";
import { lazyStream } from "../utils/lazy-stream.ts";
import {
	createNativeCompactionError,
	sanitizeNativeCompactionError,
	validateNativeCompactionResult,
} from "../utils/native-compaction.ts";
import { assertNativeCompactionApi, validateNativeCompactionEndpoint } from "../utils/native-endpoint.ts";

export { lazyStream } from "../utils/lazy-stream.ts";

type NativeStreamsRuntime = ProviderStreamMethods & Partial<NativeCompactionProviderCapabilities>;

export interface LazyNativeCompactionOptions<TApi extends NativeCompactionApi> {
	readonly nativeCompaction: {
		readonly resolveNativeCompactionEndpoint: NativeCompactionProviderCapabilities<TApi>["resolveNativeCompactionEndpoint"];
	};
}

function hasNativeCompactionCapabilities(
	streams: unknown,
): streams is ProviderStreamMethods & NativeCompactionProviderCapabilities {
	if ((typeof streams !== "object" && typeof streams !== "function") || streams === null) return false;
	const candidate = streams as Partial<NativeCompactionProviderCapabilities>;
	return (
		typeof candidate.compact === "function" &&
		typeof candidate.canConsumeProviderContext === "function" &&
		typeof candidate.resolveNativeCompactionEndpoint === "function"
	);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw createNativeCompactionError("aborted");
}

function bindingsMatch(left: ProviderContextBinding, right: ProviderContextBinding): boolean {
	return (
		left.provider === right.provider &&
		left.api === right.api &&
		left.model === right.model &&
		left.endpoint === right.endpoint &&
		left.format === right.format &&
		left.protocol === right.protocol &&
		left.credentialScopeHash === right.credentialScopeHash
	);
}

function endpointMatchesRequest(endpoint: NativeCompactionEndpoint, request: NativeCompactionProviderRequest): boolean {
	return endpoint.endpoint === request.binding.endpoint && endpoint.protocol === request.binding.protocol;
}

async function loadNativeStreams(
	load: () => Promise<NativeStreamsRuntime>,
	request: NativeCompactionProviderRequest,
): Promise<ProviderStreamMethods & NativeCompactionProviderCapabilities> {
	throwIfAborted(request.options.signal);
	let streams: unknown;
	try {
		streams = await load();
	} catch (error) {
		throwIfAborted(request.options.signal);
		throw sanitizeNativeCompactionError(error, "provider_error");
	}
	throwIfAborted(request.options.signal);
	if (!hasNativeCompactionCapabilities(streams)) throw createNativeCompactionError("unsupported");
	let endpoint: NativeCompactionEndpoint;
	try {
		endpoint = validateNativeCompactionEndpoint(
			request.model.api,
			streams.resolveNativeCompactionEndpoint(request.model, request.options),
		);
	} catch (error) {
		throwIfAborted(request.options.signal);
		throw sanitizeNativeCompactionError(error, "provider_error");
	}
	throwIfAborted(request.options.signal);
	if (!endpointMatchesRequest(endpoint, request)) throw createNativeCompactionError("binding_mismatch");
	return streams;
}

function createNativeCapabilities<TApi extends NativeCompactionApi>(
	load: () => Promise<NativeStreamsRuntime>,
	resolver: NativeCompactionProviderCapabilities<TApi>["resolveNativeCompactionEndpoint"],
): NativeCompactionProviderCapabilities<TApi> {
	return {
		resolveNativeCompactionEndpoint: (model, options) => {
			try {
				assertNativeCompactionApi(model.api);
				return validateNativeCompactionEndpoint(model.api, resolver(model, options));
			} catch (error) {
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
		compact: async (request): Promise<NativeCompactionResult> => {
			assertNativeCompactionProviderRequest(request);
			throwIfAborted(request.options.signal);
			try {
				const streams = await loadNativeStreams(load, request);
				const rawResult: unknown = await streams.compact(request);
				throwIfAborted(request.options.signal);
				let result: NativeCompactionResult;
				try {
					result = validateNativeCompactionResult(rawResult);
				} catch {
					throw createNativeCompactionError("protocol");
				}
				if (!bindingsMatch(result.providerContext.binding, request.binding)) {
					throw createNativeCompactionError("binding_mismatch");
				}
				return result;
			} catch (error) {
				throwIfAborted(request.options.signal);
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
		canConsumeProviderContext: async (request): Promise<boolean> => {
			assertNativeCompactionProviderRequest(request);
			throwIfAborted(request.options.signal);
			try {
				const streams = await loadNativeStreams(load, request);
				const result: unknown = await streams.canConsumeProviderContext(request);
				throwIfAborted(request.options.signal);
				if (typeof result !== "boolean") throw createNativeCompactionError("protocol");
				return result;
			} catch (error) {
				throwIfAborted(request.options.signal);
				throw sanitizeNativeCompactionError(error, "provider_error");
			}
		},
	};
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * Native compaction remains hidden unless the caller explicitly supplies a
 * synchronous, SDK-free endpoint resolver.
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams;
export function lazyApi<TApi extends NativeCompactionApi>(
	load: () => Promise<ProviderStreams<TApi>>,
	options: LazyNativeCompactionOptions<TApi>,
): ProviderStreamMethods & NativeCompactionProviderCapabilities<TApi>;
export function lazyApi<TApi extends NativeCompactionApi>(
	load: () => Promise<NativeStreamsRuntime>,
	options?: LazyNativeCompactionOptions<TApi>,
): ProviderStreams | (ProviderStreamMethods & NativeCompactionProviderCapabilities<TApi>) {
	const streams: ProviderStreamMethods = {
		stream: (model, context, streamOptions) =>
			lazyStream(model, async () => (await load()).stream(model, context, streamOptions)),
		streamSimple: (model, context, streamOptions) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, streamOptions)),
	};
	if (!options) return streams;
	return Object.assign(
		streams,
		createNativeCapabilities(load, options.nativeCompaction.resolveNativeCompactionEndpoint),
	);
}
