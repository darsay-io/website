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
export const MAX_INCLUDE_GLOB = 80;
export const MAX_INCLUDES = 8;
export const MAX_ENTRIES = 200;
export const MAX_BODY = 64 * 1024;
export const CREATE_CAP = 100;
export const MUTATE_CAP = 10_000;
export const LOOKUP_CAP = 50_000;

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

export function includeKey(include: string[] | null): string {
	if (!include || include.length === 0) return "[]";
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
	return { ok: true, include: globs.length ? globs : null };
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
