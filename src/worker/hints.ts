/**
 * The closed hint vocabulary — a port of `darsay.catalog._hints` /
 * `derive_hints` and `darsay.estimate._dominant_format`.
 *
 * The CLI is the authority: `darsay estimate <board-url>` rewrites every
 * digest it refreshes, hints included. This port exists so a row added from
 * the board carries the same words on the same rules until that refresh.
 * Keep constants and rules in lockstep with the CLI; nothing here is guessed
 * from a repo name.
 */

export const HINTS = ["gated", "large", "quant", "redundant", "subset"] as const;
export type Hint = (typeof HINTS)[number];

/** ≥ 20 GiB: more than one sitting, and often more than one disk. */
export const LARGE_PAYLOAD_BYTES = 20 * 1024 ** 3;
export const FULL_FIDELITY_DTYPES = new Set(["F64", "F32", "F16", "BF16"]);
const QUANT_FORMATS = new Set(["gguf"]);
export const WEIGHT_SUFFIXES = [".safetensors", ".bin", ".gguf", ".pt", ".pth"] as const;
/** Bytes per parameter; an unlisted dtype makes the expectation unknowable. */
export const DTYPE_WIDTHS: Record<string, number> = {
	F64: 8,
	I64: 8,
	F32: 4,
	I32: 4,
	F16: 2,
	BF16: 2,
	I16: 2,
	U16: 2,
	F8_E4M3: 1,
	F8_E5M2: 1,
	I8: 1,
	U8: 1,
	BOOL: 1,
};
/** Weight bytes at or above this multiple of one copy smell like several weight sets. */
export const REDUNDANT_FACTOR = 1.75;

export function isWeightFile(path: string): boolean {
	const lower = path.toLowerCase();
	return WEIGHT_SUFFIXES.some((s) => lower.endsWith(s));
}

export type SizedFile = { path: string; size: number | null };

/** Extension carrying most of the primary bytes, e.g. `gguf`; ties fall back to file count. */
export function dominantFormat(primary: SizedFile[]): string | null {
	const byExt = new Map<string, { size: number; count: number }>();
	for (const f of primary) {
		const base = f.path.slice(f.path.lastIndexOf("/") + 1);
		const dot = base.lastIndexOf(".");
		const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "(none)";
		const cur = byExt.get(ext) ?? { size: 0, count: 0 };
		byExt.set(ext, { size: cur.size + (f.size ?? 0), count: cur.count + 1 });
	}
	let best: string | null = null;
	let bestSize = -1;
	let bestCount = -1;
	for (const [ext, { size, count }] of byExt) {
		if (size > bestSize || (size === bestSize && count > bestCount)) {
			best = ext;
			bestSize = size;
			bestCount = count;
		}
	}
	return best;
}

/** One copy's weight bytes from published per-dtype parameter counts, or null. */
export function expectedWeightBytes(byDtype: unknown): number | null {
	if (byDtype === null || typeof byDtype !== "object" || Array.isArray(byDtype)) return null;
	const entries = Object.entries(byDtype as Record<string, unknown>);
	if (entries.length === 0) return null;
	let total = 0;
	for (const [dtype, count] of entries) {
		const width = DTYPE_WIDTHS[String(dtype).toUpperCase()];
		if (width === undefined || typeof count !== "number" || !Number.isInteger(count)) return null;
		total += count * width;
	}
	return total || null;
}

export type HintInput = {
	payloadBytes: number | null | undefined;
	gated: boolean | null | undefined;
	subset: boolean;
	dominantDtype: string | null | undefined;
	dominantFormat: string | null | undefined;
	weightsBytes?: number | null;
	paramsByDtype?: unknown;
};

export function hintsFrom(i: HintInput): Hint[] {
	const out = new Set<Hint>();
	if (i.gated) out.add("gated");
	if (typeof i.payloadBytes === "number" && Number.isFinite(i.payloadBytes) && i.payloadBytes >= LARGE_PAYLOAD_BYTES) {
		out.add("large");
	}
	if (i.subset) out.add("subset");
	if (
		(typeof i.dominantFormat === "string" && QUANT_FORMATS.has(i.dominantFormat.toLowerCase())) ||
		(typeof i.dominantDtype === "string" && !FULL_FIDELITY_DTYPES.has(i.dominantDtype.toUpperCase()))
	) {
		out.add("quant");
	}
	const expected = expectedWeightBytes(i.paramsByDtype);
	if (
		expected &&
		typeof i.weightsBytes === "number" &&
		Number.isFinite(i.weightsBytes) &&
		i.weightsBytes >= expected * REDUNDANT_FACTOR
	) {
		out.add("redundant");
	}
	return [...out].sort();
}

function cleanHints(raw: unknown[]): Hint[] {
	const known = new Set<string>(HINTS);
	const out = new Set<Hint>();
	for (const h of raw) if (typeof h === "string" && known.has(h)) out.add(h as Hint);
	return [...out].sort();
}

export type HintDigest = {
	payload_bytes?: number | null;
	gated?: boolean | null;
	dominant_dtype?: string | null;
	hints?: unknown;
};

/**
 * Hints for a stored digest. Stored `hints` win (the CLI wrote them); an
 * digest without them is derived from its measured fields the way the CLI's
 * `derive_hints` does — `large` and `gated` exactly, `quant` from the
 * dominant dtype only, `subset` from the entry's include globs. `redundant`
 * is live-estimate only and never re-derived here.
 */
export function entryHints(digest: HintDigest | null | undefined, include: string[] | null | undefined): Hint[] {
	const subset = Array.isArray(include) && include.length > 0;
	let hints: Hint[];
	if (digest && Array.isArray(digest.hints)) {
		hints = cleanHints(digest.hints);
	} else {
		hints = hintsFrom({
			payloadBytes: digest?.payload_bytes,
			gated: digest?.gated,
			subset,
			dominantDtype: digest?.dominant_dtype,
			dominantFormat: null,
		});
	}
	if (subset && !hints.includes("subset")) hints = ([...hints, "subset"] as Hint[]).sort();
	return hints;
}
