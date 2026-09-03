/**
 * The server card: one static document that says where the MCP server is,
 * what it speaks, and which header opens it — so a program that knows
 * only darsay.io can walk to the board's tools without being told they
 * exist. Served at `/.well-known/mcp-server-card` (the site-level address
 * SEP-2127 proposes) and at `/mcp/server-card` (the address beside the
 * endpoint that the working group's reference extension recommends).
 *
 * The shape is the MCP Registry's `server.json`: the card proposal is
 * defined as a subset of it, and the registry schema is the one that is
 * published today, so the same document is what `mcp-publisher publish`
 * reads (ops/RUNBOOK.md § MCP discovery). When the card's own schema goes
 * live, `$schema` moves; nothing else should. Tools are not listed here on
 * purpose — the proposal leaves them to `tools/list`, which is the only
 * answer that cannot go stale.
 */
import { MCP_PROTOCOL_VERSIONS, MCP_SERVER } from "./mcp.ts";

/** The server's registry name: the reverse-DNS of darsay.io, then the thing it serves. */
export const CARD_NAME = "io.darsay/board";
export const CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
/** The site-level address; `/mcp/server-card` answers the same document. */
export const CARD_PATH = "/.well-known/mcp-server-card";
export const CARD_PATHS = [CARD_PATH, "/mcp/server-card"] as const;
/** How long the card may be kept; the proposal recommends an hour. */
export const CARD_MAX_AGE = 3600;

export function serverCard(origin: string) {
	return {
		$schema: CARD_SCHEMA,
		name: CARD_NAME,
		title: MCP_SERVER.title,
		description: "A darsay.io board as tools: read the want-list, add rows by address, apply a list, explain a chip.",
		version: MCP_SERVER.version,
		websiteUrl: origin + "/docs/board/agents/",
		repository: { url: "https://github.com/darsay-io/website", source: "github" },
		remotes: [
			{
				type: "streamable-http",
				url: origin + "/mcp",
				supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS],
				headers: [
					{
						name: "Authorization",
						value: "Bearer {key}",
						description: "A board key (darsay_…) names one board with the scopes it was given and never learns the URL; the board id itself is also accepted. Keys are minted from the board's Agents panel or POST /api/boards/{id}/keys.",
						isRequired: true,
						isSecret: true,
						variables: {
							key: { description: "A board key, or the board id.", isRequired: true, isSecret: true },
						},
					},
				],
			},
		],
		_meta: {
			"io.darsay/openapi": origin + "/openapi.json",
			"io.darsay/docs": origin + "/docs/board/agents/",
			"io.darsay/guide": origin + "/api/guide",
			"io.darsay/llms": origin + "/llms.txt",
		},
	};
}
