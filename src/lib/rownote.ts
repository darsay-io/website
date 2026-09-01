/**
 * "On this row": a field-guide card applied to the entry it was opened from.
 * Pure text (inline markup: `code`, **strong**) from the row's own fields —
 * the same arithmetic the CLI does, shown for the thing the reader clicked.
 */
import { DTYPE_WIDTHS, LARGE_PAYLOAD_BYTES, REDUNDANT_FACTOR } from "../worker/hints.ts";
import { moeFromName } from "./lenses.ts";
import type { PrimerKey } from "./primer.ts";
import { BUDGET_GB, bundleName, halfBudgetGb, humanParams, humanSize, revision12 } from "./recipes.ts";

export type RowFacts = {
	source: string;
	status: "want" | "have";
	payload_bytes: number | null;
	desire?: number | null;
	revision?: string | null;
	include?: string[] | null;
	artifact_type?: string | null;
	gated?: boolean | null;
	parameters?: number | null;
	dominant_dtype?: string | null;
	hints?: string[] | null;
	policy?: string | null;
	holders?: string;
	claim?: { client: string; state: "archiving" | "paused" | "done"; percent: number | null } | null;
};

const GiB = 1024 ** 3;
/** The cookbook's "cap the bandwidth" example rate. */
const LINK_MIB_S = 25;

function ratioBand(ratio: number): string {
	if (ratio >= REDUNDANT_FACTOR) return "well over one copy — the repo carries several weight sets";
	if (ratio >= 0.85) return "about one copy";
	return "under one copy — packed weights, or a subset";
}

/** One copy's bytes from the row's parameter count and dtype, or null. */
export function oneCopyBytes(row: RowFacts): number | null {
	if (!row.parameters || !row.dominant_dtype) return null;
	const width = DTYPE_WIDTHS[row.dominant_dtype.toUpperCase()];
	if (width === undefined) return null;
	return row.parameters * width;
}

function hoursAtLink(bytes: number): string {
	const hours = bytes / (LINK_MIB_S * 1024 ** 2) / 3600;
	if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
	if (hours < 10) return `${hours.toFixed(1).replace(/\.0$/, "")} hours`;
	if (hours < 48) return `${Math.round(hours)} hours`;
	return `${Math.round(hours / 24)} days`;
}

function dtypeNote(row: RowFacts): string | null {
	const one = oneCopyBytes(row);
	if (one === null || !row.parameters || !row.dominant_dtype) return null;
	const width = DTYPE_WIDTHS[row.dominant_dtype.toUpperCase()];
	const lead = `\`${humanParams(row.parameters)}\` × ${width} ${width === 1 ? "byte" : "bytes"} (\`${row.dominant_dtype}\`) ≈ **${humanSize(one)}** for one copy.`;
	if (row.payload_bytes === null) return `${lead} The row has no size yet.`;
	const ratio = row.payload_bytes / one;
	const priced = row.policy === "masters" ? "priced masters-first at" : "priced at";
	return `${lead} The row is ${priced} **${humanSize(row.payload_bytes)}** — ${ratio.toFixed(ratio >= 10 ? 0 : 1)}×, ${ratioBand(ratio)}.`;
}

/** The row's revision as the row shows it: a 12-character pin, or the ref itself. */
function shownRevision(revision: string): string {
	const pin = revision12(revision);
	return pin === "<rev>" ? revision : pin;
}

export function rowNote(key: PrimerKey, row: RowFacts): string | null {
	const bytes = row.payload_bytes;
	const hints = row.hints ?? [];
	switch (key) {
		case "dtype":
		case "redundant":
			return dtypeNote(row);
		case "large": {
			if (bytes === null) return "No size on record yet, so no plan yet — `darsay estimate` prices it without writing a file.";
			if (bytes < LARGE_PAYLOAD_BYTES) return `**${humanSize(bytes)}** is under the 20 GiB line: one sitting.`;
			const evenings = Math.ceil(bytes / GiB / BUDGET_GB);
			return `**${humanSize(bytes)}**: ${evenings} evenings at \`--max-gb ${BUDGET_GB}\`, or about ${hoursAtLink(bytes)} of link time at ${LINK_MIB_S} MiB/s. In halves, ${halfBudgetGb(bytes)} GiB to each disk.`;
		}
		case "masters":
			if (row.policy === "masters") return `Priced masters-first: **${humanSize(bytes)}** is what \`archive\` will fetch, prints skipped on the record.`;
			return `Not yet classified by the CLI, so the size is the whole repo. \`darsay estimate <board-url>\` re-prices every row masters-first.`;
		case "quant": {
			const dt = row.dominant_dtype;
			if (hints.includes("quant") && dt) {
				return `Dominant dtype \`${dt}\` — below full fidelity, so the chip is on. If no higher-fidelity release exists upstream, this is the master; if one does, this is a satellite of it.`;
			}
			if (hints.includes("quant")) return "The weight bytes are mostly GGUF — a published quant.";
			if (dt) return `Dominant dtype \`${dt}\` — full fidelity. Not a quant; derive one at run time if you need it smaller.`;
			return null;
		}
		case "gated":
			if (row.gated === true) return "Gated. Accept the terms on the model page — the row's link — then `hf auth login` once.";
			return "Not gated: anonymous fetches work.";
		case "subset": {
			if (row.include && row.include.length) {
				return `Pinned as a subset: ${row.include.map((g) => `\`${g}\``).join(", ")} plus the sidecars${bytes !== null ? ". The size shown is the whole repo before `--include`" : ""}.`;
			}
			return "Listed whole. Add include globs on the row only if you want part of the repo — a pack repo, or one satellite quant.";
		}
		case "pin":
			if (row.revision) return `Pinned to \`${shownRevision(row.revision)}\`: every collector who adopts this catalog freezes the same bytes.`;
			return "Unpinned: the first `archive` resolves `main` to a commit and freezes it. Add a revision on the row to match a paper or a friend.";
		case "bundle": {
			const dir = bundleName(row.source);
			if (!dir) return null;
			return `Lands as \`~/darsay/${dir}/${revision12(row.revision)}/\` — \`${row.artifact_type === "dataset" ? "data" : "model"}/\` frozen, \`manifest.json\` beside it.`;
		}
		case "moe": {
			const moe = moeFromName(row.source);
			if (!moe) return null;
			if (moe.total !== null && moe.active !== null) {
				return `${moe.total}B total — ${bytes !== null ? `all **${humanSize(bytes)}** come home` : "all of it comes home"}. ${moe.active}B active — once loaded it runs like a ${moe.active}B dense model.`;
			}
			return "Names itself a mixture of experts; the whole set of experts is the archive.";
		}
		case "abliterated":
			return "Read from the name. Keep it beside its base — two masters of one lineage.";
		case "base":
			return "Read from the name. The seed of a lineage; pair it with the post-trained release you use.";
		case "spec":
			return "Read from the name. Only useful beside the exact target it was made for — add that row too, at the same desire.";
		case "dataset":
			if (row.artifact_type === "dataset") return `A dataset row: payload lands under \`data/\`${bytes !== null ? `, **${humanSize(bytes)}**` : ""}. No engine — open the files.`;
			return "A model row. Datasets are addressed as `datasets/owner/name`.";
		case "desire": {
			const d = row.desire
				? `Desire **${row.desire}**`
				: "No desire yet — unrated rows sort last, and `--next` reaches them only when nothing rated is left";
			const have = row.status === "have" ? `marked **have**${row.holders ? ` by ${row.holders}` : ""}` : "still **want**";
			return `${d}; ${have}.`;
		}
		case "claims": {
			const c = row.claim;
			if (!c || c.state === "done") return "No client has claimed this row. `darsay archive --next <board-url>` would claim it before the first byte moves.";
			const pct = c.percent === null ? "" : ` at ${c.percent}%`;
			return `Claimed by \`${c.client}\`, ${c.state === "paused" ? "paused" : "fetching"}${pct}. Other collectors' \`--next\` skips it while the claim is live.`;
		}
		case "formats":
			if (row.dominant_dtype) return `The Hub reported a safetensors header for this row — dominant dtype \`${row.dominant_dtype}\`.`;
			return null;
		default:
			return null;
	}
}
