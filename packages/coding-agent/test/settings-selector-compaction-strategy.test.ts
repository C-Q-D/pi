import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function createConfig(): SettingsConfig {
	return {
		autoCompact: true,
		compactionStrategy: "local",
		showImages: false,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300_000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark"],
		hideThinkingBlock: false,
		showCacheMissNotices: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		outputPad: 1,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
	};
}

function createCallbacks(
	onCompactionStrategyChange: SettingsCallbacks["onCompactionStrategyChange"],
): SettingsCallbacks {
	return {
		onAutoCompactChange: vi.fn(),
		onCompactionStrategyChange,
		onShowImagesChange: vi.fn(),
		onImageWidthCellsChange: vi.fn(),
		onAutoResizeImagesChange: vi.fn(),
		onBlockImagesChange: vi.fn(),
		onEnableSkillCommandsChange: vi.fn(),
		onSteeringModeChange: vi.fn(),
		onFollowUpModeChange: vi.fn(),
		onTransportChange: vi.fn(),
		onHttpIdleTimeoutMsChange: vi.fn(),
		onThinkingLevelChange: vi.fn(),
		onThemeChange: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onShowCacheMissNoticesChange: vi.fn(),
		onCollapseChangelogChange: vi.fn(),
		onEnableInstallTelemetryChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onOutputPadChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onDefaultProjectTrustChange: vi.fn(),
		onClearOnShrinkChange: vi.fn(),
		onShowTerminalProgressChange: vi.fn(),
		onWarningsChange: vi.fn(),
		onCancel: vi.fn(),
	};
}

describe("SettingsSelector compaction strategy", () => {
	it("shows the effective value and cycles through the three supported strategies", () => {
		const onChange = vi.fn<SettingsCallbacks["onCompactionStrategyChange"]>();
		const selector = new SettingsSelectorComponent(createConfig(), createCallbacks(onChange));
		const settingsList = selector.getSettingsList();

		settingsList.handleInput("compactionstrategy");
		const filtered = settingsList.render(100).map(stripVTControlCharacters).join("\n");
		expect(filtered).toContain("Compaction strategy");
		expect(filtered).toContain("local");

		settingsList.handleInput(" ");

		expect(onChange).toHaveBeenCalledWith("remote");
		expect(settingsList.render(100).map(stripVTControlCharacters).join("\n")).toContain("remote");
	});
});
