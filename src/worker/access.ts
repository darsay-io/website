/**
 * Who is asking, and what the board lets them do.
 *
 * The board URL is the capability — whoever holds the 32-hex id can do
 * everything. A key is that capability narrowed: it names one board and
 * carries a few scopes, so a person can hand an agent "read and write rows
 * on this board" without handing over the URL. Keys are addressed at
 * `/api/board/…` (the bearer names the board) and never learn the id; the
 * same bearer on `/api/boards/:id/…` is honored for attribution and
 * attenuation, never for widening. A key cannot delete the board, mint
 * keys, or register webhooks: those stay with the URL.
 */

export const SCOPES = ["read", "write", "claim", "remove"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_HELP: Record<Scope, string> = {
	read: "Read the board, its rows, the catalog, and the audit trail.",
	write: "Add and update rows, drop and restore them, apply a list, edit the board's title and note.",
	claim: "Claim a row and report archive progress on it — what the darsay CLI does.",
	remove: "Remove rows permanently. Without it, nothing a key does can destroy a row.",
};

export const MAX_KEY_LABEL = 60;
export const MAX_KEYS = 20;
/** `last_used` is written at most this often per key, so a chatty reader costs one write, not one per call. */
const LAST_USED_GRAIN_MS = 10 * 60 * 1000;
const KEY_PREFIX = "darsay_";
const KEY_RE = /^darsay_[0-9a-f]{48}$/;
const BOARD_RE = /^[0-9a-f]{32}$/;

export type KeyRow = {
	id: string;
	board_id: string;
	hash: string;
	label: string;
	scopes: string;
	created: string;
	last_used: string | null;
};

export type Grant = {
	boardId: string;
	via: "url" | "key";
	scopes: ReadonlySet<Scope>;
	key: { id: string; label: string } | null;
};

export type Bearer = { kind: "key"; secret: string } | { kind: "board"; id: string } | { kind: "bad" };

export function parseBearer(header: string | null): Bearer | null {
	if (!header) return null;
	const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
	if (!m) return { kind: "bad" };
	const token = m[1];
	if (KEY_RE.test(token)) return { kind: "key", secret: token };
	if (BOARD_RE.test(token)) return { kind: "board", id: token };
	return { kind: "bad" };
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashSecret(secret: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
}

export function newKeySecret(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return KEY_PREFIX + hex(bytes);
}

export function newKeyId(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return "k_" + hex(bytes);
}

export function isScope(s: unknown): s is Scope {
	return typeof s === "string" && (SCOPES as readonly string[]).includes(s);
}

/** Scopes from a request: an array of known names; `read` is always implied. Absent means read + write. */
export function parseScopes(raw: unknown): { ok: true; scopes: Scope[] } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, scopes: ["read", "write"] };
	if (!Array.isArray(raw)) return { ok: false, error: "scopes must be an array" };
	const out = new Set<Scope>(["read"]);
	for (const s of raw) {
		if (!isScope(s)) return { ok: false, error: "unknown scope " + JSON.stringify(String(s).slice(0, 20)) };
		out.add(s);
	}
	return { ok: true, scopes: SCOPES.filter((s) => out.has(s)) };
}

export function scopesOf(key: Pick<KeyRow, "scopes">): Set<Scope> {
	const out = new Set<Scope>(["read"]);
	try {
		const parsed = JSON.parse(key.scopes) as unknown;
		if (Array.isArray(parsed)) for (const s of parsed) if (isScope(s)) out.add(s);
	} catch {
		/* a malformed scopes column narrows to read */
	}
	return out;
}

export const FULL_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

export function urlGrant(boardId: string): Grant {
	return { boardId, via: "url", scopes: FULL_SCOPES, key: null };
}

export function keyToApi(k: KeyRow) {
	return { id: k.id, label: k.label, scopes: [...scopesOf(k)], created: k.created, last_used: k.last_used };
}

export type GrantResult = { ok: true; grant: Grant } | { ok: false; status: 401 | 403; error: string };

/**
 * Resolve a grant from the address and the bearer. `paramBoardId` is the
 * `:id` in `/api/boards/:id/…` (null under `/api/board/…`, where the bearer
 * must name the board).
 */
export async function resolveGrant(
	db: D1Database,
	opts: { paramBoardId: string | null; authorization: string | null; now?: string },
): Promise<GrantResult> {
	const bearer = parseBearer(opts.authorization);
	if (bearer === null) {
		if (opts.paramBoardId) return { ok: true, grant: urlGrant(opts.paramBoardId) };
		return { ok: false, status: 401, error: "key_required" };
	}
	if (bearer.kind === "bad") return { ok: false, status: 401, error: "bad_bearer" };
	if (bearer.kind === "board") {
		if (opts.paramBoardId && opts.paramBoardId !== bearer.id) return { ok: false, status: 403, error: "wrong_board" };
		return { ok: true, grant: urlGrant(bearer.id) };
	}
	const hash = await hashSecret(bearer.secret);
	const key = await db.prepare("SELECT * FROM keys WHERE hash = ?").bind(hash).first<KeyRow>();
	if (!key) return { ok: false, status: 401, error: "bad_key" };
	if (opts.paramBoardId && key.board_id !== opts.paramBoardId) return { ok: false, status: 403, error: "wrong_board" };
	const now = opts.now ?? new Date().toISOString();
	const last = key.last_used ? Date.parse(key.last_used) : NaN;
	if (!Number.isFinite(last) || Date.parse(now) - last > LAST_USED_GRAIN_MS) {
		await db.prepare("UPDATE keys SET last_used = ? WHERE id = ?").bind(now, key.id).run();
	}
	return {
		ok: true,
		grant: { boardId: key.board_id, via: "key", scopes: scopesOf(key), key: { id: key.id, label: key.label } },
	};
}

export function can(grant: Grant, scope: Scope): boolean {
	return grant.scopes.has(scope);
}

export function grantToApi(grant: Grant) {
	return { via: grant.via, scopes: [...grant.scopes], key: grant.key };
}
