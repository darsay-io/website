// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

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
			sidebar: [
				{
					label: 'Using the vault',
					items: [
						{ label: 'Start here', slug: 'docs/getting-started' },
						{ label: 'Concepts', slug: 'docs/concepts' },
						{ label: 'Examples', slug: 'docs/examples' },
						{ label: 'Hydration', slug: 'docs/hydration' },
						{ label: 'Incremental transfer', slug: 'docs/incremental' },
						{ label: 'Datasets', slug: 'docs/datasets' },
						{ label: 'Sources', slug: 'docs/sources' },
						{ label: 'Quantization', slug: 'docs/quantization' },
						{ label: 'Catalogs', slug: 'docs/catalogs' },
					],
				},
				{
					label: 'The formats',
					items: [
						{ label: 'manifest.json', slug: 'docs/manifest' },
						{ label: '.mvb.tar', slug: 'docs/mvb-format' },
					],
				},
				{
					label: 'Project',
					items: [
						{ label: 'Design', slug: 'docs/design' },
						{ label: 'Distribution', slug: 'docs/distribution' },
						{ label: 'Testing', slug: 'docs/testing' },
						{
							label: 'GitHub',
							link: 'https://github.com/darsay-io/darsay',
						},
					],
				},
			],
		}),
	],
});
