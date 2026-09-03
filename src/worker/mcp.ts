/**
 * The board as an MCP server — Streamable HTTP, stateless, no SDK. Every
 * call is one JSON-RPC request answered with one JSON response; the
 * bearer names the board (a key, or the board id itself), so there is no
 * session to keep. Tools are the same operations the REST API exposes,
 * plus `explain`: the field guide, so an agent can learn what a chip on
 * a row means before it acts on it.
 */
import { LENS_BY_KEY } from "../lib/lenses.ts";
import { SCOPES } from "./access.ts";
import type { OpCtx, OpResult } from "./ops.ts";
import {
	opApply,
	opAudit,
	opBatch,
	opBoard,
	opRow,
	opRowAdd,
	opRowDrop,
	opRowPatch,
	opRowRemove,
	opRowRestore,
	opRows,
} from "./ops.ts";
import { cardToApi, guideIndex, resolveCard } from "./guide.ts";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_SERVER = { name: "darsay.io board", version: "1.0.0" };

const INSTRUCTIONS = [
	"This server is one darsay.io board: a want-list of models and datasets a group is archiving into their own vaults.",
	"A board has rows, not cards, and no columns. A row wants or has a work (status), is rated 1–9 (desire, which orders the list), carries a short note, and names who holds a copy (holders).",
	"A row's identity is its address: the canonical source (huggingface:owner/name, huggingface:datasets/owner/name, or an https home page for a closed work), the pinned revision, and the include set. add_row and apply match on that address, so re-sending is safe.",
	"Chips on a row (negatives, quant, gated, large, redundant, subset, closed, family…) are read from the work, never written by hand; call explain with a chip to learn what it means.",
	"drop_row is undoable; remove_row is not. Pass expect_revision (from get_board) to refuse a write when someone else changed the board first. Use apply with dry_run: true to see a plan before committing it.",
].join("\n");

type JsonRpcId = string | number | null;

type Tool = {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly?: boolean;
	destructive?: boolean;
	idempotent?: boolean;
	run: (ctx: OpCtx, args: Record<string, unknown>) => Promise<OpResult>;
};

const ROW_FIELDS = {
	desire: { type: ["integer", "null"], minimum: 1, maximum: 9, description: "How much the group wants it, 1–9; orders the list. null clears it." },
	note: { type: ["string", "null"], maxLength: 500, description: "A sentence for why this one (plain text, 500 characters)." },
	status: { type: "string", enum: ["want", "have"], description: "want until someone holds a copy; have is the checkmark." },
	holders: { type: "string", maxLength: 500, description: "Who holds a copy — a name, a disk, a city." },
};

const ADDRESS_FIELDS = {
	source: {
		type: "string",
		maxLength: 300,
		description: "owner/name, huggingface:owner/name, datasets/owner/name, a Hub URL, or an https home page for a closed work.",
	},
	revision: { type: ["string", "null"], maxLength: 64, description: "A commit or tag to pin; null means the default branch." },
	include: { type: ["array", "null"], items: { type: "string", maxLength: 80 }, maxItems: 8, description: "Glob patterns that make this row a subset of the repo." },
};

const ID = { type: "integer", minimum: 1, description: "The row's stable id from get_board or find_rows." };
const EXPECT = { type: "integer", minimum: 0, description: "The board revision you last read; the write is refused (stale) if the board moved." };

const int = (v: unknown): number => (typeof v === "number" ? v : Number(v));

function withRevision(ctx: OpCtx, args: Record<string, unknown>): OpCtx {
	const r = args.expect_revision;
	return { ...ctx, expectRevision: typeof r === "number" && Number.isInteger(r) ? r : null };
}

export const TOOLS: Tool[] = [
	{
		name: "get_board",
		title: "Read the board",
		description: "The whole board: title, note, revision, counts, and every row in the canonical order (desire high to low, unrated last, then as added). Read this first; its revision is what expect_revision refers to.",
		inputSchema: {
			type: "object",
			properties: { dropped: { type: "string", enum: ["none", "all", "only"], description: "Whether dropped rows are included (default none)." } },
			additionalProperties: false,
		},
		readOnly: true,
		idempotent: true,
		run: (ctx, a) => opBoard(ctx, { dropped: a.dropped }),
	},
	{
		name: "find_rows",
		title: "Find rows",
		description: "Rows matching an address, a status, a type, the board's own lenses, a family, a desire range, or free text. The cheap way to ask whether a work is already on the board: pass source.",
		inputSchema: {
			type: "object",
			properties: {
				q: { type: "string", description: "Free text matched against source, note, holders, family, and member." },
				source: { type: "string", description: "An address in any accepted spelling; matched after canonicalization." },
				status: { type: "string", enum: ["want", "have"] },
				type: { type: "string", enum: ["model", "dataset", "closed", "opaque"] },
				lens: { type: "string", description: "Comma-separated lens keys, AND-combined: " + Object.keys(LENS_BY_KEY).join(", ") + "." },
				family: { type: "string", description: "A family key as read from the names (qwen, kimi, deepseek…)." },
				desire_min: { type: "integer", minimum: 1, maximum: 9 },
				desire_max: { type: "integer", minimum: 1, maximum: 9 },
				dropped: { type: "string", enum: ["none", "all", "only"] },
				limit: { type: "integer", minimum: 0 },
			},
			additionalProperties: false,
		},
		readOnly: true,
		idempotent: true,
		run: (ctx, a) => opRows(ctx, a),
	},
	{
		name: "get_row",
		title: "Read one row",
		description: "One row by id, dropped or not.",
		inputSchema: { type: "object", properties: { id: ID }, required: ["id"], additionalProperties: false },
		readOnly: true,
		idempotent: true,
		run: (ctx, a) => opRow(ctx, int(a.id)),
	},
	{
		name: "add_row",
		title: "Add a row",
		description: "Ensure a work is on the board. Matched by address: a new address is priced from the Hub and added; an existing one is updated with the fields you pass (a dropped one is restored); an identical one is left untouched. Safe to repeat.",
		inputSchema: {
			type: "object",
			properties: { ...ADDRESS_FIELDS, ...ROW_FIELDS, expect_revision: EXPECT },
			required: ["source"],
			additionalProperties: false,
		},
		idempotent: true,
		run: (ctx, a) => opRowAdd(withRevision(ctx, a), a),
	},
	{
		name: "update_row",
		title: "Update a row",
		description: "Change any subset of a row's columns by id. Changing the address re-prices the row and must not collide with another row.",
		inputSchema: {
			type: "object",
			properties: { id: ID, ...ADDRESS_FIELDS, ...ROW_FIELDS, expect_revision: EXPECT },
			required: ["id"],
			additionalProperties: false,
		},
		idempotent: true,
		run: (ctx, a) => opRowPatch(withRevision(ctx, a), int(a.id), a),
	},
	{
		name: "drop_row",
		title: "Drop a row",
		description: "A soft removal: the row leaves the list and the catalog export but stays restorable. Prefer this over remove_row.",
		inputSchema: { type: "object", properties: { id: ID, expect_revision: EXPECT }, required: ["id"], additionalProperties: false },
		idempotent: true,
		run: (ctx, a) => opRowDrop(withRevision(ctx, a), int(a.id)),
	},
	{
		name: "restore_row",
		title: "Restore a row",
		description: "Bring a dropped row back exactly as it was.",
		inputSchema: { type: "object", properties: { id: ID, expect_revision: EXPECT }, required: ["id"], additionalProperties: false },
		idempotent: true,
		run: (ctx, a) => opRowRestore(withRevision(ctx, a), int(a.id)),
	},
	{
		name: "remove_row",
		title: "Remove a row",
		description: "Delete a row for good (needs the remove scope). The audit trail keeps what it was.",
		inputSchema: { type: "object", properties: { id: ID, expect_revision: EXPECT }, required: ["id"], additionalProperties: false },
		destructive: true,
		run: (ctx, a) => opRowRemove(withRevision(ctx, a), int(a.id)),
	},
	{
		name: "apply",
		title: "Apply a list",
		description: "Ensure a whole list is on the board in one transactional call: match by address, add what is missing, update what differs, restore what was dropped, leave the identical alone. mode sync also drops (never removes) live rows the list left out. dry_run returns the plan without writing. Up to 100 rows; the first dozen new Hub rows are priced on the spot, the rest land unpriced until the CLI's next round trip.",
		inputSchema: {
			type: "object",
			properties: {
				rows: {
					type: "array",
					maxItems: 100,
					items: {
						type: "object",
						properties: { ref: { type: "string", maxLength: 80, description: "Your own handle for this row, echoed back." }, ...ADDRESS_FIELDS, ...ROW_FIELDS },
						required: ["source"],
						additionalProperties: false,
					},
				},
				mode: { type: "string", enum: ["upsert", "sync"], description: "upsert (default) touches only the rows named; sync also drops the rest." },
				dry_run: { type: "boolean" },
				expect_revision: EXPECT,
			},
			required: ["rows"],
			additionalProperties: false,
		},
		idempotent: true,
		run: (ctx, a) => opApply(withRevision(ctx, a), a),
	},
	{
		name: "batch",
		title: "Run a batch",
		description: "Explicit operations — add (by address), update, drop, restore, remove (by id) — checked as a whole and written as a whole. One bad operation fails the batch and nothing is written. dry_run returns what would happen.",
		inputSchema: {
			type: "object",
			properties: {
				operations: {
					type: "array",
					maxItems: 100,
					items: {
						type: "object",
						properties: {
							op: { type: "string", enum: ["add", "update", "drop", "restore", "remove"] },
							ref: { type: "string", maxLength: 80 },
							id: { type: "integer", minimum: 1 },
							...ADDRESS_FIELDS,
							...ROW_FIELDS,
						},
						required: ["op"],
						additionalProperties: false,
					},
				},
				dry_run: { type: "boolean" },
				expect_revision: EXPECT,
			},
			required: ["operations"],
			additionalProperties: false,
		},
		run: (ctx, a) => opBatch(withRevision(ctx, a), a),
	},
	{
		name: "audit",
		title: "Read the audit trail",
		description: "Who did what, newest first: action, actor (url, cli, or key:<label>), the row, and the columns before and after. Page with before.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 200 },
				before: { type: "integer", minimum: 1, description: "Events with an id below this one." },
				entry: { type: "integer", minimum: 1, description: "Only events on this row." },
			},
			additionalProperties: false,
		},
		readOnly: true,
		idempotent: true,
		run: (ctx, a) => opAudit(ctx, a),
	},
	{
		name: "explain",
		title: "Explain a chip",
		description: "The field guide: what a chip, lens, or column on a row means and what a collector should do about it. Pass a word such as negatives, quant, gated, large, redundant, subset, closed, family, desire, claims, dataset, or moe. With no chip, the whole guide.",
		inputSchema: { type: "object", properties: { chip: { type: "string", maxLength: 40 } }, additionalProperties: false },
		readOnly: true,
		idempotent: true,
		run: async (ctx, a) => {
			if (typeof a.chip !== "string" || !a.chip.trim()) return { status: 200, body: guideIndex(ctx.origin) };
			const card = resolveCard(a.chip);
			if (!card) return { status: 404, body: { error: "no card for " + JSON.stringify(a.chip.slice(0, 40)), chips: guideIndex(ctx.origin).chips } };
			return { status: 200, body: cardToApi(card, ctx.origin) };
		},
	},
];

export const TOOL_BY_NAME: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function toolListing(t: Tool) {
	return {
		name: t.name,
		title: t.title,
		description: t.description,
		inputSchema: t.inputSchema,
		annotations: {
			title: t.title,
			readOnlyHint: !!t.readOnly,
			destructiveHint: !!t.destructive,
			idempotentHint: !!t.idempotent,
			openWorldHint: false,
		},
	};
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id: JsonRpcId, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function toolResult(res: OpResult) {
	const isObject = res.body !== null && typeof res.body === "object" && !Array.isArray(res.body);
	const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
	return {
		content: [{ type: "text", text }],
		...(isObject ? { structuredContent: res.body } : {}),
		...(res.status >= 400 ? { isError: true } : {}),
	};
}

export type McpRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/**
 * Answer one JSON-RPC message. Returns null for a notification (the
 * transport answers 202 with no body). `ctxFor` builds a fresh operation
 * context per call so the board revision a tool sees is current.
 */
export async function dispatch(msg: McpRequest, ctxFor: () => Promise<OpCtx>): Promise<Record<string, unknown> | null> {
	const id: JsonRpcId = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
	const isNotification = msg.id === undefined;
	if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
		return isNotification ? null : rpcError(id, -32600, "invalid request");
	}
	const params = msg.params !== null && typeof msg.params === "object" && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {};
	if (isNotification) return null;
	switch (msg.method) {
		case "initialize": {
			const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
			const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
			return rpcResult(id, {
				protocolVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: MCP_SERVER,
				instructions: INSTRUCTIONS + "\nScopes a key may carry: " + SCOPES.join(", ") + ".",
			});
		}
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, { tools: TOOLS.map(toolListing) });
		case "tools/call": {
			const name = typeof params.name === "string" ? params.name : "";
			const tool = TOOL_BY_NAME[name];
			if (!tool) return rpcError(id, -32602, "unknown tool", { name: name.slice(0, 40), tools: TOOLS.map((t) => t.name) });
			const args = params.arguments !== null && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
			const ctx = await ctxFor();
			const res = await tool.run(ctx, args);
			return rpcResult(id, toolResult(res));
		}
		default:
			return rpcError(id, -32601, "method not found", { method: msg.method.slice(0, 60) });
	}
}
