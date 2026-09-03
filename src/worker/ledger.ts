/**
 * The one write path. Every mutation of a board — from the page, the CLI,
 * a key, or the MCP server — goes through `commit`: it spends one of the
 * day's mutations, bumps the board's revision, stamps `updated`, appends
 * the audit events, prunes old audit rows, and runs the caller's
 * statements in the same D1 batch (atomic). After the batch the caller
 * fans the events out to webhooks with `announce`.
 */
import type { Grant } from "./access.ts";
import type { BoardRow } from "./catalog.ts";
import { MUTATE_CAP, utcDay, utcNow } from "./validate.ts";
import { deliverAll, type WebhookRow } from "./webhooks.ts";

/** Kept per board; older audit rows fall off the end. */
export const AUDIT_KEEP = 1000;

export type Actor = {
	via: "url" | "key";
	key: { id: string; label: string } | null;
	/** How the request arrived: the REST API, the MCP server, the darsay CLI. */
	client: "rest" | "mcp" | "cli";
};

export type AuditAction =
	| "board.updated"
	| "row.added"
	| "row.updated"
	| "row.dropped"
	| "row.restored"
	| "row.removed"
	| "claim.reported"
	| "claim.released"
	| "catalog.imported"
	| "key.created"
	| "key.revoked"
	| "webhook.created"
	| "webhook.removed";

export type AuditEvent = {
	action: AuditAction;
	entry_id: number | null;
	before: unknown;
	after: unknown;
};

export type AuditRow = {
	id: number;
	board_id: string;
	at: string;
	actor_json: string;
	action: AuditAction;
	entry_id: number | null;
	before_json: string | null;
	after_json: string | null;
	revision: number;
};

export function actorOf(grant: Grant, client: Actor["client"]): Actor {
	return { via: grant.via, key: grant.key, client };
}

/** The darsay CLI says who it is; a browser and everything else are "rest". */
export function clientFrom(userAgent: string | null, transport: "rest" | "mcp" = "rest"): Actor["client"] {
	if (transport === "mcp") return "mcp";
	return userAgent && /^darsay\//.test(userAgent) ? "cli" : "rest";
}

export function actorLabel(actor: Actor): string {
	if (actor.via === "key" && actor.key) return "key:" + actor.key.label;
	return actor.client === "cli" ? "cli" : actor.client === "mcp" ? "mcp" : "url";
}

export function auditToApi(row: AuditRow) {
	let actor: Actor;
	try {
		actor = JSON.parse(row.actor_json) as Actor;
	} catch {
		actor = { via: "url", key: null, client: "rest" };
	}
	const parse = (raw: string | null) => {
		if (raw === null) return null;
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	};
	return {
		id: row.id,
		at: row.at,
		actor: { ...actor, label: actorLabel(actor) },
		action: row.action,
		entry_id: row.entry_id,
		before: parse(row.before_json),
		after: parse(row.after_json),
		revision: row.revision,
	};
}

export type ApiAuditEvent = ReturnType<typeof auditToApi>;

async function readCap(db: D1Database, kind: "creates" | "mutates" | "lookups"): Promise<{ n: number; today: string }> {
	const today = utcDay();
	const utc = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(kind + "_utc").first<{ value: string }>();
	const nRow = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(kind + "_n").first<{ value: string }>();
	const n = utc?.value === today ? parseInt(nRow?.value ?? "0", 10) || 0 : 0;
	return { n, today };
}

function capStmts(db: D1Database, kind: "creates" | "mutates" | "lookups", today: string, next: number) {
	return [
		db.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(today, kind + "_utc"),
		db.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(String(next), kind + "_n"),
	];
}

export { readCap, capStmts };

export type CommitResult =
	| { ok: true; revision: number; now: string }
	| { ok: false; status: 409 | 429 | 503; error: string };

/**
 * Run `stmts` with the board's revision bump and the audit events in one
 * batch. `events` may be empty for writes that are not decisions (a
 * progress report on a claim still bumps the revision so readers see it).
 */
export async function commit(
	db: D1Database,
	board: BoardRow,
	actor: Actor,
	events: AuditEvent[],
	stmts: D1PreparedStatement[],
): Promise<CommitResult> {
	const { n, today } = await readCap(db, "mutates");
	if (n >= MUTATE_CAP) return { ok: false, status: 429, error: "mutate_cap" };
	const now = utcNow();
	const actorJson = JSON.stringify(actor);
	const batch: D1PreparedStatement[] = [
		...capStmts(db, "mutates", today, n + 1),
		db.prepare("UPDATE boards SET updated = ?, revision = revision + 1 WHERE id = ?").bind(now, board.id),
		...stmts,
	];
	for (const ev of events) {
		batch.push(
			db
				.prepare(
					`INSERT INTO audit (board_id, at, actor_json, action, entry_id, before_json, after_json, revision)
					 VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT revision FROM boards WHERE id = ?))`,
				)
				.bind(
					board.id,
					now,
					actorJson,
					ev.action,
					ev.entry_id,
					ev.before === null || ev.before === undefined ? null : JSON.stringify(ev.before),
					ev.after === null || ev.after === undefined ? null : JSON.stringify(ev.after),
					board.id,
				),
		);
	}
	if (events.length) {
		batch.push(
			db
				.prepare(
					`DELETE FROM audit WHERE board_id = ? AND id NOT IN
					 (SELECT id FROM audit WHERE board_id = ? ORDER BY id DESC LIMIT ?)`,
				)
				.bind(board.id, board.id, AUDIT_KEEP),
		);
	}
	try {
		await db.batch(batch);
	} catch (err) {
		if (/UNIQUE/i.test(String(err))) return { ok: false, status: 409, error: "conflict" };
		console.log({ msg: "commit_fail", status: 503 });
		return { ok: false, status: 503, error: "quota" };
	}
	const after = await db.prepare("SELECT revision FROM boards WHERE id = ?").bind(board.id).first<{ revision: number }>();
	return { ok: true, revision: after?.revision ?? board.revision + 1, now };
}

/**
 * Tell the board's webhooks. Best-effort and off the request's critical
 * path: the caller hands over `waitUntil`, so a slow listener never slows
 * the answer. The board id is never part of a delivery.
 */
export async function announce(
	db: D1Database,
	board: BoardRow,
	actor: Actor,
	events: AuditEvent[],
	revision: number,
	at: string,
	waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
	if (!events.length) return;
	const hooks = await db.prepare("SELECT * FROM webhooks WHERE board_id = ?").bind(board.id).all<WebhookRow>();
	const rows = hooks.results ?? [];
	if (!rows.length) return;
	waitUntil(
		deliverAll(db, rows, {
			board: { catalog_id: board.catalog_id, title: board.title, revision },
			actor: { ...actor, label: actorLabel(actor) },
			at,
			events,
		}),
	);
}
