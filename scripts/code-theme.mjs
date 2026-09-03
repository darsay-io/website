/**
 * The docs' code theme: the site's own gold on space, so a command block
 * reads like one of the board's terminal stages and not like a borrowed
 * editor. A VS Code theme in shape; astro.config.mjs hands it to Expressive
 * Code. The frame chrome (border, title bar, dots, copy button) is set
 * there too, in `styleOverrides`, and the dots are recoloured in docs.css.
 *
 * The palette is site.css's: ivory text, gold for the word that acts (the
 * command, the keyword), sage for a flag, amber for a number, parchment for
 * a quoted string, and comments dimmed and italic.
 */
const IVORY = "#e6dcc6";
const IVORY_HI = "#f3ead8";
const GOLD = "#d4b06a";
const GOLD_HI = "#f0d9a0";
const GOLD_SOFT = "#dcc9a0";
const PARCHMENT = "#d9cdb2";
const SAGE = "#b9c9a3";
const AMBER = "#e6b978";
const MUTED = "#b5a894";
const DIM = "#8a8071";
const DANGER = "#d4847a";

export const codeTheme = {
	name: "darsay",
	type: "dark",
	colors: {
		"editor.background": "#0a090f",
		"editor.foreground": IVORY,
		"editorLineNumber.foreground": "#5e5747",
		"editorLineNumber.activeForeground": MUTED,
		"editor.selectionBackground": "#3a311c",
		"terminal.background": "#0a090f",
		"terminal.foreground": IVORY,
		"titleBar.activeBackground": "#0c0b12",
		"titleBar.activeForeground": MUTED,
		"tab.activeBackground": "#0a090f",
		"tab.activeForeground": GOLD_HI,
		"editorGroupHeader.tabsBackground": "#0c0b12",
		"widget.shadow": "#00000000",
	},
	tokenColors: [
		{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: DIM, fontStyle: "italic" } },
		// The command is the word that acts.
		{
			scope: ["entity.name.command", "entity.name.function", "support.function", "meta.function-call.generic"],
			settings: { foreground: GOLD_HI },
		},
		{
			scope: ["support.function.builtin", "keyword", "storage", "storage.type", "storage.modifier", "keyword.control"],
			settings: { foreground: GOLD },
		},
		{ scope: ["keyword.operator"], settings: { foreground: MUTED } },
		{ scope: ["constant.other.option", "constant.other.option.dash"], settings: { foreground: SAGE } },
		{ scope: ["string"], settings: { foreground: PARCHMENT } },
		{ scope: ["string.unquoted.argument"], settings: { foreground: IVORY } },
		{ scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: AMBER } },
		{ scope: ["variable", "variable.other", "variable.other.assignment", "variable.parameter"], settings: { foreground: GOLD_SOFT } },
		{
			scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class"],
			settings: { foreground: IVORY_HI },
		},
		{ scope: ["entity.name.tag", "entity.name.section"], settings: { foreground: GOLD } },
		// JSON and TOML keys.
		{ scope: ["support.type.property-name", "keyword.key.toml", "variable.key"], settings: { foreground: GOLD_HI } },
		{ scope: ["punctuation.definition.string", "punctuation.separator", "punctuation.terminator"], settings: { foreground: MUTED } },
		{ scope: ["markup.heading", "markup.bold"], settings: { foreground: GOLD_HI, fontStyle: "bold" } },
		{ scope: ["markup.italic"], settings: { fontStyle: "italic" } },
		{ scope: ["markup.inserted"], settings: { foreground: "#9ab48e" } },
		{ scope: ["markup.deleted"], settings: { foreground: DANGER } },
		{ scope: ["markup.changed"], settings: { foreground: GOLD } },
		{ scope: ["invalid", "invalid.illegal"], settings: { foreground: DANGER } },
	],
};
