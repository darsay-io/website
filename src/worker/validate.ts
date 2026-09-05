export const SLUG_RE = /^[a-z][a-z0-9._-]{0,63}$/;
export const DESIRE_MIN = 1;
export const DESIRE_MAX = 9;
export const MAX_TITLE = 120;
export const MAX_CURATOR = 120;
export const MAX_BOARD_NOTE = 2000;
export const MAX_ENTRY_NOTE = 500;
export const MAX_HOLDERS = 500;
export const MAX_SOURCE = 300;
export const MAX_REVISION = 64;
export const MAX_INCLUDE_GLOB = 1024;
export const MAX_INCLUDES = 256;
export const MAX_ENTRIES = 200;
export const MAX_BODY = 64 * 1024;
// A pushed catalog carries digests for up to MAX_ENTRIES rows.
export const MAX_IMPORT_BODY = 2 * 1024 * 1024;
export const MAX_CLIENT = 80;
// An active claim by another client blocks a new claim until it goes
// stale (no progress report inside the TTL) or reports done.
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
export const CREATE_CAP = 100;
export const MUTATE_CAP = 10_000;
export const LOOKUP_CAP = 50_000;
// A preview is one or two Hub fetches that spend no mutate; it has its own day.
export const PREVIEW_CAP = 2_000;

export function foldSlug(spec: string): string {
	return (spec || "").trim().toLowerCase();
}

export function slugifyTitle(title: string): string {
	const folded = foldSlug(title).replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
	return SLUG_RE.test(folded) ? folded : "board";
}

export function parseCatalogId(explicit: unknown, title: string): { ok: true; id: string } | { ok: false; error: string } {
	if (explicit === undefined || explicit === null || explicit === "") {
		return { ok: true, id: slugifyTitle(title) };
	}
	if (typeof explicit !== "string") {
		return { ok: false, error: "catalog_id must be a string" };
	}
	const folded = foldSlug(explicit);
	if (!SLUG_RE.test(folded)) {
		return { ok: false, error: "catalog_id must match SLUG_RE" };
	}
	return { ok: true, id: folded };
}

/** `/*` names the whole repository: no selection at all, the same identity as no include. */
export function isWholeRepository(include: string[] | null): boolean {
	return include !== null && include.length === 1 && include[0] === "/*";
}

export function includeKey(include: string[] | null): string {
	if (!include || include.length === 0 || isWholeRepository(include)) return "[]";
	return JSON.stringify([...include].sort());
}

export function includeJson(include: string[] | null): string | null {
	if (!include || include.length === 0) return null;
	return JSON.stringify(include);
}

export function parseInclude(raw: unknown): { ok: true; include: string[] | null } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, include: null };
	if (!Array.isArray(raw)) return { ok: false, error: "include must be an array or null" };
	if (raw.length > MAX_INCLUDES) return { ok: false, error: "too many include globs" };
	const globs: string[] = [];
	for (const g of raw) {
		if (typeof g !== "string" || g.length === 0 || g.length > MAX_INCLUDE_GLOB) {
			return { ok: false, error: "invalid include glob" };
		}
		globs.push(g);
	}
	return { ok: true, include: globs.length && !isWholeRepository(globs) ? globs : null };
}

export function parseDesire(raw: unknown): { ok: true; desire: number | null } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, desire: null };
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < DESIRE_MIN || raw > DESIRE_MAX) {
		return { ok: false, error: "desire must be an integer 1–9 or null" };
	}
	return { ok: true, desire: raw };
}

export function utcNow(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function utcDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function clampStr(value: unknown, max: number, emptyOk = true): string | null {
	if (value === undefined || value === null) return emptyOk ? "" : null;
	if (typeof value !== "string") return null;
	if (value.length > max) return null;
	return value;
}

export function newBoardId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isBoardId(id: string): boolean {
	return /^[0-9a-f]{32}$/.test(id);
}

/** Constant-time-ish compare so length and first-byte mismatches do not short-circuit. */
export function secretEqual(given: unknown, expected: string): boolean {
	if (typeof given !== "string" || !expected) return false;
	const enc = new TextEncoder();
	const a = enc.encode(given);
	const b = enc.encode(expected);
	const n = Math.max(a.length, b.length);
	let mismatch = a.length ^ b.length;
	for (let i = 0; i < n; i++) {
		mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return mismatch === 0;
}
