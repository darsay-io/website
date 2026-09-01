/**
 * Per-entry recipe cards: which darsay commands to teach for this exact row.
 *
 * Pure and static. Everything is derived from the entry's own fields (source,
 * revision, include, payload_bytes, gated, parameters/dtype from the cached
 * estimate digest) plus the board's own page URL — no catalog.json field, no
 * server round-trip. Wording mirrors `examples/README.md` in darsay-io/darsay;
 * user text is only ever placed inside single quotes, never in comments.
 */
import { canonicalizeSource } from "../worker/sources.ts";

/** ≳ 20 GiB: more than one sitting, and often more than one disk. */
export const LARGE_BYTES = 20 * 1024 ** 3;
/** The cookbook "tonight" budget. */
export const BUDGET_GB = 10;
/** The cookbook per-friend shard budget. */
export const SHARD_GB = 20;
/** The cookbook example glob for a GGUF pack. */
export const QUANT_GLOB = "*Q4_K_M*";
export const DEFAULT_VAULT = "~/darsay";

export const DOCS = {
	first: { href: "/docs/examples/#first-bundle", label: "Cookbook → First bundle" },
	estimate: { href: "/docs/examples/#estimate-first", label: "Cookbook → Estimate first" },
	budget: {
		href: "/docs/examples/#pause-and-resume-a-large-archive",
		label: "Cookbook → Pause and resume",
	},
	halves: {
		href: "/docs/incremental/#across-disks-assemble---move-and-skeletons",
		label: "Design → assemble --move and skeletons",
	},
	subset: {
		href: "/docs/examples/#price-one-quant-from-a-pack-repo",
		label: "Cookbook → Price one quant",
	},
	dataset: { href: "/docs/examples/#archive-a-dataset", label: "Cookbook → Archive a dataset" },
	shards: {
		href: "/docs/examples/#split-a-download-across-machines",
		label: "Cookbook → Split a download",
	},
	adopt: { href: "/docs/examples/#share-a-catalog", label: "Cookbook → Share a catalog" },
	board: {
		href: "/docs/examples/#keep-a-darsayio-board-honest",
		label: "Cookbook → Keep a board honest",
	},
	export: { href: "/docs/examples/#export-to-a-usb-drive", label: "Cookbook → Export to a USB drive" },
} as const;

export type RecipeInput = {
	source: string;
	revision: string | null;
	include: string[] | null;
	payload_bytes: number | null;
	artifact_type?: string | null;
	gated?: boolean | null;
	parameters?: number | null;
	dominant_dtype?: string | null;
};

export type RecipeKey =
	| "estimate"
	| "archive"
	| "board"
	| "budget"
	| "halves"
	| "subset"
	| "shards"
	| "adopt"
	| "after";

export type Trait = "large" | "gated" | "subset" | "pack" | "dataset" | "opaque" | "unsized";

export type Recipe = {
	key: RecipeKey;
	/** Serif headline of the spell. */
	title: string;
	/** One or two sentences: the idea this recipe teaches. */
	why: string;
	/** Terminal-chrome label. */
	label: string;
	/** Shell lines. `# comments` are rendered dimmer; the copy button copies all lines. */
	lines: string[];
	doc?: { href: string; label: string };
	/** Show the board's Download catalog button next to this recipe. */
	download?: boolean;
};

export type RecipeSet = {
	traits: Trait[];
	/** Short serif headline for the card, in context for this entry. */
	headline: string;
	/** Dot-separated facts row (size, params, kind, gated, globs, pin). */
	facts: string[];
	/** One sentence of judgment about this entry. */
	verdict: string;
	/** The 2–4 recipes worth showing first. */
	hero: Recipe[];
	/** Everything else, behind "More ways". */
	more: Recipe[];
};

const SAFE_WORD = /^[A-Za-z0-9_.,:@%+=/-]+$/;

/** POSIX-shell quote. Bare when it needs nothing; single-quoted otherwise. */
export function shellQuote(s: string): string {
	if (s.length > 0 && SAFE_WORD.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Globs are always single-quoted, as the cookbook writes them. */
export function quoteGlob(g: string): string {
	return `'${g.replace(/'/g, `'\\''`)}'`;
}

export function includeArgs(include: string[] | null | undefined): string {
	if (!include || include.length === 0) return "";
	return include.map((g) => ` --include ${quoteGlob(g)}`).join("");
}

/** `owner--name` (or `datasets--owner--name`), as the CLI names a bundle directory. */
export function bundleName(source: string): string | null {
	const parsed = canonicalizeSource(source);
	if (parsed.kind !== "hf") return null;
	const slug = parsed.locator.split("/").join("--").toLowerCase();
	return parsed.artifactType === "dataset" ? `datasets--${slug}` : slug;
}

/** The `<rev>` path segment: the first 12 of a hex pin, else the cookbook placeholder. */
export function revision12(revision: string | null | undefined): string {
	if (revision && /^[0-9a-fA-F]{12,}$/.test(revision)) return revision.slice(0, 12).toLowerCase();
	return "<rev>";
}

export function humanSize(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	if (n < 1024) return `${n} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Mirrors the CLI's human_params: 27.78B, 596.0M. */
export function humanParams(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	return String(n);
}

/** Half of the payload in GiB, rounded up to a multiple of 5 — the two-disk hand-over size. */
export function halfBudgetGb(bytes: number): number {
	const half = Math.ceil(bytes / 1024 ** 3 / 2);
	return Math.max(5, Math.ceil(half / 5) * 5);
}

type Row = string | [cmd: string, comment: string];

/** Align trailing comments in a column, the way the cookbook lays them out. */
export function alignComments(rows: Row[]): string[] {
	const widths = rows.filter((r): r is [string, string] => Array.isArray(r)).map((r) => r[0].length);
	const col = Math.min(widths.length ? Math.max(...widths) : 0, 80) + 2;
	return rows.map((r) => {
		if (!Array.isArray(r)) return r;
		const [cmd, comment] = r;
		const gap = cmd.length >= col ? "  " : " ".repeat(col - cmd.length);
		return `${cmd}${gap}# ${comment}`;
	});
}

export function deriveRecipes(e: RecipeInput, catalogId: string, boardUrl?: string): RecipeSet {
	const parsed = canonicalizeSource(e.source);
	const hf = parsed.kind === "hf" ? parsed : null;
	const kind: "model" | "dataset" | null =
		e.artifact_type === "dataset" || e.artifact_type === "model"
			? e.artifact_type
			: (hf?.artifactType ?? null);
	const dataset = kind === "dataset";
	const include = e.include && e.include.length ? e.include : null;
	const bytes = typeof e.payload_bytes === "number" ? e.payload_bytes : null;
	const size = humanSize(bytes);
	const packLarge = bytes !== null && bytes >= LARGE_BYTES;
	const gated = e.gated === true;
	/** A GGUF pack listed whole: the sane path is one glob, not the whole pack. */
	const pack = !!hf && !include && !dataset && /gguf/i.test(e.source);
	const large = packLarge && !include && !pack;
	const bundle = bundleName(e.source);
	const bundleArg = bundle ? shellQuote(bundle) : "<bundle>";
	const rev = revision12(e.revision);
	const dir = (vault: string) => `${vault}/${bundleArg}/${rev}`;
	const src = shellQuote(e.source) + (e.revision ? ` --revision ${shellQuote(e.revision)}` : "");
	const srcInc = src + includeArgs(include);
	const cat = shellQuote(catalogId);

	const traits: Trait[] = [];
	if (!hf) traits.push("opaque");
	if (large) traits.push("large");
	if (gated) traits.push("gated");
	if (include) traits.push("subset");
	if (pack) traits.push("pack");
	if (dataset) traits.push("dataset");
	if (bytes === null) traits.push("unsized");

	const facts: string[] = [];
	if (bytes !== null) facts.push(include ? `${size} before --include` : size);
	else facts.push("size unknown");
	if (e.parameters) facts.push(humanParams(e.parameters) + (e.dominant_dtype ? ` ${e.dominant_dtype}` : ""));
	if (kind) facts.push(kind);
	if (gated) facts.push("gated");
	if (include) facts.push(include.length === 1 ? "1 glob" : `${include.length} globs`);
	if (e.revision) facts.push(`pin ${e.revision.slice(0, 12)}`);

	let headline: string;
	let verdict: string;
	if (!hf) {
		headline = "Another provider";
		verdict =
			"Not a Hugging Face address. darsay resolves it through its provider registry — the same verbs, if a provider claims the scheme.";
	} else if (gated && large) {
		headline = "Gated, and too big for one sitting";
		verdict = `Gated upstream and ${size} deep. Accept the author's terms once, then budget it — or fetch it in halves across two disks.`;
	} else if (gated) {
		headline = "Behind a gate";
		verdict =
			"Gated upstream. Accept the author's terms on the Hub and sign in once; after that it is the same verbs as any other source.";
	} else if (large) {
		headline = "Too big for one sitting";
		verdict = `${size} is more than one sitting${dataset ? "" : ", and often more than one disk"}. Budget it, split it, or fetch it in halves — every run converges on the same pinned bundle.`;
	} else if (include) {
		headline = "Just the subset";
		verdict = `Only files matching ${include.join(", ")} — config, tokenizer, and license sidecars ride along.${
			packLarge ? ` The whole pack is ${size}; estimate --include prices just the glob.` : ""
		}`;
	} else if (pack) {
		headline = "Pick one quant";
		verdict =
			"A pack repo — likely hundreds of gigabytes of named quants. Price one glob and archive just that.";
	} else if (dataset) {
		headline = "A dataset, same verbs";
		verdict =
			"Payload lands under data/. hydrate and run do not apply — open it with whatever already reads the format.";
	} else if (bytes === null) {
		headline = "Unpriced, so far";
		verdict = "No size on record yet. estimate prices it from Hub metadata without writing a file.";
	} else {
		headline = "Small enough for tonight";
		verdict = `${size}: one sitting. Estimate, archive, and talk to it offline before you sleep.`;
	}

	const estimate: Recipe = {
		key: "estimate",
		title: "Estimate first",
		why: large
			? `A ${size} commitment. Price it from Hub metadata — no download, no files written.`
			: bytes === null
				? "Price it from Hub metadata — no download, no files written. Exit code says whether disk suffices."
				: "See the size before you commit. Priced from Hub metadata; nothing is written.",
		label: "price it",
		lines: [`darsay estimate ${srcInc}`],
		doc: DOCS.estimate,
	};

	const archive: Recipe = {
		key: "archive",
		title: gated ? "Accept the terms, then archive" : include ? "Grab just the subset" : "Archive it",
		why: gated
			? "The gate is enforced server-side; darsay does not bypass it. Accept the author's terms on the Hub, sign in once, then the same verb as any other source."
			: include
				? "Only files matching the globs, plus config, tokenizer, and license sidecars. The manifest records what was omitted upstream."
				: dataset
					? "Same verbs as a model; the payload lands under data/. Interrupt any time and rerun the same line."
					: "Pin it, verify it, register it. Interrupt any time and rerun the same line — every run converges on the same bundle.",
		label: "pin · verify · register",
		lines: gated
			? alignComments([
					["hf auth login", "once, after accepting the terms on huggingface.co"],
					`darsay archive ${srcInc}`,
				])
			: [`darsay archive ${srcInc}`],
		doc: gated && hf ? { href: hf.url, label: "Accept the terms on Hugging Face" } : dataset ? DOCS.dataset : DOCS.first,
	};

	/** The row-specific board round trip: `archive SOURCE --board URL`, as the cookbook writes it. */
	const board: Recipe | null = boardUrl
		? {
				key: "board",
				title: "Bring the board along",
				why:
					"The most basic board form: name this row's source and add --board. darsay claims the row before fetching — a second machine picks a different one — and every boundary, start, clean pause, registration, updates the gauge and status here on its own. When it registers, the row flips to have.",
				label: "claim · fetch · report",
				lines: [`darsay archive ${srcInc} --board ${shellQuote(boardUrl)}`],
				doc: DOCS.board,
			}
		: null;

	const budget: Recipe = {
		key: "budget",
		title: "Pause and resume",
		why: "Too big for one sitting. Stop at 10 GB, rerun the same line tomorrow — completed files are trusted, partial files resume with Range. The pin is frozen on the first run.",
		label: "tonight · tomorrow · finish",
		lines: alignComments([
			[`darsay archive ${srcInc} --max-gb ${BUDGET_GB}`, `tonight: first ${BUDGET_GB} GB`],
			[`darsay archive ${srcInc} --max-gb ${BUDGET_GB}`, `tomorrow: next ${BUDGET_GB} GB`],
			[`darsay archive ${srcInc} --dry-run`, "what's left?"],
			[`darsay archive ${srcInc}`, "finish, verify, register"],
		]),
		doc: DOCS.budget,
	};

	const half = bytes !== null ? halfBudgetGb(bytes) : 30;
	const halves: Recipe = {
		key: "halves",
		title: "Fetch it in halves across two disks",
		why: "The laptop has the bandwidth, the big drive has the room, and they never meet. Hand a half over with --move; the laptop keeps a skeleton — the pin and the hashes — and never re-fetches what it gave away.",
		label: "café · big drive · café · big drive",
		lines: [
			`# laptop, at the café — the first ${half} GB`,
			`darsay archive ${srcInc} --max-gb ${half}`,
			"",
			"# laptop plugged into the big drive — hand the half over, keep the skeleton",
			`darsay --vault /Volumes/big assemble ${dir(DEFAULT_VAULT)} --move`,
			"",
			`# laptop, back at the café — the other ${half} GB (the moved half is never re-fetched)`,
			`darsay archive ${srcInc} --max-gb ${half}`,
			"",
			"# big drive — the second hand-over completes it and dissolves the skeleton",
			`darsay --vault /Volumes/big assemble ${dir(DEFAULT_VAULT)} --move`,
			...alignComments([[`darsay --vault /Volumes/big archive ${srcInc}`, "registers, zero network"]]),
		],
		doc: DOCS.halves,
	};

	const subset: Recipe = {
		key: "subset",
		title: "Grab just one quant",
		why: "A pack repo — hundreds of gigabytes of named quants. --include prices a glob against Hub metadata, then archives only those files plus config, tokenizer, and license sidecars.",
		label: "one glob",
		lines: [
			`darsay estimate ${src} --include ${quoteGlob(QUANT_GLOB)}`,
			`darsay archive  ${src} --include ${quoteGlob(QUANT_GLOB)}`,
		],
		doc: DOCS.subset,
	};

	const shards: Recipe = {
		key: "shards",
		title: "Split it with a friend",
		why: "--shard N/T is a priority, not a partition: each of you prefers a different half, and either can finish alone. Merge offline with the same assemble that --move uses — two people, or one person and two disks.",
		label: "alice · bob · assemble",
		lines: [
			"# alice, on her machine",
			`darsay --vault /usb/alice archive ${srcInc} --shard 1/2 --max-gb ${SHARD_GB}`,
			"",
			"# bob, on his",
			`darsay --vault /usb/bob   archive ${srcInc} --shard 2/2 --max-gb ${SHARD_GB}`,
			"",
			"# later, offline, no Hub required",
			`darsay --vault ./combined assemble ${dir("/usb/alice")} ${dir("/usb/bob")}`,
			...alignComments([[`darsay --vault ./combined archive ${srcInc}`, "register if complete"]]),
		],
		doc: DOCS.shards,
	};

	const adopt: Recipe = {
		key: "adopt",
		title: "Adopt the whole board",
		why: "Download the catalog, then let --next pick the highest-desire source you do not have yet. archive never rewrites the catalog — status is a view of your vault.",
		label: "catalog → vault",
		lines: alignComments([
			`darsay catalog new ${cat}`,
			[`darsay catalog adopt ${cat} ./${cat}.json`, "copy intent; your overlay, your bytes"],
			[`darsay archive --next ${cat} --max-gb ${BUDGET_GB}`, "the next unfinished source"],
		]),
		doc: DOCS.adopt,
		download: true,
	};

	const after: Recipe = {
		key: "after",
		title: "Once it's on disk",
		why: dataset
			? "Prove the bytes have not drifted, read the index card, or hand a friend a USB drive — one deterministic tar."
			: "Prove the bytes have not drifted, talk to it offline, or hand a friend a USB drive — one deterministic tar.",
		label: "verify · run · export",
		lines: alignComments([
			[`darsay verify ${bundleArg}`, "re-hash every payload file"],
			dataset
				? [`darsay info ${bundleArg}`, "the index card"]
				: [`darsay run ${bundleArg} "Say hello"`, "offline; the payload is not touched"],
			[`darsay export ${bundleArg} -o /Volumes/USB`, "one .mvb.tar, same bytes every time"],
		]),
		doc: DOCS.export,
	};

	// With a board URL the report-back card joins the hero four; whatever it
	// displaces leads "More ways" so nothing is lost, only reordered.
	let hero: Recipe[];
	let more: Recipe[];
	if (!hf) {
		hero = [estimate, archive, ...(board ? [board] : []), adopt];
		more = [];
	} else if (large) {
		hero = gated
			? [estimate, archive, budget, ...(board ? [board] : [halves])]
			: [estimate, budget, ...(board ? [board, halves] : [halves, shards])];
		more = gated
			? [...(board ? [halves] : []), shards, adopt, after]
			: [...(board ? [shards] : []), archive, adopt, after];
	} else if (pack) {
		hero = [subset, estimate, ...(board ? [board] : []), adopt];
		more = [archive, ...(packLarge ? [budget] : []), shards, after];
	} else if (include) {
		hero = [estimate, archive, ...(board ? [board] : []), adopt];
		more = [...(packLarge ? [budget] : []), shards, after];
	} else if (gated) {
		hero = [estimate, archive, ...(board ? [board] : []), adopt];
		more = [shards, after];
	} else {
		hero = board ? [estimate, archive, board, after] : [estimate, archive, after, adopt];
		more = board ? [adopt, shards] : [shards];
	}

	return { traits, headline, facts, verdict, hero, more };
}
