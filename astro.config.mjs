// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';
import { codeTheme } from './scripts/code-theme.mjs';
import { buildSidebar } from './scripts/sidebar.mjs';

// The docs' code blocks: the site's gold on space (scripts/code-theme.mjs),
// in a frame with the board's terminal chrome. One palette, so one theme.
const GOLD = '#d4b06a';
const GOLD_HI = '#f0d9a0';
const HAIRLINE = 'rgba(212, 176, 106, 0.22)';
const expressiveCode = {
	themes: [new ExpressiveCodeTheme(codeTheme)],
	useStarlightDarkModeSwitch: false,
	useStarlightUiThemeColors: false,
	styleOverrides: {
		borderRadius: '10px',
		borderWidth: '1px',
		borderColor: HAIRLINE,
		codeFontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
		codeFontSize: '0.875rem',
		codeLineHeight: '1.65',
		codePaddingInline: '1.1rem',
		codePaddingBlock: '0.95rem',
		codeBackground: '#0a090f',
		codeForeground: '#e6dcc6',
		codeSelectionBackground: '#3a311c',
		uiFontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
		uiPaddingBlock: '0.4rem',
		uiPaddingInline: '0.85rem',
		scrollbarThumbColor: 'rgba(212, 176, 106, 0.28)',
		scrollbarThumbHoverColor: 'rgba(212, 176, 106, 0.5)',
		frames: {
			shadowColor: 'transparent',
			frameBoxShadowCssValue: 'none',
			editorBackground: '#0a090f',
			editorTabBarBackground: '#0c0b12',
			editorTabBarBorderColor: HAIRLINE,
			editorTabBarBorderBottomColor: HAIRLINE,
			editorActiveTabBackground: '#0a090f',
			editorActiveTabForeground: GOLD_HI,
			editorActiveTabBorderColor: HAIRLINE,
			editorActiveTabIndicatorTopColor: GOLD,
			editorActiveTabIndicatorBottomColor: 'transparent',
			editorActiveTabIndicatorHeight: '2px',
			terminalBackground: '#0a090f',
			terminalTitlebarBackground: '#0c0b12',
			terminalTitlebarForeground: '#b5a894',
			terminalTitlebarBorderBottomColor: HAIRLINE,
			terminalTitlebarDotsForeground: GOLD,
			terminalTitlebarDotsOpacity: '0.6',
			inlineButtonBackground: '#12101a',
			inlineButtonBackgroundIdleOpacity: '1',
			inlineButtonBackgroundHoverOrFocusOpacity: '1',
			inlineButtonBackgroundActiveOpacity: '1',
			inlineButtonForeground: GOLD_HI,
			inlineButtonBorder: GOLD,
			inlineButtonBorderOpacity: '0.45',
			tooltipSuccessBackground: GOLD,
			tooltipSuccessForeground: '#1a140c',
		},
	},
};

export default defineConfig({
	site: 'https://darsay.io',
	integrations: [
		sitemap({
			filter: (page) => {
				const path = new URL(page).pathname;
				return path !== "/b" && !path.startsWith("/b/") && path !== "/boards" && !path.startsWith("/boards/");
			},
		}),
		starlight({
			title: 'darsay',
			description: 'Keep a model forever. Run it tomorrow.',
			logo: {
				src: './src/assets/darsay-logo.png',
				alt: 'darsay',
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/darsay-io/darsay',
				},
			],
			// site.css is the tokens and the board; docs.css is the reading surface.
			customCss: ['./src/styles/site.css', './src/styles/docs.css'],
			expressiveCode,
			// The MCP server card, for a program that reads the page before the
			// JSON. Not yet a registered relation; the Link header in
			// public/_headers says the same.
			head: [{ tag: 'link', attrs: { rel: 'mcp', href: '/.well-known/mcp-server-card', type: 'application/json' } }],
			// Starlight's footer plus the site's own line — Agents & API, Privacy,
			// Terms — so every docs page carries an ordinary anchor to /agents/.
			// One palette: the theme is always dark and there is no picker.
			components: {
				Footer: './src/components/starlight/Footer.astro',
				ThemeProvider: './src/components/starlight/ThemeProvider.astro',
				ThemeSelect: './src/components/starlight/ThemeSelect.astro',
			},
			// Computed from the pages that exist (scripts/sidebar.mjs), so a new
			// CLI docs page reaches the sidebar with no edit here.
			sidebar: buildSidebar(),
		}),
	],
});
