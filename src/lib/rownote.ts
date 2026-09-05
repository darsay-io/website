/**
 * "On this row": a field-guide card applied to the entry it was opened from.
 * Pure text (inline markup: `code`, **strong**) from the row's own fields —
 * the same arithmetic the CLI does, shown for the thing the reader clicked.
 */
import { DTYPE_WIDTHS, LARGE_PAYLOAD_BYTES, REDUNDANT_FACTOR } from "../worker/hints.ts";
import { describeBytesPerParam, humanBytesPerParam } from "../worker/precision.ts";
import { isClosed, moeFromName } from "./lenses.ts";
import { displayGeneration, lineageOf, publisherOf } from "./lineage.ts";
import type { PrimerKey } from "./primer.ts";
import { BUDGET_GB, bundleName, halfBudgetGb, humanParams, humanSize, revision12 } from "./recipes.ts";
import { scopedSize, sizeExplanation, type SizeFacts } from "./size.ts";

export type RowFacts = SizeFacts & {
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
	precision?: string | null;
	bytes_per_param?: number | null;
	parents?: Array<{ source: string; relation: string | null }> | null;
	closed?: boolean | null;
	holders?: string;
	claim?: { client: string; state: "archiving" | "paused" | "done"; percent: number | null } | null;
};

const GiB = 1024 ** 3;
/** The cookbook's "cap the bandwidth" example rate. */
const LINK_MIB_S = 25;

function ratioBand(ratio: number): string {
	if (ratio >= REDUNDANT_FACTOR) return "well over one copy — inspect the extra weight sets and their roles";
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
	if (isClosed(row)) return "A closed work: no weights to weigh yet.";
	if ((row.gguf_variants?.length ?? 0) > 1 && row.size_basis !== "selection" && typeof row.bytes_per_param !== "number") {
		return `${row.parameters ? `\`${humanParams(row.parameters)}\` parameters; ` : ""}${row.gguf_variants!.length} GGUF variants in the repository. The row shows **${scopedSize(row)}**. Open the variant list for each precision and size; dividing combined bytes across alternatives by parameters does not describe one model's precision.`;
	}
	// The CLI's measured figure wins when the digest carries it.
	if (row.precision && typeof row.bytes_per_param === "number" && row.parameters) {
		const desc = describeBytesPerParam(row.bytes_per_param);
		const size = row.payload_bytes === null ? "" : ` — **${scopedSize(row)}** on the row`;
		return `\`${humanParams(row.parameters)}\` at \`${row.precision}\`, **${humanBytesPerParam(row.bytes_per_param)}** measured: ${desc}${size}.`;
	}
	const one = oneCopyBytes(row);
	if (one === null || !row.parameters || !row.dominant_dtype) return row.precision ? `Release precision \`${row.precision}\`; **${scopedSize(row)}**. Parameter metadata is not available for a per-parameter comparison.` : null;
	const width = DTYPE_WIDTHS[row.dominant_dtype.toUpperCase()];
	const lead = `\`${humanParams(row.parameters)}\` × ${width} ${width === 1 ? "byte" : "bytes"} (\`${row.dominant_dtype}\`) ≈ **${humanSize(one)}** for one copy.`;
	if (row.payload_bytes === null) return `${lead} The row has no size yet.`;
	const ratio = row.payload_bytes / one;
	return `${lead} The row shows **${scopedSize(row)}** — ${ratio.toFixed(ratio >= 10 ? 0 : 1)}×, ${ratioBand(ratio)}.`;
}

function familyNote(row: RowFacts): string {
	const lin = lineageOf(row.source);
	if (!lin.family) return "The name carries no family darsay can read — it stays out of the tree.";
	const head = displayGeneration(lin.family, lin.generation);
	const bits = [
		lin.member ? `member \`${lin.member}\`` : "the flagship",
		...lin.variants.map((v) => `variant *${v}*`),
		...lin.formats.map((f) => `format *${f}*`),
	];
	const publisher = publisherOf(row.source);
	const parents = row.parents ?? [];
	const edge = parents.length
		? ` Upstream declares it a **${parents[0].relation ?? "derivative"}** of \`${parents[0].source}\`. This identifies lineage; it does not establish how to recover the published bytes.`
		: "";
	return `**${head}**, ${bits.join(", ")} — read from the name${publisher ? `, published by ${publisher}` : ""}.${edge}`;
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
			if (row.size_basis === "repository" && (row.gguf_variants?.length ?? 0) > 1) return `**${scopedSize(row)}** includes ${row.gguf_variants!.length} alternative GGUF variants. Choose a variant or classify the archive before planning disk space and transfer time.`;
			if (bytes < LARGE_PAYLOAD_BYTES) return `**${scopedSize(row)}** is under the 20 GiB line${row.unknown_size_count ? "; unknown file sizes can raise the total" : ": one sitting"}.`;
			const evenings = Math.ceil(bytes / GiB / BUDGET_GB);
			return `**${scopedSize(row)}**: ${row.unknown_size_count ? "at least " : ""}${evenings} evenings at \`--max-gb ${BUDGET_GB}\`, or about ${hoursAtLink(bytes)} of link time at ${LINK_MIB_S} MiB/s. In halves, ${halfBudgetGb(bytes)} GiB to each disk.`;
		}
		case "archive": {
			if (isClosed(row)) return "A closed work has no bytes to classify.";
			const c = row.classification;
			const unknownFiles = c?.verdicts.unknown?.files;
			const retained = c ? ` ${c.unclassified_count} unresolved weight set${c.unclassified_count === 1 ? "" : "s"}${typeof unknownFiles === "number" ? ` (${unknownFiles} file${unknownFiles === 1 ? "" : "s"})` : ""} retained; ${humanSize(c.skipped_bytes)} safely omitted.` : " Run `darsay estimate <board-url>` to record the classified archive estimate.";
			return `**${scopedSize(row)}**. ${sizeExplanation(row)}${retained}`;
		}
		case "family":
			return familyNote(row);
		case "closed":
			if (isClosed(row)) return `A home page, not a source: nothing to fetch, no price. It holds the **${displayGeneration(lineageOf(row.source).family, lineageOf(row.source).generation)}** place until weights ship.`;
			return "An open work: a source darsay can fetch.";
		case "quant": {
			const dt = row.dominant_dtype;
			if (hints.includes("quant") && dt) {
				return `Dominant dtype \`${dt}\`; the quant chip describes the published encoding. Check the publisher, source revision, and recovery evidence before deciding what to collect. A lower bit count does not make the artifact disposable.`;
			}
			if (hints.includes("quant")) return "The inventory contains a GGUF encoding. Check its precision and declared parent separately; a file format or importance-matrix marker does not prove recovery of its exact bytes.";
			if (dt) return `Dominant dtype \`${dt}\` describes storage, not original training provenance. A smaller published encoding is a separate collection choice; this row keeps its current scope.`;
			return null;
		}
		case "gated":
			if (row.gated === true) return "Gated. Accept the terms on the model page — the row's link — then `hf auth login` once.";
			return "Not gated: anonymous fetches work.";
		case "subset": {
			if (row.include && row.include.length) {
				return `Selected scope: ${row.include.map((g) => `\`${g}\``).join(", ")} plus matching support files. ${row.size_basis === "selection" ? `**${scopedSize(row)}** measures those selected files.` : "The selection has not been priced; refresh the row or run `darsay estimate` with its include patterns."} Other weight variants and optional projectors are outside this selection unless explicitly included; that scope choice is not a recovery verdict.`;
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
				return `${moe.total}B total parameters, ${moe.active}B active per token. ${bytes !== null ? `The row shows **${scopedSize(row)}**; disk usage depends on the selected weight sets and their precision.` : "All experts must be available even though each token uses only some."}`;
			}
			return "Names itself a mixture of experts; the whole set of experts is the archive.";
		}
		case "abliterated":
			return "Read from the name. This labels a claimed weight edit; it does not prove the edit is irreversible or that its recipe is unavailable. Preserve the published artifact if it fits your collection, and record its base and recovery evidence separately.";
		case "base":
			return "Read from the name. The seed of a lineage; pair it with the post-trained release you use.";
		case "spec":
			return "Read from the name. Only useful beside the exact target it was made for — add that row too, at the same desire.";
		case "dataset":
			if (row.artifact_type === "dataset") return `A dataset row: payload lands under \`data/\`${bytes !== null ? `, **${scopedSize(row)}**` : ""}. No engine — open the files.`;
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
		case "training":
			return trainingNote(row);
		case "posttrain":
			return postTrainNote(row);
		case "finetune":
			return fineTuneNote(row);
		case "memory":
			return memoryNote(row);
		case "runtime":
			return runtimeNote(row);
		case "convert":
			return convertNote(row);
		case "workbench":
			return workbenchNote(row);
		default:
			return null;
	}
}

/* ── The workbench cards, applied to a row ──────────────────────────────── */

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** 1.2 × 10²⁵: scientific notation the way a card writes it. */
function sci(n: number): string {
	if (!(n > 0)) return "0";
	const exp = Math.floor(Math.log10(n));
	const mant = n / 10 ** exp;
	const sup = String(exp).split("").map((d) => SUPERSCRIPT[Number(d)]).join("");
	return `${mant.toFixed(1)} × 10${sup}`;
}

/** 160B, 15T: a token count the way a card says it. */
function humanTokens(n: number): string {
	if (n >= 1e12) return `${(n / 1e12).toFixed(n < 1e13 ? 1 : 0)}T`;
	return `${Math.round(n / 1e9)}B`;
}

/** The single weight set this row prices, in bytes, or null when it prices a whole multi-variant repository. */
function weightBytes(row: RowFacts): number | null {
	if (typeof row.bytes_per_param === "number" && row.parameters) return row.parameters * row.bytes_per_param;
	if (row.payload_bytes !== null && row.size_basis && row.size_basis !== "repository") return row.payload_bytes;
	if (row.payload_bytes !== null && (row.gguf_variants?.length ?? 0) <= 1) return row.payload_bytes;
	return null;
}

function trainingNote(row: RowFacts): string | null {
	if (isClosed(row)) return "A closed work: whatever made it, the weights are not published.";
	if (row.artifact_type === "dataset") return "A dataset is the other half of a run: the tokens, not the weights. Six FLOPs per parameter per token of it.";
	const p = row.parameters;
	if (!p) return "No parameter count on record — `darsay estimate` reads it from the headers, and then this card can price the run.";
	const tokens = 20 * p;
	const flops = 6 * p * tokens;
	const hours = flops / (989e12 * 0.4 * 3600);
	const days = hours / 1024 / 24;
	return `**${humanParams(p)}** parameters trained Chinchilla-style on ${humanTokens(tokens)} tokens is about 6 × ${humanParams(p)} × ${humanTokens(tokens)} = ${sci(flops)} FLOPs: ${Math.round(hours).toLocaleString()} H100-hours at 40% utilization, ${days < 1 ? "under a day" : `${days.toFixed(1)} days`} on 1,024 of them. Open releases train far longer than that. The optimizer states alone would be ${humanSize(16 * p)}.`;
}

function postTrainNote(row: RowFacts): string | null {
	if (isClosed(row)) return null;
	if (row.artifact_type === "dataset") return "A dataset row. If it is conversations, it is post-training data; if it is prompts with answers, it is what a verifiable reward checks.";
	const variants = lineageOf(row.source).variants;
	const parts: string[] = [];
	if (variants.includes("base")) parts.push("**base** — the pretrained predictor; it completes text and does not answer");
	if (variants.includes("instruct") || variants.includes("chat")) parts.push("**instruct** — SFT and preference-tuned to hold a conversation");
	if (variants.includes("thinking")) parts.push("**thinking** — trained with verifiable rewards to reason in text before answering; budget context for the trace");
	if (variants.includes("distill")) parts.push("**distill** — trained on a larger teacher's answers; two parents");
	if (variants.includes("abliterated") || variants.includes("uncensored")) parts.push("**edited** — a refusal direction removed after training; bytes that depend on the prompts and machine used");
	if (!parts.length) return "Read from the name: it says neither base nor instruct. The card and the chat template say which stage this is; `generation_config.json` carries the sampling the publisher tuned for.";
	return `Read from the name: ${parts.join("; ")}. A claim by the publisher, usually true; the chat template in the files is what the runtime believes.`;
}

function fineTuneNote(row: RowFacts): string | null {
	if (isClosed(row)) return null;
	if (row.artifact_type === "dataset") return "A dataset row: fine-tuning data is one JSON object per line in the model's chat format. Hold a tenth out before you start.";
	const p = row.parameters;
	if (!p) return "No parameter count on record yet, so no adapter arithmetic — `darsay estimate` reads it from the headers.";
	return `**${humanParams(p)}** parameters: a LoRA on the BF16 base needs about ${humanSize(2 * p)} for the frozen weights plus a gigabyte or two for the adapter and its states; QLoRA at four bits, about ${humanSize(0.58 * p)} plus the same; a full fine-tune, ${humanSize(16 * p)} before activations. Activations are the knob when it does not fit.`;
}

function memoryNote(row: RowFacts): string | null {
	if (isClosed(row)) return "A closed work: nothing to load.";
	if (row.artifact_type === "dataset") return "A dataset does not load into memory as a model does; readers stream its rows.";
	const w = weightBytes(row);
	if (w === null) {
		if (row.payload_bytes !== null && (row.gguf_variants?.length ?? 0) > 1) return `**${scopedSize(row)}** prices ${row.gguf_variants!.length} alternative variants together. Choose one — Add variant on the recipe card — and this note sizes it.`;
		return "No weight set is priced on this row yet — `darsay estimate` sizes it, and then this note says what it needs.";
	}
	const moe = moeFromName(row.source);
	const activeFrac = moe && moe.total !== null && moe.active !== null ? moe.active / moe.total : 1;
	const read = w * activeFrac;
	const tps = (gbps: number) => {
		const v = (gbps * 1e9) / read;
		return v < 1 ? "under 1" : String(Math.round(v));
	};
	const dense = activeFrac === 1;
	return `**${humanSize(w)}** of weights, so about ${humanSize(w * 1.1)} with the runtime, before the KV cache for your context. One stream reads ${dense ? "all of it " : `only the active experts, about ${humanSize(read)}, `}per token: near ${tps(546)} tokens/s on an Apple Max-class machine, ${tps(1008)} on an RTX 4090, ${tps(90)} on a desktop with two channels of DDR5.${dense ? " A mixture of experts whose name does not say so reads only its active experts, and runs faster than this." : ""}`;
}

function runtimeNote(row: RowFacts): string | null {
	if (isClosed(row)) return "A closed work: an API, not a runtime.";
	if (row.artifact_type === "dataset") return "A dataset matches no engine: `darsay run` has nothing to run, and any Parquet or JSON Lines reader opens the files under `data/`.";
	const n = row.gguf_variants?.length ?? 0;
	const gguf = n > 0 || /gguf/i.test(row.source);
	if (gguf) {
		return `GGUF: llama.cpp, Ollama, or LM Studio on any hardware. \`darsay run\` picks the llama-cpp engine${n > 1 ? ` and, with ${n} variants here, needs \`--weights\` to say which` : ""}.`;
	}
	const dt = row.dominant_dtype ?? "";
	if (/F8|FP8|E4M3/i.test(dt) || /-(AWQ|GPTQ|FP8|NVFP4|MXFP4)$/i.test(row.source)) return "A quantized safetensors release: vLLM or SGLang read it as published. `darsay run` uses transformers; llama.cpp needs a GGUF conversion first.";
	return `Safetensors: transformers for correctness, vLLM or SGLang to serve, MLX on a Mac, or convert to GGUF for llama.cpp. \`darsay run\` uses transformers${/mlx/i.test(row.source) ? "" : ", or \`--engine mlx\` on Apple silicon"}.`;
}

function convertNote(row: RowFacts): string | null {
	if (isClosed(row)) return null;
	if (row.artifact_type === "dataset") return "Datasets convert between Parquet, JSON Lines, and Arrow losslessly; the tokenizer that reads them belongs to the model.";
	const c = row.classification;
	const n = row.gguf_variants?.length ?? 0;
	const variants = n > 1 ? `${n} GGUF variants are published here, each a distinct artifact of one toolchain run. ` : "";
	if (!c) return `${variants}Not classified yet — \`darsay estimate <board-url>\` records each weight set's verdict and the evidence it rests on.`;
	const neg = c.verdicts.negative?.sets ?? 0;
	const prints = c.verdicts.print?.sets ?? 0;
	const unknown = c.verdicts.unknown?.sets ?? 0;
	return `${variants}Classified: ${neg} negative set${neg === 1 ? "" : "s"}, ${unknown} unknown, ${prints} print${prints === 1 ? "" : "s"}; ${c.skipped_bytes ? `${humanSize(c.skipped_bytes)} proven duplicate and omitted` : "nothing proven duplicate, nothing skipped"}. A print is a hash match, never a conversion that could be redone.`;
}

function workbenchNote(row: RowFacts): string | null {
	if (isClosed(row)) return "A closed work has no bundle to hydrate.";
	const dir = bundleName(row.source);
	if (!dir) return null;
	if (row.artifact_type === "dataset") return `Lands as \`~/darsay/${dir}/${revision12(row.revision)}/data/\`; no engine to hydrate — open the files with any reader, and write anything you make elsewhere.`;
	return `\`darsay hydrate ${dir}\` builds an environment under the vault's \`.runtime/\` and leaves \`~/darsay/${dir}/${revision12(row.revision)}/model/\` to be read in place; point a converter or trainer at that directory and write the output beside a recipe that names this pin.`;
}
