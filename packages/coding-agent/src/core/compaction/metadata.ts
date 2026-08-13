/**
 * 压缩结果的外部元数据安全边界。
 *
 * 本模块只从内部 Result、Session Entry 与 Error 中逐字段复制允许公开的值，
 * 供 TUI、RPC、Extension 和 HTML Export 使用；它不改变 Session 持久化结构。
 */

import { NativeCompactionError, type NativeCompactionErrorCode } from "@earendil-works/pi-ai";
import type { CompactionEntry, SessionEntry, SessionTreeNode } from "../session-manager.ts";
import type { CompactionResult } from "./compaction.ts";

/** 压缩的触发原因。 */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** 用户请求的压缩策略。 */
export type RequestedCompactionStrategy = "local" | "remote" | "auto";

/** 本次实际采用的压缩策略。 */
export type EffectiveCompactionStrategy = "local" | "remote";

/** 可安全公开的压缩错误码。 */
export type CompactionMetadataErrorCode =
	| NativeCompactionErrorCode
	| "cancelled"
	| "already_compacted"
	| "nothing_to_compact"
	| "no_model"
	| "in_progress"
	| "stale_branch"
	| "invalid_hook_result"
	| "commit_indeterminate"
	| "committed_restart_required"
	| "unknown";

/** 可安全公开的 Usage Cost。 */
export interface PublicCompactionCost {
	/** 输入 Token 成本。 */
	readonly input: number;
	/** 输出 Token 成本。 */
	readonly output: number;
	/** Cache Read 成本。 */
	readonly cacheRead: number;
	/** Cache Write 成本。 */
	readonly cacheWrite: number;
	/** 总成本。 */
	readonly total: number;
}

/** 可安全公开的本地压缩 Usage，只保留固定数值字段。 */
export interface PublicLocalCompactionUsage {
	/** 输入 Token 数。 */
	readonly input: number;
	/** 输出 Token 数。 */
	readonly output: number;
	/** Cache Read Token 数。 */
	readonly cacheRead: number;
	/** Cache Write Token 数。 */
	readonly cacheWrite: number;
	/** 一小时 Cache Write Token 数。 */
	readonly cacheWrite1h?: number;
	/** Reasoning Token 数。 */
	readonly reasoning?: number;
	/** 总 Token 数。 */
	readonly totalTokens: number;
	/** 固定成本明细。 */
	readonly cost: PublicCompactionCost;
}

/** 可安全公开的 Provider 原生压缩 Usage。 */
export interface PublicNativeCompactionUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

/** Local 与 Remote 两条链路各自保持原始的闭合公开 Usage 结构。 */
export type PublicCompactionUsage = PublicLocalCompactionUsage | PublicNativeCompactionUsage;

/** 所有自动展示边界共用的压缩元数据白名单。 */
export interface CompactionMetadata {
	/** 单次尝试 ID。 */
	readonly attemptId?: string;
	/** 跨回退步骤保持稳定的操作 ID。 */
	readonly operationId?: string;
	/** 压缩触发原因。 */
	readonly reason?: CompactionReason;
	/** 用户请求的策略。 */
	readonly requestedStrategy: RequestedCompactionStrategy;
	/** 实际采用的策略。 */
	readonly effectiveStrategy: EffectiveCompactionStrategy;
	/** Provider 协议。 */
	readonly protocol?: string;
	/** Provider 名称。 */
	readonly provider?: string;
	/** Model ID。 */
	readonly model?: string;
	/** 压缩前 Token 数。 */
	readonly tokensBefore: number;
	/** 压缩后估算 Token 数。 */
	readonly estimatedTokensAfter?: number;
	/** 可公开的 Usage。 */
	readonly usage?: PublicCompactionUsage;
	/** 自动回退的安全原因码。 */
	readonly fallbackCode?: CompactionMetadataErrorCode;
	/** 对外展示的安全错误码。 */
	readonly errorCode?: CompactionMetadataErrorCode;
	/** R1 验收完成前固定标记为实验能力。 */
	readonly experimental: true;
}

/** Builder 可由可信调用方补充的元数据。 */
export interface CompactionMetadataOptions {
	/** 压缩触发原因。 */
	readonly reason?: CompactionReason;
	/** 用户请求的策略。 */
	readonly requestedStrategy?: RequestedCompactionStrategy;
	/** 实际采用的策略。 */
	readonly effectiveStrategy?: EffectiveCompactionStrategy;
	/** 安全回退码。 */
	readonly fallbackCode?: CompactionMetadataErrorCode;
	/** 安全错误码。 */
	readonly errorCode?: CompactionMetadataErrorCode;
}

/** 对外公开的压缩结果；摘要是本地展示字段，不包含 Provider Payload。 */
export interface SanitizedCompactionResult {
	/** 可向用户展示的本地摘要。 */
	readonly summary: string;
	/** 压缩前 Token 数。 */
	readonly tokensBefore: number;
	/** 压缩后估算 Token 数。 */
	readonly estimatedTokensAfter?: number;
	/** 可公开的 Usage。 */
	readonly usage?: PublicCompactionUsage;
	/** 统一白名单元数据。 */
	readonly metadata: CompactionMetadata;
}

/** 对外公开的压缩 Session Entry。 */
export interface SanitizedCompactionEntry {
	/** 区分本地与远端压缩 Entry。 */
	readonly type: "compaction" | "remote_compaction";
	/** Session Entry ID。 */
	readonly id: string;
	/** 父 Entry ID。 */
	readonly parentId: string | null;
	/** Entry 时间戳。 */
	readonly timestamp: string;
	/** 可向用户展示的本地摘要。 */
	readonly summary: string;
	/** 压缩前 Token 数。 */
	readonly tokensBefore: number;
	/** 压缩后估算 Token 数。 */
	readonly estimatedTokensAfter?: number;
	/** 可公开的 Usage。 */
	readonly usage?: PublicCompactionUsage;
	/** 统一白名单元数据。 */
	readonly metadata: CompactionMetadata;
	/** 类型层显式禁止原始 Provider Context 混入公共 Entry。 */
	readonly providerContext?: never;
}

/** RPC、Extension、HTML 与 TUI 可以公开的 Session Entry。 */
export type ExternalSessionEntry =
	| Exclude<SessionEntry, { type: "compaction" | "remote_compaction" }>
	| SanitizedCompactionEntry;

/** 对外公开的 Session Tree Node。 */
export interface ExternalSessionTreeNode {
	/** 已经过压缩边界净化的 Entry。 */
	readonly entry: ExternalSessionEntry;
	/** 已净化的子节点。 */
	readonly children: ExternalSessionTreeNode[];
	/** 用户设置的节点标签。 */
	readonly label?: string;
	/** 最近一次标签变更时间。 */
	readonly labelTimestamp?: string;
}

/** 构建迭代式 Tree 投影时使用的可变节点，返回前会被冻结。 */
interface MutableExternalSessionTreeNode {
	/** 已净化的 Session Entry。 */
	entry: ExternalSessionEntry;
	/** 正在构建的子节点。 */
	children: MutableExternalSessionTreeNode[];
	/** 用户设置的节点标签。 */
	label?: string;
	/** 最近一次标签变更时间。 */
	labelTimestamp?: string;
}

/** 只携带固定错误码和固定消息的外部压缩错误。 */
export class CompactionBoundaryError extends Error {
	/** 可供调用方稳定分支的安全错误码。 */
	readonly code: CompactionMetadataErrorCode;

	/** 使用固定消息创建不可变错误，不保留原始 Cause、Details 或 Stack。 */
	constructor(code: CompactionMetadataErrorCode) {
		super(COMPACTION_ERROR_MESSAGES[code]);
		this.name = "CompactionBoundaryError";
		this.code = code;
		this.stack = undefined;
		Object.freeze(this);
	}
}

/** 固定错误码集合，禁止把 Provider 自定义文本当作错误码公开。 */
const COMPACTION_ERROR_CODES = new Set<CompactionMetadataErrorCode>([
	"unsupported",
	"invalid_context",
	"binding_mismatch",
	"capacity",
	"protocol",
	"aborted",
	"provider_error",
	"cancelled",
	"already_compacted",
	"nothing_to_compact",
	"no_model",
	"in_progress",
	"stale_branch",
	"invalid_hook_result",
	"commit_indeterminate",
	"committed_restart_required",
	"unknown",
]);

/** 固定错误消息，不拼接原始 Provider Error。 */
const COMPACTION_ERROR_MESSAGES = {
	unsupported: "Remote compaction is not supported.",
	invalid_context: "Remote compaction context is invalid.",
	binding_mismatch: "Remote compaction context does not match the active provider.",
	capacity: "Remote compaction input exceeds the supported capacity.",
	protocol: "Remote compaction protocol is incompatible.",
	aborted: "Remote compaction was aborted.",
	provider_error: "Remote compaction provider request failed.",
	cancelled: "Compaction was cancelled.",
	already_compacted: "The current context is already compacted.",
	nothing_to_compact: "The current session is too small to compact.",
	no_model: "No model is selected for compaction.",
	in_progress: "Another compaction attempt is already in progress.",
	stale_branch: "The active session branch changed during compaction.",
	invalid_hook_result: "The compaction extension returned a result that is not valid for this strategy.",
	commit_indeterminate: "Compaction commit could not be confirmed. Restart before retrying.",
	committed_restart_required:
		"Compaction was committed, but the active context could not be rebuilt. Restart required.",
	unknown: "Compaction failed.",
} as const satisfies Record<CompactionMetadataErrorCode, string>;

/** 从对象读取 own data property，Accessor 不会被执行。 */
function readOwnDataProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** 优先读取可信 Options，其次读取内部 metadata，最后读取源对象顶层字段。 */
function readMetadataValue(source: unknown, options: CompactionMetadataOptions, key: string): unknown {
	const optionValue = readOwnDataProperty(options, key);
	if (optionValue !== undefined) return optionValue;
	const metadata = readOwnDataProperty(source, "metadata");
	const metadataValue = readOwnDataProperty(metadata, key);
	return metadataValue === undefined ? readOwnDataProperty(source, key) : metadataValue;
}

/** 只接受非空字符串。 */
function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 只接受有限且非负的公开数值。 */
function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 读取固定 Union 值。 */
function readEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
	return typeof value === "string" && allowed.has(value as T) ? (value as T) : undefined;
}

/** 复制固定 Usage 数值字段；结构不完整时整段省略。 */
function copyPublicUsage(value: unknown): PublicCompactionUsage | undefined {
	const inputTokens = readNumber(readOwnDataProperty(value, "inputTokens"));
	const outputTokens = readNumber(readOwnDataProperty(value, "outputTokens"));
	const nativeTotalTokens = readNumber(readOwnDataProperty(value, "totalTokens"));
	if (
		inputTokens !== undefined &&
		outputTokens !== undefined &&
		nativeTotalTokens !== undefined &&
		Number.isSafeInteger(inputTokens) &&
		Number.isSafeInteger(outputTokens) &&
		Number.isSafeInteger(nativeTotalTokens)
	) {
		return Object.freeze({ inputTokens, outputTokens, totalTokens: nativeTotalTokens });
	}

	const input = readNumber(readOwnDataProperty(value, "input"));
	const output = readNumber(readOwnDataProperty(value, "output"));
	const cacheRead = readNumber(readOwnDataProperty(value, "cacheRead"));
	const cacheWrite = readNumber(readOwnDataProperty(value, "cacheWrite"));
	const totalTokens = readNumber(readOwnDataProperty(value, "totalTokens"));
	const costValue = readOwnDataProperty(value, "cost");
	const costInput = readNumber(readOwnDataProperty(costValue, "input"));
	const costOutput = readNumber(readOwnDataProperty(costValue, "output"));
	const costCacheRead = readNumber(readOwnDataProperty(costValue, "cacheRead"));
	const costCacheWrite = readNumber(readOwnDataProperty(costValue, "cacheWrite"));
	const costTotal = readNumber(readOwnDataProperty(costValue, "total"));
	if (
		input === undefined ||
		output === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined ||
		totalTokens === undefined ||
		costInput === undefined ||
		costOutput === undefined ||
		costCacheRead === undefined ||
		costCacheWrite === undefined ||
		costTotal === undefined
	) {
		return undefined;
	}

	const cost = Object.freeze({
		input: costInput,
		output: costOutput,
		cacheRead: costCacheRead,
		cacheWrite: costCacheWrite,
		total: costTotal,
	});
	return Object.freeze({
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h: readNumber(readOwnDataProperty(value, "cacheWrite1h")),
		reasoning: readNumber(readOwnDataProperty(value, "reasoning")),
		totalTokens,
		cost,
	});
}

/** 构造所有展示边界共用的压缩元数据白名单。 */
export function createCompactionMetadata(source: unknown, options: CompactionMetadataOptions = {}): CompactionMetadata {
	const type = readString(readOwnDataProperty(source, "type"));
	const inferredStrategy: EffectiveCompactionStrategy = type === "remote_compaction" ? "remote" : "local";
	const effectiveStrategy =
		readEnum(readMetadataValue(source, options, "effectiveStrategy"), new Set(["local", "remote"] as const)) ??
		inferredStrategy;
	const requestedStrategy =
		readEnum(
			readMetadataValue(source, options, "requestedStrategy"),
			new Set(["local", "remote", "auto"] as const),
		) ?? effectiveStrategy;
	const tokensBefore = readNumber(readMetadataValue(source, options, "tokensBefore")) ?? 0;
	const usage = copyPublicUsage(readMetadataValue(source, options, "usage"));

	return Object.freeze({
		attemptId: readString(readMetadataValue(source, options, "attemptId")),
		operationId: readString(readMetadataValue(source, options, "operationId")),
		reason: readEnum(
			readMetadataValue(source, options, "reason"),
			new Set(["manual", "threshold", "overflow"] as const),
		),
		requestedStrategy,
		effectiveStrategy,
		protocol: readString(readMetadataValue(source, options, "protocol")),
		provider: readString(readMetadataValue(source, options, "provider")),
		model: readString(readMetadataValue(source, options, "model")),
		tokensBefore,
		estimatedTokensAfter: readNumber(readMetadataValue(source, options, "estimatedTokensAfter")),
		usage,
		fallbackCode: readEnum(readMetadataValue(source, options, "fallbackCode"), COMPACTION_ERROR_CODES),
		errorCode: readEnum(readMetadataValue(source, options, "errorCode"), COMPACTION_ERROR_CODES),
		experimental: true,
	});
}

/** 把内部 Compaction Result 投影成外部安全 DTO。 */
export function createSanitizedCompactionResult(
	source: CompactionResult | unknown,
	options: CompactionMetadataOptions = {},
): SanitizedCompactionResult {
	const metadata = createCompactionMetadata(source, options);
	return Object.freeze({
		summary: typeof readOwnDataProperty(source, "summary") === "string" ? readOwnDataProperty(source, "summary") : "",
		tokensBefore: metadata.tokensBefore,
		estimatedTokensAfter: metadata.estimatedTokensAfter,
		usage: metadata.usage,
		metadata,
	}) as SanitizedCompactionResult;
}

/** 把本地或未来远端 Compaction Entry 投影成外部安全 DTO。 */
export function createSanitizedCompactionEntry(
	source: CompactionEntry | unknown,
	options: CompactionMetadataOptions = {},
): SanitizedCompactionEntry {
	const type = readOwnDataProperty(source, "type") === "remote_compaction" ? "remote_compaction" : "compaction";
	const metadata = createCompactionMetadata(source, options);
	const parentId = readOwnDataProperty(source, "parentId");
	return Object.freeze({
		type,
		id: readString(readOwnDataProperty(source, "id")) ?? "",
		parentId: parentId === null ? null : (readString(parentId) ?? null),
		timestamp: readString(readOwnDataProperty(source, "timestamp")) ?? "",
		summary: typeof readOwnDataProperty(source, "summary") === "string" ? readOwnDataProperty(source, "summary") : "",
		tokensBefore: metadata.tokensBefore,
		estimatedTokensAfter: metadata.estimatedTokensAfter,
		usage: metadata.usage,
		metadata,
	}) as SanitizedCompactionEntry;
}

/** 净化一个 Session Entry；非压缩 Entry 保持既有公开行为。 */
export function createExternalSessionEntry(entry: SessionEntry | unknown): ExternalSessionEntry {
	const type = readOwnDataProperty(entry, "type");
	if (type === "compaction" || type === "remote_compaction") {
		return createSanitizedCompactionEntry(entry);
	}
	return entry as Exclude<SessionEntry, { type: "compaction" | "remote_compaction" }>;
}

/** 净化按追加顺序返回的 Session Entry 列表。 */
export function createExternalSessionEntries(entries: readonly SessionEntry[]): ExternalSessionEntry[] {
	return Object.freeze(entries.map((entry) => createExternalSessionEntry(entry))) as ExternalSessionEntry[];
}

/** 净化 Session Tree，同时保留父子关系与用户标签。 */
export function createExternalSessionTree(nodes: readonly SessionTreeNode[]): ExternalSessionTreeNode[] {
	const createNode = (node: SessionTreeNode): MutableExternalSessionTreeNode => ({
		entry: createExternalSessionEntry(node.entry),
		children: [],
		label: typeof node.label === "string" ? node.label : undefined,
		labelTimestamp: typeof node.labelTimestamp === "string" ? node.labelTimestamp : undefined,
	});
	const roots = nodes.map(createNode);
	const pending = nodes.map((source, index) => ({ source, target: roots[index] }));
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		current.target.children = current.source.children.map(createNode);
		for (let index = 0; index < current.source.children.length; index++) {
			pending.push({ source: current.source.children[index], target: current.target.children[index] });
		}
	}

	// 深链不能使用递归冻结，否则长会话会在进入展示边界前耗尽调用栈。
	const freezePending = [...roots];
	while (freezePending.length > 0) {
		const node = freezePending.pop();
		if (!node) break;
		freezePending.push(...node.children);
		Object.freeze(node.children);
		Object.freeze(node);
	}
	return Object.freeze(roots) as ExternalSessionTreeNode[];
}

/** 把内部异常替换成固定错误码与固定消息，不复制原始 Error 文本。 */
export function sanitizeCompactionError(error: unknown): CompactionBoundaryError {
	if (error instanceof CompactionBoundaryError) return new CompactionBoundaryError(error.code);
	if (error instanceof NativeCompactionError) return new CompactionBoundaryError(error.code);
	if (error instanceof Error && error.name === "AbortError") return new CompactionBoundaryError("aborted");
	if (error instanceof Error) {
		if (error.message === "Compaction cancelled") return new CompactionBoundaryError("cancelled");
		if (error.message === "Already compacted") return new CompactionBoundaryError("already_compacted");
		if (error.message === "Nothing to compact (session too small)") {
			return new CompactionBoundaryError("nothing_to_compact");
		}
		if (error.message.startsWith("No model selected")) return new CompactionBoundaryError("no_model");
	}
	return new CompactionBoundaryError("unknown");
}
