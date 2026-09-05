/**
 * `/llms.txt`, written at build time from the pages that exist (see
 * scripts/llms.mjs). Served as a static asset, so it needs no Worker.
 *
 * The page directories are named from the project root, not from this
 * module's location: at prerender the bundle lives under `dist/`, where
 * `scripts/sidebar.mjs`'s own relative root would point at nothing.
 */
import type { APIRoute } from "astro";
import path from "node:path";
import { buildLlmsTxt } from "../../scripts/llms.mjs";

const root = process.cwd();

export const GET: APIRoute = () =>
	new Response(
		buildLlmsTxt({
			syncedDir: path.join(root, "src/content/docs/docs"),
			authoredDirs: [path.join(root, "src/content/docs/board"), path.join(root, "src/content/docs/learn")],
		}),
		{ headers: { "Content-Type": "text/plain; charset=utf-8" } },
	);
