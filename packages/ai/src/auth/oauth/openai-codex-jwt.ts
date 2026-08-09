/**
 * OpenAI Codex Access Token 中稳定账号标识的无副作用解析器。
 *
 * 本模块不校验 JWT 签名，也不负责认证；它只读取已经由 OAuth 流程取得的
 * Token，使认证 Binding 与实际请求 Header 使用完全相同的 Subject 来源。
 */

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** 解码 Base64URL JWT Payload，并安全读取 ChatGPT Account ID。 */
export function parseOpenAICodexAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padding = (4 - (normalized.length % 4)) % 4;
		const binary = atob(`${normalized}${"=".repeat(padding)}`);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
		const auth = (payload as Record<string, unknown>)[JWT_CLAIM_PATH];
		if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return undefined;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}
