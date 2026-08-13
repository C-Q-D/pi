import { stripVTControlCharacters } from "node:util";
import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { createSanitizedCompactionResult, type SanitizedCompactionResult } from "../../../core/compaction/index.ts";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** Provider/Model 标识可能来自配置；展示前移除终端控制字符并保持单行。 */
function sanitizeMetadataText(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: SanitizedCompactionResult;
	private markdownTheme: MarkdownTheme;

	constructor(
		message: CompactionSummaryMessage | SanitizedCompactionResult,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = createSanitizedCompactionResult(message);
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const strategy = this.message.metadata.effectiveStrategy;
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction:${strategy}]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const metadata = this.message.metadata;
			const lines = [
				`Compacted from ${tokenStr} tokens`,
				`Requested: ${metadata.requestedStrategy}`,
				`Effective: ${metadata.effectiveStrategy}`,
			];
			const provider = metadata.provider ? sanitizeMetadataText(metadata.provider) : "";
			const model = metadata.model ? sanitizeMetadataText(metadata.model) : "";
			const protocol = metadata.protocol ? sanitizeMetadataText(metadata.protocol) : "";
			if (provider) lines.push(`Provider: ${provider}`);
			if (model) lines.push(`Model: ${model}`);
			if (protocol) lines.push(`Protocol: ${protocol}`);
			if (metadata.estimatedTokensAfter !== undefined) {
				lines.push(`Estimated after: ${metadata.estimatedTokensAfter.toLocaleString()} tokens`);
			}
			if (metadata.fallbackCode) lines.push(`Fallback: ${metadata.fallbackCode}`);
			this.addChild(new Text(theme.fg("customMessageText", lines.join("\n")), 0, 0));
			if (strategy === "remote") {
				this.addChild(new Spacer(1));
				this.addChild(
					new Text(theme.fg("customMessageText", "Opaque provider context (content is not readable)."), 0, 0),
				);
			} else if (this.message.summary) {
				this.addChild(new Spacer(1));
				this.addChild(
					new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("customMessageText", text),
					}),
				);
			}
		} else {
			const requested = this.message.metadata.requestedStrategy;
			const strategyText = requested === strategy ? strategy : `${requested}→${strategy}`;
			this.addChild(
				new Text(
					theme.fg("customMessageText", `${strategyText} compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
