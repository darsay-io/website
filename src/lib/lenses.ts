/**
 * Lenses: the filters across the top of a board's ledger, and the traits a
 * row is read through. Pure and static — every lens is decided from the
 * row's own fields. Hints come from the CLI's closed vocabulary (or the
 * worker's port of it); a handful of lenses read the repo *name* instead
 * and say so, because the CLI never guesses from a name.
 */
import { FULL_FIDELITY_DTYPES, LARGE_PAYLOAD_BYTES, type Hint } from "../worker/hints.ts";
import { artifactTypeFromSource, canonicalizeSource } from "../worker/sources.ts";
import { familyKey, lineageOf } from "./lineage.ts";
import type { PrimerKey } from "./primer.ts";

export type LensKey =
	| "want"
	| "have"
	| "claimed"
	| "negatives"
	| "large"
	| "quant"
	| "redundant"
	| "gated"
	| "subset"
	| "abliterated"
	| "base"
	| "moe"
	| "spec"
	| "dataset"
	| "closed"
	| "unpriced";

export type LensEntry = {
	source: string;
	status: "want" | "have";
	payload_bytes: number | null;
	include?: string[] | null;
	artifact_type?: string | null;
	gated?: boolean | null;
	dominant_dtype?: string | null;
	hints?: string[] | null;
	policy?: string | null;
	precision?: string | null;
	bytes_per_param?: number | null;
	closed?: boolean | null;
	claim?: { state: "archiving" | "paused" | "done" } | null;
};

/** A closed work: the API says so, else the address does (a home URL). */
export function isClosed(e: Pick<LensEntry, "source" | "closed">): boolean {
	if (typeof e.closed === "boolean") return e.closed;
	return canonicalizeSource(e.source).kind === "home";
}

export type LensGroup = "ledger" | "policy" | "name" | "kind";

export type Lens = {
	key: LensKey;
	label: string;
	/** The adjective for a generated sentence: "the one gated row", "all 13 large rows". */
	noun: string;
	group: LensGroup;
	/** The field-guide card that explains this lens. */
	primer: PrimerKey;
	/** One sentence shown under the toolbar while the lens is active. */
	blurb: string;
	/** Decided from the repo name rather than the bytes. */
	fromName?: boolean;
	test: (e: LensEntry) => boolean;
};

/** The repo name after `owner/` (and after `datasets/`), or the whole ref for another provider. */
export function repoName(source: string): string {
	const parsed = canonicalizeSource(source);
	if (parsed.kind === "hf") return parsed.locator.split("/").slice(1).join("/");
	return source;
}

export const ABLITERATED_RE = /abliterat|obliterat|heretic|(?:^|[^a-z])ablat/i;
/**
 * Pretrained-only releases: a capitalised `-Base` segment (Kimi-K2-Base,
 * DeepSeek-V3-Base), or `base`/`pt` right after a size token (gemma-3-27b-pt,
 * qwen3-8b-base). Never bare `-base`, which names a size tier on BERT, T5,
 * Whisper, and the embedding models.
 */
export const BASE_RE = /[-_.]Base(?=$|[-_.])|\d(?:\.\d+)?[bm][-_.](?:base|pt)(?=$|[-_.])/;
export const MOE_NAME_RE = /(\d+(?:\.\d+)?)B-A(\d+(?:\.\d+)?)B/i;
export const MOE_HINT_RE = /\bmoe\b|\d+x\d+(?:\.\d+)?b\b/i;
/** Draft heads and draft models. EAGLE only beside a target family, so NVIDIA's Eagle VLMs stay out. */
export const SPEC_RE = /speculat|medusa|(?:^|[-_.])draft(?=$|[-_.\d])/i;
const EAGLE_RE = /eagle/i;
const EAGLE_TARGET_RE = /llama|qwen|vicuna|mistral|mixtral|gemma|deepseek|glm|phi|yi|speculat/i;

export function isAbliterated(source: string): boolean {
	return ABLITERATED_RE.test(repoName(source));
}

export function isBaseModel(source: string): boolean {
	if (artifactTypeFromSource(source) === "dataset") return false;
	return BASE_RE.test(repoName(source));
}

/** `480B-A35B` → { total: 480, active: 35 }; a bare MoE/8x7B name → nulls; not MoE → null. */
export function moeFromName(source: string): { total: number | null; active: number | null } | null {
	const name = repoName(source);
	const m = MOE_NAME_RE.exec(name);
	if (m) return { total: Number(m[1]), active: Number(m[2]) };
	if (MOE_HINT_RE.test(name)) return { total: null, active: null };
	return null;
}

export function isSpeculator(source: string): boolean {
	if (artifactTypeFromSource(source) === "dataset") return false;
	if (/rwkv/i.test(source)) return false; // RWKV's "Eagle" is an architecture, not a draft head
	const name = repoName(source);
	if (SPEC_RE.test(name)) return true;
	return EAGLE_RE.test(name) && EAGLE_TARGET_RE.test(name);
}

/**
 * The row's hints as the CLI would read them: stored hints first, then the
 * on-the-fly derivations the catalog docs sanction for a digest without
 * them (large, gated, subset, and quant from the dtype).
 */
export function effectiveHints(e: LensEntry): Hint[] {
	const out = new Set<Hint>();
	for (const h of e.hints ?? []) {
		if (h === "gated" || h === "large" || h === "quant" || h === "redundant" || h === "subset") out.add(h);
	}
	if (e.gated === true) out.add("gated");
	if (typeof e.payload_bytes === "number" && e.payload_bytes >= LARGE_PAYLOAD_BYTES) out.add("large");
	if (e.include && e.include.length) out.add("subset");
	if (typeof e.dominant_dtype === "string" && !FULL_FIDELITY_DTYPES.has(e.dominant_dtype.toUpperCase())) {
		out.add("quant");
	}
	return [...out].sort();
}

function kind(e: LensEntry): "model" | "dataset" | null {
	if (e.artifact_type === "dataset" || e.artifact_type === "model") return e.artifact_type;
	return artifactTypeFromSource(e.source);
}

/** Rows of one family (case-folded key), read from each work's name. */
export function inFamily(e: Pick<LensEntry, "source">, key: string): boolean {
	return familyKey(lineageOf(e.source)) === key;
}

export function inFlight(e: LensEntry): boolean {
	return !!e.claim && e.claim.state !== "done";
}

export const LENSES: Lens[] = [
	{
		key: "want",
		label: "Want",
		noun: "wanted",
		group: "ledger",
		primer: "desire",
		blurb: "Not yet in any vault on this board. Sorted by desire, this is the queue `archive --next` walks.",
		test: (e) => e.status !== "have",
	},
	{
		key: "have",
		label: "Have",
		noun: "held",
		group: "ledger",
		primer: "desire",
		blurb: "A member says a complete bundle sits in their vault — Who says whose. The CLI ticks it for real when it reports done.",
		test: (e) => e.status === "have",
	},
	{
		key: "claimed",
		label: "In flight",
		noun: "in-flight",
		group: "ledger",
		primer: "claims",
		blurb: "A collector's CLI has claimed the row and is reporting progress; `--next` skips it for everyone else.",
		test: inFlight,
	},
	{
		key: "negatives",
		label: "Negatives",
		noun: "negatives-priced",
		group: "policy",
		primer: "negatives",
		blurb: "Priced as the negative set: the CLI classified the repo and the size shown is what `archive` will actually fetch — negatives, not prints.",
		test: (e) => e.policy === "negatives",
	},
	{
		key: "large",
		label: "Large",
		noun: "large",
		group: "policy",
		primer: "large",
		blurb: "20 GiB or more — more than one sitting, often more than one disk. Budget it with the dials, or fetch it in halves.",
		test: (e) => effectiveHints(e).includes("large"),
	},
	{
		key: "quant",
		label: "Quant",
		noun: "quant",
		group: "policy",
		primer: "quant",
		blurb: "A published quantized artifact: mostly GGUF, or a dominant dtype below full fidelity. Some are prints; a native FP8 or INT4 release is the negative.",
		test: (e) => effectiveHints(e).includes("quant"),
	},
	{
		key: "redundant",
		label: "Redundant",
		noun: "redundant",
		group: "policy",
		primer: "redundant",
		blurb: "The weight bytes are at least 1.75× one copy of the parameter count — the repo ships several weight sets. `darsay classify` shows which.",
		test: (e) => effectiveHints(e).includes("redundant"),
	},
	{
		key: "gated",
		label: "Gated",
		noun: "gated",
		group: "policy",
		primer: "gated",
		blurb: "Upstream asks you to accept the author's terms first. Accept on the Hub, `hf auth login` once, then the same verbs as any other source.",
		test: (e) => effectiveHints(e).includes("gated"),
	},
	{
		key: "subset",
		label: "Subset",
		noun: "subset",
		group: "policy",
		primer: "subset",
		blurb: "Pinned with `--include`: only the named files plus the sidecars a single file needs to load. The manifest records what was left upstream.",
		test: (e) => effectiveHints(e).includes("subset"),
	},
	{
		key: "abliterated",
		label: "Abliterated",
		noun: "abliterated",
		group: "name",
		primer: "abliterated",
		fromName: true,
		blurb: "The refusal direction was ablated out of the weights — a one-way edit nothing can regenerate from the base. Read from the repo name.",
		test: (e) => isAbliterated(e.source),
	},
	{
		key: "base",
		label: "Base",
		noun: "base",
		group: "name",
		primer: "base",
		fromName: true,
		blurb: "Pretrained only — the root of a lineage, the artifact you would need to restart development. Read from the repo name.",
		test: (e) => isBaseModel(e.source),
	},
	{
		key: "moe",
		label: "MoE",
		noun: "MoE",
		group: "name",
		primer: "moe",
		fromName: true,
		blurb: "Mixture of experts: the first number is what you archive, the second is what each token touches. Read from the repo name.",
		test: (e) => moeFromName(e.source) !== null,
	},
	{
		key: "spec",
		label: "Speculators",
		noun: "speculator",
		group: "name",
		primer: "spec",
		fromName: true,
		blurb: "Draft models and EAGLE/Medusa heads — small, trained, and only useful beside the exact target they were made for. Read from the repo name.",
		test: (e) => isSpeculator(e.source),
	},
	{
		key: "dataset",
		label: "Datasets",
		noun: "dataset",
		group: "kind",
		primer: "dataset",
		blurb: "The second artifact type: `datasets/owner/name`, payload under `data/`, same verbs, no engine.",
		test: (e) => kind(e) === "dataset",
	},
	{
		key: "closed",
		label: "Closed",
		noun: "closed",
		group: "kind",
		primer: "closed",
		blurb: "A home page, not a source: an API-only model or an announced release. No price, nothing to fetch — a place held in its family until weights ship.",
		test: (e) => isClosed(e),
	},
	{
		key: "unpriced",
		label: "Unpriced",
		noun: "unpriced",
		group: "kind",
		primer: "large",
		blurb: "No size on record yet — upstream returned nothing to price. `darsay estimate` prices it from Hub metadata without writing a file.",
		test: (e) => e.payload_bytes === null && !isClosed(e),
	},
];

export const LENS_BY_KEY: Record<LensKey, Lens> = Object.fromEntries(LENSES.map((l) => [l.key, l])) as Record<
	LensKey,
	Lens
>;

export function isLensKey(s: string): s is LensKey {
	return Object.prototype.hasOwnProperty.call(LENS_BY_KEY, s);
}

/** Which lenses a row passes through. */
export function lensesFor(e: LensEntry): Set<LensKey> {
	const out = new Set<LensKey>();
	for (const l of LENSES) if (l.test(e)) out.add(l.key);
	return out;
}

/** Rows matching every active lens (AND), and the family when one is chosen. */
export function applyLenses<T extends LensEntry>(rows: T[], active: Iterable<LensKey>, family: string | null = null): T[] {
	const keys = [...active];
	const inFam = family ? rows.filter((r) => inFamily(r, family)) : rows;
	if (keys.length === 0) return inFam;
	return inFam.filter((r) => keys.every((k) => LENS_BY_KEY[k].test(r)));
}

/** Rows each lens would match on its own. */
export function lensCounts(rows: LensEntry[]): Map<LensKey, number> {
	const m = new Map<LensKey, number>();
	for (const l of LENSES) m.set(l.key, 0);
	for (const r of rows) for (const k of lensesFor(r)) m.set(k, (m.get(k) ?? 0) + 1);
	return m;
}

/**
 * Rows each lens would leave when added to the active set — the number a
 * chip should show while other lenses are on, so the counts never promise
 * rows the AND would drop.
 */
export function lensCountsGiven(rows: LensEntry[], active: LensKey[]): Map<LensKey, number> {
	const m = new Map<LensKey, number>();
	for (const l of LENSES) {
		const others = active.filter((k) => k !== l.key);
		const base = applyLenses(rows, others);
		m.set(l.key, base.filter((r) => l.test(r)).length);
	}
	return m;
}

export type Tally = { n: number; bytes: number; wantBytes: number; haveBytes: number; unsized: number };

export function tally(rows: LensEntry[]): Tally {
	const t: Tally = { n: rows.length, bytes: 0, wantBytes: 0, haveBytes: 0, unsized: 0 };
	for (const r of rows) {
		if (typeof r.payload_bytes !== "number") {
			if (!isClosed(r)) t.unsized += 1;
			continue;
		}
		t.bytes += r.payload_bytes;
		if (r.status === "have") t.haveBytes += r.payload_bytes;
		else t.wantBytes += r.payload_bytes;
	}
	return t;
}

/* ── View state in the URL fragment: shareable, never sent to the server ── */

export type SortKey = "desire" | "source" | "type" | "size" | "status" | "family";
export type ViewMode = "ledger" | "lineage";
export type ViewState = {
	lenses: LensKey[];
	sort: SortKey | null;
	dir: "asc" | "desc" | null;
	/** A family key (case-folded), read from the names on the board. */
	family: string | null;
	view: ViewMode | null;
	/**
	 * A row to open the page at: its integer `id`, or its source the way a
	 * person would write it — `owner/name`, `datasets/owner/name`, a Hub
	 * URL, a closed work's home page. `resolveRowLink` in `board.ts` finds
	 * the row; the link outlives a remove and re-add when it names the source.
	 */
	row: string | null;
};

const SORT_KEYS = new Set<string>(["desire", "source", "type", "size", "status", "family"]);
const FAMILY_KEY_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ROW_TARGET_MAX = 512;

export function parseView(hash: string): ViewState {
	const out: ViewState = { lenses: [], sort: null, dir: null, family: null, view: null, row: null };
	const raw = hash.replace(/^#/, "");
	if (!raw) return out;
	const params = new URLSearchParams(raw);
	const lens = params.get("lens");
	if (lens) {
		for (const k of lens.split(",")) if (isLensKey(k) && !out.lenses.includes(k)) out.lenses.push(k);
	}
	const family = params.get("family");
	if (family && FAMILY_KEY_RE.test(family)) out.family = family;
	const view = params.get("view");
	if (view === "lineage" || view === "ledger") out.view = view;
	const sort = params.get("sort");
	if (sort) {
		const [key, dir] = sort.split(":");
		if (SORT_KEYS.has(key)) {
			out.sort = key as SortKey;
			out.dir = dir === "asc" ? "asc" : dir === "desc" ? "desc" : null;
		}
	}
	const row = params.get("row")?.trim();
	if (row && row.length <= ROW_TARGET_MAX) out.row = row;
	return out;
}

/** A row target as it should read in a link: `/` and `:` stay themselves, the rest is escaped. */
export function encodeRowTarget(row: string): string {
	return encodeURIComponent(row).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
}

export function formatView(v: ViewState, defaults: { sort: SortKey; dir: "asc" | "desc" }): string {
	const params: string[] = [];
	if (v.view === "lineage") params.push("view=lineage");
	if (v.family) params.push(`family=${encodeURIComponent(v.family)}`);
	if (v.lenses.length) params.push(`lens=${v.lenses.join(",")}`);
	if (v.sort && v.dir && (v.sort !== defaults.sort || v.dir !== defaults.dir)) params.push(`sort=${v.sort}:${v.dir}`);
	if (v.row) params.push(`row=${encodeRowTarget(v.row)}`);
	return params.length ? `#${params.join("&")}` : "";
}
