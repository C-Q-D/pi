import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;
const providerContextPreflightStreamFns = new WeakSet<StreamFn>();

/**
 * Declare that this exact final wrapper performs Pi AI Models provider-context
 * preflight before dispatch. Wrapping the function creates a new, undeclared identity.
 */
export function declareStreamFnHandlesProviderContext<TStreamFn extends StreamFn>(streamFn: TStreamFn): TStreamFn {
	providerContextPreflightStreamFns.add(streamFn);
	return streamFn;
}

/** @internal Exact-identity guard used by the low-level Agent loop. */
export function streamFnHandlesProviderContext(streamFn: StreamFn): boolean {
	return providerContextPreflightStreamFns.has(streamFn);
}

/**
 * Configure the fallback used by Agent and low-level loops when callers omit streamFn.
 *
 * Hosts that provide a default model runtime can install its stream function here
 * without making pi-agent-core depend on a provider catalog or compatibility layer.
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
