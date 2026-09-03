// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import { buildSidebar } from './scripts/sidebar.mjs';

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
			customCss: ['./src/styles/site.css'],
			// The MCP server card, for a program that reads the page before the
			// JSON. Not yet a registered relation; the Link header in
			// public/_headers says the same.
			head: [{ tag: 'link', attrs: { rel: 'mcp', href: '/.well-known/mcp-server-card', type: 'application/json' } }],
			// Computed from the pages that exist (scripts/sidebar.mjs), so a new
			// CLI docs page reaches the sidebar with no edit here.
			sidebar: buildSidebar(),
		}),
	],
});
