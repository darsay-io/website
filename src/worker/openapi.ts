/**
 * The OpenAPI 3.1 document for the board API, built from one table of
 * board routes so the two address forms — `/api/boards/{id}/…` (the URL
 * is the capability) and `/api/board/…` (a bearer key names the board) —
 * are described once. `openapi.test.ts` holds this document against the
 * Hono router: a route without a spec entry, or a spec entry without a
 * route, fails the suite.
 */
import { SCOPES, SCOPE_HELP } from "./access.ts";
import { LENSES } from "../lib/lenses.ts";
import { MAX_APPLY_ROWS, PRICE_BUDGET } from "./ops.ts";
import { DESIRE_MAX, DESIRE_MIN, MAX_ENTRIES, MAX_ENTRY_NOTE, MAX_HOLDERS, MAX_INCLUDES, MAX_INCLUDE_GLOB, MAX_REVISION, MAX_SOURCE } from "./validate.ts";
import { WEBHOOK_EVENTS } from "./webhooks.ts";

type Json = Record<string, unknown>;

const ref = (name: string): Json => ({ $ref: "#/components/schemas/" + name });
const json = (schema: Json, description = ""): Json => ({ description, content: { "application/json": { schema } } });
const err = (description: string): Json => json(ref("Error"), description);

const SOURCE_DESC =
	"An address in any accepted spelling: owner/name, huggingface:owner/name, datasets/owner/name, a Hub URL, or an https home page (a closed work). Stored canonical: huggingface:owner/name, huggingface:datasets/owner/name, or the page URL.";

const schemas: Record<string, Json> = {
	Error: {
		type: "object",
		required: ["error"],
		properties: { error: { type: "string", description: "A short machine word: not_found, forbidden, stale, conflict, entry_cap, mutate_cap, lookup_cap, …" } },
		additionalProperties: true,
	},
	Address: {
		type: "object",
		description: "The row's address, structured.",
		required: ["kind", "provider", "locator", "url"],
		properties: {
			kind: { type: "string", enum: ["model", "dataset", "closed", "opaque"] },
			provider: { type: ["string", "null"], description: "huggingface for Hub rows; null for a closed work's home page." },
			locator: { type: "string", description: "owner/name on the provider, or the page URL." },
			url: { type: ["string", "null"] },
		},
	},
	Lineage: {
		type: "object",
		description: "Family, generation, member, variants, and formats — read from the work's name by a documented grammar, and labeled so.",
		properties: {
			family: { type: ["string", "null"] },
			generation: { type: ["string", "null"] },
			member: { type: ["string", "null"] },
			variants: { type: "array", items: { type: "string" } },
			formats: { type: "array", items: { type: "string" } },
			read_from: { type: "string", enum: ["name"] },
		},
	},
	Claim: {
		type: ["object", "null"],
		description: "A live claim: which client is fetching this row and how far along. Past 24 h without a report it stops rendering.",
		properties: {
			client: { type: "string" },
			state: { type: "string", enum: ["archiving", "paused", "done"] },
			percent: { type: ["integer", "null"] },
			banked_bytes: { type: ["integer", "null"] },
			total_bytes: { type: ["integer", "null"] },
			claimed_at: { type: "string" },
			updated: { type: "string" },
		},
	},
	Row: {
		type: "object",
		description: "One row of the ledger. The decided columns are desire, note, status, holders; everything else is read from the work.",
		required: ["id", "source", "revision", "include", "desire", "note", "status", "holders", "added", "updated", "address", "lineage"],
		properties: {
			id: { type: "integer", description: "Stable for the life of the row." },
			source: { type: "string", description: "The canonical address — the row's identity together with revision and include." },
			revision: { type: ["string", "null"] },
			include: { type: ["array", "null"], items: { type: "string" } },
			desire: { type: ["integer", "null"], minimum: DESIRE_MIN, maximum: DESIRE_MAX },
			note: { type: ["string", "null"] },
			status: { type: "string", enum: ["want", "have"] },
			holders: { type: "string" },
			added: { type: "string", format: "date-time" },
			updated: { type: "string", format: "date-time" },
			dropped: { type: ["string", "null"], format: "date-time", description: "Set while the row is dropped (soft-removed)." },
			address: ref("Address"),
			lineage: ref("Lineage"),
			payload_bytes: { type: ["integer", "null"], description: "The price: what darsay archive fetches for this row." },
			artifact_type: { type: ["string", "null"], enum: ["model", "dataset", null] },
			gated: { type: ["boolean", "null"] },
			parameters: { type: ["integer", "null"] },
			dominant_dtype: { type: ["string", "null"] },
			hints: { type: "array", items: { type: "string", enum: ["gated", "large", "quant", "redundant", "subset"] }, description: "The CLI's closed hint vocabulary." },
			policy: { type: ["string", "null"], description: "negatives when the price is the negative set only." },
			precision: { type: ["string", "null"] },
			bytes_per_param: { type: ["number", "null"] },
			architecture: { type: ["string", "null"] },
			parents: { type: ["array", "null"], items: { type: "object", properties: { source: { type: "string" }, relation: { type: ["string", "null"] } } } },
			closed: { type: "boolean", description: "A closed work: a home page, no bytes, no price." },
			claim: ref("Claim"),
		},
	},
	RowFields: {
		type: "object",
		description: "The decided columns. Absent means leave it.",
		properties: {
			desire: { type: ["integer", "null"], minimum: DESIRE_MIN, maximum: DESIRE_MAX, description: "Orders the list; null clears it." },
			note: { type: ["string", "null"], maxLength: MAX_ENTRY_NOTE, description: "Plain text — a sentence for why this one." },
			status: { type: "string", enum: ["want", "have"] },
			holders: { type: "string", maxLength: MAX_HOLDERS },
		},
	},
	RowAddress: {
		type: "object",
		required: ["source"],
		properties: {
			source: { type: "string", maxLength: MAX_SOURCE, description: SOURCE_DESC },
			revision: { type: ["string", "null"], maxLength: MAX_REVISION },
			include: { type: ["array", "null"], maxItems: MAX_INCLUDES, items: { type: "string", maxLength: MAX_INCLUDE_GLOB } },
		},
	},
	RowInput: { allOf: [ref("RowAddress"), ref("RowFields")], description: "Add or ensure a row: its address plus any decided columns." },
	RowPatch: {
		allOf: [
			{ type: "object", properties: { source: { type: "string", maxLength: MAX_SOURCE }, revision: { type: ["string", "null"] }, include: { type: ["array", "null"], items: { type: "string" } } } },
			ref("RowFields"),
		],
		description: "Any subset of a row's columns. A changed address is re-priced and must not collide.",
	},
	Access: {
		type: "object",
		properties: {
			via: { type: "string", enum: ["url", "key"] },
			scopes: { type: "array", items: { type: "string", enum: [...SCOPES] } },
			key: { type: ["object", "null"], properties: { id: { type: "string" }, label: { type: "string" } } },
		},
	},
	Board: {
		type: "object",
		required: ["catalog_id", "title", "revision", "access", "counts", "entries", "links"],
		properties: {
			id: { type: "string", description: "The 32-hex capability. Present only when the request came by URL." },
			catalog_id: { type: "string" },
			title: { type: "string" },
			curator: { type: ["string", "null"] },
			note: { type: ["string", "null"] },
			created: { type: "string", format: "date-time" },
			updated: { type: "string", format: "date-time" },
			revision: { type: "integer", description: "Bumped by every write. Also the ETag." },
			access: ref("Access"),
			counts: { type: "object", properties: { rows: { type: "integer" }, want: { type: "integer" }, have: { type: "integer" }, claimed: { type: "integer" }, dropped: { type: "integer" } } },
			order: { type: "string", description: "How entries are ordered: desire desc, unrated last, then as added." },
			entries: { type: "array", items: ref("Row") },
			links: { type: "object", additionalProperties: { type: "string" } },
		},
	},
	Rows: { type: "object", properties: { revision: { type: "integer" }, count: { type: "integer" }, entries: { type: "array", items: ref("Row") } } },
	BoardPatch: {
		type: "object",
		properties: { title: { type: "string" }, curator: { type: "string" }, note: { type: "string" }, catalog_id: { type: "string" } },
	},
	ApplyRequest: {
		type: "object",
		required: ["rows"],
		properties: {
			rows: { type: "array", maxItems: MAX_APPLY_ROWS, items: { allOf: [ref("RowInput"), { type: "object", properties: { ref: { type: "string", maxLength: 80, description: "Your own handle, echoed back." } } }] } },
			mode: { type: "string", enum: ["upsert", "sync"], default: "upsert", description: "sync also drops (never removes) live rows the list left out." },
			dry_run: { type: "boolean", default: false },
		},
	},
	PlanRow: {
		type: "object",
		properties: {
			ref: { type: ["string", "null"] },
			action: { type: "string", enum: ["added", "updated", "restored", "unchanged", "dropped", "removed"] },
			id: { type: ["integer", "null"], description: "null in a dry run for rows that would be added." },
			source: { type: "string" },
			revision: { type: ["string", "null"] },
			include: { type: ["array", "null"], items: { type: "string" } },
			changes: { type: "array", items: { type: "string" } },
			priced: { type: "boolean", description: "Whether a new Hub row was priced in this call (the first " + PRICE_BUDGET + " are)." },
		},
	},
	PlanResult: {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			dry_run: { type: "boolean" },
			revision: { type: "integer" },
			summary: { type: "object", properties: { added: { type: "integer" }, updated: { type: "integer" }, restored: { type: "integer" }, unchanged: { type: "integer" }, dropped: { type: "integer" }, removed: { type: "integer" } } },
			rows: { type: "array", items: ref("PlanRow") },
		},
	},
	BatchRequest: {
		type: "object",
		required: ["operations"],
		properties: {
			operations: {
				type: "array",
				maxItems: MAX_APPLY_ROWS,
				items: {
					type: "object",
					required: ["op"],
					properties: {
						op: { type: "string", enum: ["add", "update", "drop", "restore", "remove"] },
						ref: { type: "string", maxLength: 80 },
						id: { type: "integer", description: "For update, drop, restore, remove." },
						source: { type: "string", description: "For add." },
						revision: { type: ["string", "null"] },
						include: { type: ["array", "null"], items: { type: "string" } },
						desire: { type: ["integer", "null"] },
						note: { type: ["string", "null"] },
						status: { type: "string", enum: ["want", "have"] },
						holders: { type: "string" },
					},
				},
			},
			dry_run: { type: "boolean", default: false },
		},
	},
	ClaimReport: {
		type: "object",
		required: ["client"],
		properties: {
			client: { type: "string", maxLength: 80, description: "A stable pseudonym for the machine, never a hostname." },
			state: { type: "string", enum: ["archiving", "paused", "done"], default: "archiving" },
			percent: { type: "integer", minimum: 0, maximum: 100 },
			banked_bytes: { type: "integer" },
			total_bytes: { type: "integer" },
			refetch: { type: "boolean", description: "A deliberate claim on a row already checked off as have." },
			force: { type: "boolean", description: "Take over another client's live claim." },
		},
	},
	ClaimRelease: { type: "object", properties: { client: { type: "string" }, force: { type: "boolean" } } },
	AuditEvent: {
		type: "object",
		properties: {
			id: { type: "integer" },
			at: { type: "string", format: "date-time" },
			actor: { type: "object", properties: { via: { type: "string", enum: ["url", "key"] }, key: { type: ["object", "null"] }, client: { type: "string", enum: ["rest", "mcp", "cli"] }, label: { type: "string", description: "url, cli, mcp, or key:<label>" } } },
			action: { type: "string", enum: ["board.updated", "row.added", "row.updated", "row.dropped", "row.restored", "row.removed", "claim.reported", "claim.released", "catalog.imported", "key.created", "key.revoked", "webhook.created", "webhook.removed"] },
			entry_id: { type: ["integer", "null"] },
			before: { description: "The decided columns before the event, or null." },
			after: { description: "The decided columns after the event, or null." },
			revision: { type: "integer", description: "The board revision this event produced." },
		},
	},
	AuditPage: { type: "object", properties: { revision: { type: "integer" }, events: { type: "array", items: ref("AuditEvent") }, next_before: { type: ["integer", "null"] } } },
	Key: {
		type: "object",
		properties: { id: { type: "string" }, label: { type: "string" }, scopes: { type: "array", items: { type: "string", enum: [...SCOPES] } }, created: { type: "string" }, last_used: { type: ["string", "null"] } },
	},
	KeyCreate: {
		type: "object",
		required: ["label"],
		properties: {
			label: { type: "string", maxLength: 60, description: "Who this key is for; appears in the audit trail as key:<label>." },
			scopes: { type: "array", items: { type: "string", enum: [...SCOPES] }, default: ["read", "write"], description: Object.entries(SCOPE_HELP).map(([s, h]) => s + ": " + h).join(" ") },
		},
	},
	KeyCreated: { allOf: [ref("Key"), { type: "object", properties: { key: { type: "string", description: "The secret, shown once: darsay_ followed by 48 hex characters." }, shown_once: { type: "boolean" }, api: { type: "string" }, mcp: { type: "string" }, revision: { type: "integer" } } }] },
	Webhook: {
		type: "object",
		properties: { id: { type: "string" }, url: { type: "string" }, events: { type: "array", items: { type: "string" } }, created: { type: "string" }, last_at: { type: ["string", "null"] }, last_status: { type: ["integer", "null"] } },
	},
	WebhookCreate: {
		type: "object",
		required: ["url"],
		properties: {
			url: { type: "string", format: "uri", description: "https, on a public host." },
			events: { type: "array", items: { type: "string", enum: ["*", ...WEBHOOK_EVENTS] }, default: ["*"] },
			secret: { type: "string", maxLength: 128, description: "HMAC secret; generated when absent." },
		},
	},
	WebhookCreated: { allOf: [ref("Webhook"), { type: "object", properties: { secret: { type: "string" }, shown_once: { type: "boolean" }, revision: { type: "integer" } } }] },
	Delivery: {
		type: "object",
		description: "What a webhook receives: one POST per commit, the events filtered to its subscription, signed as X-Darsay-Signature: sha256=<hex HMAC of the body>.",
		properties: {
			id: { type: "string" },
			at: { type: "string" },
			board: { type: "object", properties: { catalog_id: { type: "string" }, title: { type: "string" }, revision: { type: "integer" } } },
			actor: { type: "object" },
			events: { type: "array", items: { type: "object", properties: { action: { type: "string" }, entry_id: { type: ["integer", "null"] }, before: {}, after: {} } } },
		},
	},
	Catalog: { type: "object", description: "A darsay.catalog document, schema 2.x — the same file darsay estimate <board> fetches and pushes back.", additionalProperties: true },
	ImportResult: { type: "object", properties: { ok: { type: "boolean" }, added: { type: "integer" }, updated: { type: "integer" }, restored: { type: "integer" }, removed: { type: "integer" }, dropped: { type: "integer" }, entries: { type: "integer" }, revision: { type: "integer" } } },
	GuideCard: {
		type: "object",
		properties: { key: { type: "string" }, group: { type: "string" }, title: { type: "string" }, lede: { type: "string" }, body: { type: "array", items: { type: "string" } }, collect: { type: "string" }, doc: { type: ["object", "null"] }, related: { type: "array", items: { type: "string" } }, lens: { type: ["string", "null"] } },
	},
	Guide: { type: "object", properties: { cards: { type: "array", items: ref("GuideCard") }, chips: { type: "array", items: { type: "string" } }, docs: { type: "string" } } },
	JsonRpc: { type: "object", description: "A JSON-RPC 2.0 request: initialize, ping, tools/list, tools/call.", required: ["jsonrpc", "method"], properties: { jsonrpc: { type: "string", enum: ["2.0"] }, id: {}, method: { type: "string" }, params: { type: "object" } } },
};

const IF_MATCH = { name: "If-Match", in: "header", required: false, schema: { type: "string" }, description: 'The revision you last read, quoted: "184". The write is refused with 412 stale if the board moved.' };
const IDEMPOTENCY = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 128 }, description: "Any token of your choosing. A retry with the same key and the same request replays the first answer (Idempotent-Replayed: true); a different request under the same key is refused with 422." };
const IF_NONE_MATCH = { name: "If-None-Match", in: "header", required: false, schema: { type: "string" }, description: "The ETag you hold; 304 when nothing changed." };
const DRY_RUN_Q = { name: "dry_run", in: "query", required: false, schema: { type: "boolean" }, description: "Same as dry_run in the body." };
const EID = { name: "eid", in: "path", required: true, schema: { type: "integer" }, description: "The row id." };

type Op = { summary: string; description?: string; scope?: string; urlOnly?: boolean; parameters?: Json[]; requestBody?: Json; responses: Record<string, Json>; tags?: string[] };
type Route = { path: string; ops: Partial<Record<"get" | "post" | "patch" | "delete", Op>> };

const rowResponses = { "200": json(ref("Row"), "The row as it now is."), "404": err("No such row."), "412": err("Stale: the board moved since the revision you sent.") };

const BOARD_ROUTES: Route[] = [
	{
		path: "",
		ops: {
			get: { summary: "Read the board", description: "Title, note, revision, counts, and every row in the canonical order (desire desc, unrated last, then as added). ETag is the revision.", scope: "read", parameters: [IF_NONE_MATCH, { name: "dropped", in: "query", schema: { type: "string", enum: ["none", "all", "only"] }, description: "Whether dropped rows are included." }], responses: { "200": json(ref("Board")), "304": { description: "Nothing changed." } } },
			patch: { summary: "Edit the board", description: "Title, curator, note, catalog id.", scope: "write", parameters: [IF_MATCH, IDEMPOTENCY], requestBody: json(ref("BoardPatch")), responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, updated: { type: "string" }, catalog_id: { type: "string" }, revision: { type: "integer" } } }), "412": err("Stale.") } },
			delete: { summary: "Destroy the board", description: "Every row, note, key, and claim goes with it. URL only; a key cannot.", urlOnly: true, requestBody: json({ type: "object", required: ["confirm"], properties: { confirm: { type: "string", enum: ["delete"] } } }), responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" } } }), "403": err("Keys cannot delete a board.") } },
		},
	},
	{
		path: "/catalog.json",
		ops: {
			get: { summary: "Export the catalog", description: "A darsay.catalog document (schema 2.x): the rows without holders, status, claims, or the board id. Dropped rows are left out.", scope: "read", responses: { "200": json(ref("Catalog")) } },
			post: { summary: "Import a catalog (the CLI round trip)", description: "Authoritative for entries, desire, note, and digests; matched by address. Rows the document left out are removed by the URL and dropped by a key without remove. Board-side status, holders, and claims survive on kept rows.", scope: "write", parameters: [IF_MATCH, IDEMPOTENCY], requestBody: json(ref("Catalog")), responses: { "200": json(ref("ImportResult")), "400": err("Not a catalog, wrong major, or a bad entry."), "409": err("catalog_id mismatch.") } },
		},
	},
	{
		path: "/entries",
		ops: {
			get: { summary: "Find rows", description: "Filter by address, status, type, the board's own lenses, family, desire range, or free text. Pass source to ask whether a work is already on the board.", scope: "read", parameters: [IF_NONE_MATCH, { name: "q", in: "query", schema: { type: "string" } }, { name: "source", in: "query", schema: { type: "string" }, description: SOURCE_DESC }, { name: "status", in: "query", schema: { type: "string", enum: ["want", "have"] } }, { name: "type", in: "query", schema: { type: "string", enum: ["model", "dataset", "closed", "opaque"] } }, { name: "lens", in: "query", schema: { type: "string" }, description: "Comma-separated, AND-combined: " + LENSES.map((l) => l.key).join(", ") }, { name: "family", in: "query", schema: { type: "string" } }, { name: "desire_min", in: "query", schema: { type: "integer" } }, { name: "desire_max", in: "query", schema: { type: "integer" } }, { name: "dropped", in: "query", schema: { type: "string", enum: ["none", "all", "only"] } }, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": json(ref("Rows")), "400": err("An unknown lens, status, or type.") } },
			post: { summary: "Add a row (upsert by address)", description: "A new address is priced from the Hub and added (201). An address already on the board is updated with the fields sent, or restored if it was dropped, or left untouched when identical (200, no revision bump). Safe to repeat.", scope: "write", parameters: [IF_MATCH, IDEMPOTENCY], requestBody: json(ref("RowInput")), responses: { "201": json(ref("Row"), "Added."), "200": json(ref("Row"), "Already there: updated, restored, or unchanged."), "400": err("A bad address or field, or the board is full (entry_cap, " + MAX_ENTRIES + " rows)."), "412": err("Stale.") } },
		},
	},
	{
		path: "/apply",
		ops: {
			post: { summary: "Apply a list (declarative upsert)", description: "Ensure a whole list is on the board in one transaction: match by address, add what is missing, update what differs, restore what was dropped, leave the identical alone. mode sync also drops live rows the list left out. dry_run returns the plan without writing. The first " + PRICE_BUDGET + " new Hub rows are priced on the spot; the rest land unpriced until the CLI's next round trip.", scope: "write", parameters: [IF_MATCH, IDEMPOTENCY, DRY_RUN_Q], requestBody: json(ref("ApplyRequest")), responses: { "200": json(ref("PlanResult")), "400": err("invalid rows, with failures[]; or entry_cap."), "412": err("Stale.") } },
		},
	},
	{
		path: "/entries/batch",
		ops: {
			post: { summary: "Run a batch of operations", description: "Explicit operations — add by address; update, drop, restore, remove by id — checked as a whole and written as a whole. One bad operation fails the batch and nothing is written. remove needs the remove scope.", scope: "write", parameters: [IF_MATCH, IDEMPOTENCY, DRY_RUN_Q], requestBody: json(ref("BatchRequest")), responses: { "200": json(ref("PlanResult")), "400": err("invalid operations, with failures[]."), "412": err("Stale.") } },
		},
	},
	{
		path: "/entries/{eid}",
		ops: {
			get: { summary: "Read one row", scope: "read", parameters: [EID, IF_NONE_MATCH], responses: { "200": json(ref("Row")), "404": err("No such row.") } },
			patch: { summary: "Update a row", description: "Any subset of columns. A changed address is re-priced and must not collide with another row (409).", scope: "write", parameters: [EID, IF_MATCH, IDEMPOTENCY], requestBody: json(ref("RowPatch")), responses: { ...rowResponses, "409": err("Another row already has that address.") } },
			delete: { summary: "Remove a row (permanent)", description: "Gone for good; the audit trail keeps what it was. Prefer drop.", scope: "remove", parameters: [EID, IF_MATCH, IDEMPOTENCY], responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, revision: { type: "integer" } } }), "403": err("The key lacks remove."), "404": err("No such row.") } },
		},
	},
	{ path: "/entries/{eid}/drop", ops: { post: { summary: "Drop a row (soft, undoable)", description: "The row leaves every list and the export but can be restored. Already dropped: 200, no change.", scope: "write", parameters: [EID, IF_MATCH, IDEMPOTENCY], responses: rowResponses } } },
	{ path: "/entries/{eid}/restore", ops: { post: { summary: "Restore a dropped row", scope: "write", parameters: [EID, IF_MATCH, IDEMPOTENCY], responses: rowResponses } } },
	{
		path: "/entries/{eid}/claim",
		ops: {
			post: { summary: "Claim a row / report progress", description: "Board-side coordination: this client is fetching this row. A live claim by another client blocks a new one (409 claimed) until it goes stale (24 h) or reports done; force overrides. A row checked off as have refuses un-marked claims (409 have) unless refetch or force. Reporting done flips the row to have and fills empty holders with the client.", scope: "claim", parameters: [EID], requestBody: json(ref("ClaimReport")), responses: { "200": json(ref("Row")), "409": json({ type: "object", properties: { error: { type: "string", enum: ["claimed", "have", "dropped"] }, claim: ref("Claim") } }, "Blocked.") } },
			delete: { summary: "Release a claim", description: "The claimant's own, or anyone's with force.", scope: "claim", parameters: [EID], requestBody: json(ref("ClaimRelease")), responses: { "200": json(ref("Row")), "409": err("Someone else's live claim.") } },
		},
	},
	{
		path: "/audit",
		ops: { get: { summary: "Read the audit trail", description: "Who did what, newest first, with the decided columns before and after.", scope: "read", parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 200 } }, { name: "before", in: "query", schema: { type: "integer" }, description: "Events with an id below this." }, { name: "entry", in: "query", schema: { type: "integer" }, description: "Only this row's events." }], responses: { "200": json(ref("AuditPage")) } } },
	},
	{
		path: "/keys",
		ops: {
			get: { summary: "List keys", urlOnly: true, responses: { "200": json({ type: "object", properties: { keys: { type: "array", items: ref("Key") }, scopes: { type: "array", items: { type: "object" } }, max: { type: "integer" } } }) } },
			post: { summary: "Mint a key", description: "The board URL, narrowed to a label and a few scopes. The secret is returned once. Use it as Authorization: Bearer at /api/board/… and /mcp.", urlOnly: true, requestBody: json(ref("KeyCreate")), responses: { "201": json(ref("KeyCreated")), "400": err("label required, unknown scope, or key_cap.") } },
		},
	},
	{ path: "/keys/{kid}", ops: { delete: { summary: "Revoke a key", urlOnly: true, parameters: [{ name: "kid", in: "path", required: true, schema: { type: "string" } }], responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, revision: { type: "integer" } } }), "404": err("No such key.") } } } },
	{
		path: "/webhooks",
		ops: {
			get: { summary: "List webhooks", urlOnly: true, responses: { "200": json({ type: "object", properties: { webhooks: { type: "array", items: ref("Webhook") }, max: { type: "integer" } } }) } },
			post: { summary: "Register a webhook", description: "One POST per commit with the matching events (see Delivery), signed with the secret. Best-effort, no retries; the audit trail is the durable record.", urlOnly: true, requestBody: json(ref("WebhookCreate")), responses: { "201": json(ref("WebhookCreated")), "400": err("A bad URL or event, or webhook_cap.") } },
		},
	},
	{ path: "/webhooks/{wid}", ops: { delete: { summary: "Remove a webhook", urlOnly: true, parameters: [{ name: "wid", in: "path", required: true, schema: { type: "string" } }], responses: { "200": json({ type: "object", properties: { ok: { type: "boolean" }, revision: { type: "integer" } } }), "404": err("No such webhook.") } } } },
];

const COMMON_ERRORS: Record<string, Json> = {
	"401": err("No key, or a bad one (only under /api/board)."),
	"403": err("The key lacks the scope, or names another board."),
	"404": err("No such board."),
	"429": err("A daily cap: lookup_cap or mutate_cap."),
};

function operation(op: Op, form: "url" | "key"): Json {
	const security = form === "url" ? [{}, { boardKey: [] }] : [{ boardKey: [] }];
	const scopeLine = op.urlOnly ? "URL only — a key cannot call this." : op.scope ? "Scope: " + op.scope + "." : "";
	return {
		summary: op.summary,
		description: [op.description ?? "", scopeLine].filter(Boolean).join("\n\n"),
		tags: [form === "url" ? "By URL" : "By key"],
		security,
		...(op.parameters ? { parameters: op.parameters } : {}),
		...(op.requestBody ? { requestBody: { required: true, ...op.requestBody } } : {}),
		responses: { ...op.responses, ...COMMON_ERRORS },
	};
}

/**
 * Served but not described: the URL-only operations answer 403
 * `url_required` on the key address, so the document leaves them out.
 */
export function keyFormStubs(): string[] {
	const out: string[] = [];
	for (const route of BOARD_ROUTES) {
		for (const [method, op] of Object.entries(route.ops) as [string, Op][]) {
			if (op.urlOnly) out.push(method.toUpperCase() + " /api/board" + route.path);
		}
	}
	return out;
}

export function openapiDocument(origin: string): Json {
	const paths: Record<string, Json> = {};
	const ID_PARAM = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" }, description: "The board id — the capability. Whoever holds it holds the board." };
	for (const route of BOARD_ROUTES) {
		const byUrl: Json = { parameters: [ID_PARAM] };
		const byKey: Json = {};
		for (const [method, op] of Object.entries(route.ops) as [string, Op][]) {
			byUrl[method] = operation(op, "url");
			if (!op.urlOnly) byKey[method] = operation(op, "key");
		}
		paths["/api/boards/{id}" + route.path] = byUrl;
		if (Object.keys(byKey).length) paths["/api/board" + route.path] = byKey;
	}
	paths["/api/boards"] = {
		post: {
			summary: "Create a board",
			description: "Needs the shared create password. The answer carries the new board's URL — the capability — and its JSON address.",
			tags: ["Boards"],
			requestBody: { required: true, ...json({ type: "object", required: ["password"], properties: { password: { type: "string" }, title: { type: "string" }, curator: { type: "string" }, note: { type: "string" }, catalog_id: { type: "string" } } }) },
			responses: { "201": json({ type: "object", properties: { id: { type: "string" }, url: { type: "string" }, json: { type: "string" }, catalog_id: { type: "string" }, created: { type: "string" }, revision: { type: "integer" } } }), "401": err("Wrong password."), "429": err("create_cap."), "503": err("Create is disabled.") },
		},
	};
	paths["/b/{id}.json"] = {
		get: { summary: "The board as JSON, from its page address", description: "The same document as GET /api/boards/{id}. A request for /b/{id} with Accept: application/json (and not text/html) is answered the same way.", tags: ["Boards"], parameters: [ID_PARAM], security: [{}], responses: { "200": json(ref("Board")), "404": err("No such board.") } },
	};
	paths["/api/guide"] = { get: { summary: "The field guide", description: "Every teaching card the board shows: what a chip, lens, or column means and what a collector should do about it. Public.", tags: ["Guide"], security: [{}], responses: { "200": json(ref("Guide")) } } };
	paths["/api/guide/{chip}"] = { get: { summary: "One card, by chip", tags: ["Guide"], security: [{}], parameters: [{ name: "chip", in: "path", required: true, schema: { type: "string" }, description: "A card key, a lens key, or a hint word: negatives, quant, gated, large, redundant, subset, closed, family, desire, claims, dataset, moe…" }], responses: { "200": json(ref("GuideCard")), "404": err("No such card; the answer lists the chips.") } } };
	paths["/api/openapi.json"] = { get: { summary: "This document", tags: ["Meta"], security: [{}], responses: { "200": json({ type: "object" }) } } };
	paths["/openapi.json"] = paths["/api/openapi.json"];
	paths["/api/mcp"] = {
		post: {
			summary: "The MCP server (Streamable HTTP, stateless)",
			description: "JSON-RPC 2.0 over POST; one request, one JSON answer, no session and no stream. Methods: initialize, ping, tools/list, tools/call. Tools: get_board, find_rows, get_row, add_row, update_row, drop_row, restore_row, remove_row, apply, batch, audit, explain. The bearer names the board.",
			tags: ["MCP"],
			security: [{ boardKey: [] }],
			requestBody: { required: true, ...json(ref("JsonRpc")) },
			responses: { "200": json({ type: "object", description: "A JSON-RPC response." }), "202": { description: "A notification, acknowledged." }, "401": err("No key, or a bad one.") },
		},
	};
	paths["/mcp"] = paths["/api/mcp"];

	return {
		openapi: "3.1.0",
		info: {
			title: "darsay.io board API",
			version: "1.0.0",
			summary: "A want-list of models and datasets, for programs.",
			description: [
				"A darsay.io board is a ledger: rows that want or have a work, rated by desire, priced from the Hub, and kept honest by the darsay CLI's round trip. It has rows, not cards, and no columns.",
				"A row's identity is its address — canonical source, revision, include set — so adding is an upsert and re-sending is safe. Every write bumps the board's revision (the ETag; send it back as If-Match), lands in the audit trail, honors Idempotency-Key, and can fan out to webhooks.",
				"Two address forms: /api/boards/{id}/… where the URL is the capability, and /api/board/… where a bearer key names the board and never learns its id. Docs: " + origin + "/docs/board/",
			].join("\n\n"),
			contact: { url: origin + "/docs/board/" },
			license: { name: "Apache-2.0" },
		},
		servers: [{ url: origin }],
		tags: [
			{ name: "By URL", description: "Addressed by the board id; the URL is the capability. A bearer key is honored for attribution and narrowing, never for widening." },
			{ name: "By key", description: "Addressed by the bearer key (Authorization: Bearer darsay_…), or the board id as a bearer. Same operations, minus what only the URL may do." },
			{ name: "Boards" },
			{ name: "Guide" },
			{ name: "MCP" },
			{ name: "Meta" },
		],
		components: {
			securitySchemes: {
				boardKey: { type: "http", scheme: "bearer", bearerFormat: "darsay_<48 hex> (a key) or the 32-hex board id", description: "Scopes: " + SCOPES.join(", ") + ". Keys are minted at POST /api/boards/{id}/keys." },
			},
			schemas,
		},
		paths,
	};
}
