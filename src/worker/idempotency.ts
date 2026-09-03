/**
 * Idempotency keys: a program that retries sends the same
 * `Idempotency-Key` again and gets the same answer back, instead of a
 * second row or a second drop. The key is scoped to the board; the stored
 * answer is replayed only for the same request (method, path, body), and
 * a different request under the same key is refused rather than
 * silently served the old answer. Records age out after a day.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_KEY = 128;
const KEY_RE = /^[\x21-\x7e]{1,128}$/;

export type IdempotencyRow = { fingerprint: string; status: number; body: string; created: string };

/** The header, validated: null when absent, "bad" when malformed. */
export function idempotencyKey(header: string | null): string | null | "bad" {
	if (header === null || header === "") return null;
	return KEY_RE.test(header) ? header : "bad";
}

export async function fingerprint(method: string, path: string, body: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(method.toUpperCase() + "\n" + path + "\n" + body));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function lookupIdempotent(
	db: D1Database,
	boardId: string,
	key: string,
	now = Date.now(),
): Promise<IdempotencyRow | null> {
	const row = await db
		.prepare("SELECT fingerprint, status, body, created FROM idempotency WHERE board_id = ? AND key = ?")
		.bind(boardId, key)
		.first<IdempotencyRow>();
	if (!row) return null;
	const t = Date.parse(row.created);
	if (!Number.isFinite(t) || now - t > IDEMPOTENCY_TTL_MS) return null;
	return row;
}

export async function storeIdempotent(
	db: D1Database,
	boardId: string,
	key: string,
	fp: string,
	status: number,
	body: string,
	nowIso: string,
): Promise<void> {
	const cutoff = new Date(Date.parse(nowIso) - IDEMPOTENCY_TTL_MS).toISOString();
	try {
		await db.batch([
			db.prepare("DELETE FROM idempotency WHERE board_id = ? AND created < ?").bind(boardId, cutoff),
			db
				.prepare(
					`INSERT INTO idempotency (board_id, key, fingerprint, status, body, created) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(board_id, key) DO UPDATE SET fingerprint = excluded.fingerprint, status = excluded.status,
					 body = excluded.body, created = excluded.created`,
				)
				.bind(boardId, key, fp, status, body, nowIso),
		]);
	} catch {
		/* the answer already went out; a lost replay record only costs a retry its shortcut */
	}
}
