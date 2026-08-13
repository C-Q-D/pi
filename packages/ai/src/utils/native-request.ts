import type {
	NativeCompactionBindingMismatchDimension,
	NativeCompactionProviderRequest,
	ProviderContextBinding,
} from "../types.ts";
import { createNativeCompactionBindingMismatchError, createNativeCompactionError } from "./native-compaction.ts";

const AUTHORIZED_NATIVE_COMPACTION_BINDINGS = new WeakMap<object, readonly ProviderContextBinding[]>();

const BINDING_DIMENSIONS: readonly {
	readonly dimension: NativeCompactionBindingMismatchDimension;
	readonly read: (binding: ProviderContextBinding) => string;
}[] = [
	{ dimension: "provider", read: (binding) => binding.provider },
	{ dimension: "api", read: (binding) => binding.api },
	{ dimension: "model", read: (binding) => binding.model },
	{ dimension: "endpoint", read: (binding) => binding.endpoint },
	{ dimension: "format", read: (binding) => binding.format },
	{ dimension: "protocol", read: (binding) => binding.protocol },
	{ dimension: "credential", read: (binding) => binding.credentialScopeHash },
];

/** 返回与预授权 Route Set 首个不一致的安全维度；完全匹配时返回 undefined。 */
export function getNativeCompactionBindingMismatchDimension(
	binding: ProviderContextBinding,
	authorizedBindings: readonly ProviderContextBinding[],
): NativeCompactionBindingMismatchDimension | undefined {
	let candidates = authorizedBindings;
	for (const { dimension, read } of BINDING_DIMENSIONS) {
		const value = read(binding);
		const matching = candidates.filter((candidate) => read(candidate) === value);
		if (matching.length === 0) return dimension;
		candidates = matching;
	}
	return undefined;
}

/** 仅供 Models Preflight 登记已冻结请求及其预授权 Binding 集合。 */
export function registerNativeCompactionProviderRequest(
	request: NativeCompactionProviderRequest,
	bindings: readonly ProviderContextBinding[],
): void {
	AUTHORIZED_NATIVE_COMPACTION_BINDINGS.set(request, bindings);
}

/** 在读取请求字段或发网前断言请求已由 Models Preflight 登记。 */
export function assertNativeCompactionProviderRequest(request: NativeCompactionProviderRequest): void {
	if (!AUTHORIZED_NATIVE_COMPACTION_BINDINGS.has(request)) {
		throw createNativeCompactionError("unsupported");
	}
}

/** 返回 Models 为该请求预授权的原始冻结 Binding 集合，不允许调用方登记或构造授权。 */
export function getAuthorizedNativeCompactionBindings(
	request: NativeCompactionProviderRequest,
): readonly ProviderContextBinding[] {
	assertNativeCompactionProviderRequest(request);
	const bindings = AUTHORIZED_NATIVE_COMPACTION_BINDINGS.get(request);
	if (!bindings) throw createNativeCompactionError("unsupported");
	return bindings;
}

/** 断言 Provider 返回或消费的 Binding 属于 Models 为该请求预授权的 Route Set。 */
export function assertAuthorizedNativeCompactionBinding(
	request: NativeCompactionProviderRequest,
	binding: ProviderContextBinding,
): void {
	const dimension = getNativeCompactionBindingMismatchDimension(
		binding,
		getAuthorizedNativeCompactionBindings(request),
	);
	if (dimension !== undefined) throw createNativeCompactionBindingMismatchError(dimension);
}

/** 使用同一 Exact Match 规则检查尚未登记请求的输入 Binding。 */
export function nativeCompactionBindingIsAuthorized(
	binding: ProviderContextBinding,
	authorizedBindings: readonly ProviderContextBinding[],
): boolean {
	return getNativeCompactionBindingMismatchDimension(binding, authorizedBindings) === undefined;
}
