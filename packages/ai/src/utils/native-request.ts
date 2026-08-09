import type { NativeCompactionProviderRequest, ProviderContextBinding } from "../types.ts";
import { createNativeCompactionError } from "./native-compaction.ts";

const AUTHORIZED_NATIVE_COMPACTION_BINDINGS = new WeakMap<object, readonly ProviderContextBinding[]>();

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
	if (!getAuthorizedNativeCompactionBindings(request).some((authorized) => bindingsMatch(binding, authorized))) {
		throw createNativeCompactionError("binding_mismatch");
	}
}

/** 使用同一 Exact Match 规则检查尚未登记请求的输入 Binding。 */
export function nativeCompactionBindingIsAuthorized(
	binding: ProviderContextBinding,
	authorizedBindings: readonly ProviderContextBinding[],
): boolean {
	return authorizedBindings.some((authorized) => bindingsMatch(binding, authorized));
}
