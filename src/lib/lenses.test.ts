import { describe, expect, it } from "vitest";
import {
	LENSES,
	applyLenses,
	effectiveHints,
	formatView,
	isAbliterated,
	isBaseModel,
	isSpeculator,
	lensCounts,
	lensCountsGiven,
	lensesFor,
	moeFromName,
	parseView,
	repoName,
	tally,
	type LensEntry,
} from "./lenses.ts";

const GiB = 1024 ** 3;

function row(over: Partial<LensEntry> = {}): LensEntry {
	return {
		source: "huggingface:Qwen/Qwen3-0.6B",
		status: "want",
		payload_bytes: 1 * GiB,
		include: null,
		artifact_type: "model",
		gated: false,
		dominant_dtype: "BF16",
		hints: [],
		policy: null,
		claim: null,
		...over,
	};
}

describe("names", () => {
	it("reads the repo name after owner and datasets/", () => {
		expect(repoName("huggingface:Uniboshi/Kimi-K3-Abliterated-V1")).toBe("Kimi-K3-Abliterated-V1");
		expect(repoName("huggingface:datasets/saidutta69/fable-5-premium")).toBe("fable-5-premium");
		expect(repoName("test:acme/toy")).toBe("test:acme/toy");
	});
	it("spots abliterated and obliterated repos, not owners, not uncensored fine-tunes", () => {
		expect(isAbliterated("huggingface:Uniboshi/Kimi-K3-Abliterated-V1")).toBe(true);
		expect(isAbliterated("huggingface:OBLITERATUS/Qwen3.8-27B-OBLITERATED")).toBe(true);
		expect(isAbliterated("huggingface:mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated")).toBe(true);
		expect(isAbliterated("huggingface:p-e-w/gemma-3-27b-it-heretic")).toBe(true);
		expect(isAbliterated("huggingface:cognitivecomputations/dolphin-2.9-llama3-8b-uncensored")).toBe(false);
		expect(isAbliterated("huggingface:OBLITERATUS/Qwen3.8-27B")).toBe(false);
		expect(isAbliterated("huggingface:Qwen/Qwen3.8-27B")).toBe(false);
	});
	it("spots pretrained bases, never size tiers or datasets", () => {
		for (const yes of [
			"huggingface:moonshotai/Kimi-K2-Base",
			"huggingface:Qwen/Qwen3-8B-Base",
			"huggingface:deepseek-ai/DeepSeek-V3-Base",
			"huggingface:unsloth/Qwen3-8B-Base-GGUF",
			"huggingface:google/gemma-3-27b-pt",
			"huggingface:acme/qwen3-8b-base",
		]) {
			expect(isBaseModel(yes), yes).toBe(true);
		}
		for (const no of [
			"huggingface:Qwen/Qwen3.8-27B",
			"huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct",
			"huggingface:google-bert/bert-base-uncased",
			"huggingface:FacebookAI/roberta-base",
			"huggingface:openai/whisper-base",
			"huggingface:BAAI/bge-base-en-v1.5",
			"huggingface:intfloat/e5-base-v2",
			"huggingface:google-t5/t5-base",
			"huggingface:stabilityai/stable-diffusion-xl-base-1.0",
			"huggingface:datasets/acme/base-corpus",
			"huggingface:datasets/acme/Corpus-Base",
		]) {
			expect(isBaseModel(no), no).toBe(false);
		}
	});
	it("reads total/active from a MoE name", () => {
		expect(moeFromName("huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct")).toEqual({ total: 480, active: 35 });
		expect(moeFromName("huggingface:Qwen/Qwen3.5-397B-A17B")).toEqual({ total: 397, active: 17 });
		expect(moeFromName("huggingface:mistralai/Mixtral-8x7B-v0.1")).toEqual({ total: null, active: null });
		expect(moeFromName("huggingface:zai-org/GLM-4.5V")).toBeNull();
	});
	it("spots speculators by name; EAGLE only beside a target; never RWKV or NVIDIA's Eagle VLMs", () => {
		for (const yes of [
			"huggingface:RedHatAI/Qwen3-32B-speculator.eagle3",
			"huggingface:yuhuili/EAGLE3-LLaMA3.1-Instruct-8B",
			"huggingface:yuhuili/EAGLE-Vicuna-7B-v1.3",
			"huggingface:FasterDecoding/medusa-vicuna-7b-v1.3",
			"huggingface:acme/Qwen3-0.6B-draft",
		]) {
			expect(isSpeculator(yes), yes).toBe(true);
		}
		for (const no of [
			"huggingface:nvidia/Eagle2-9B",
			"huggingface:NVEagle/Eagle-X5-7B",
			"huggingface:RWKV/v5-Eagle-7B-HF",
			"huggingface:Qwen/Qwen3.8-27B",
			"huggingface:acme/Qwen3-235B-MTP",
			"huggingface:acme/draftsman-7b",
			"huggingface:datasets/acme/draft-corpus",
		]) {
			expect(isSpeculator(no), no).toBe(false);
		}
	});
});

describe("effectiveHints", () => {
	it("keeps stored hints and derives what the catalog docs sanction", () => {
		expect(effectiveHints(row({ hints: ["redundant"], payload_bytes: 642 * GiB, dominant_dtype: "F8_E4M3" }))).toEqual([
			"large",
			"quant",
			"redundant",
		]);
		expect(effectiveHints(row({ gated: true, include: ["*.gguf"] }))).toEqual(["gated", "subset"]);
		expect(effectiveHints(row({ hints: ["bogus" as never] }))).toEqual([]);
	});
});

describe("lenses", () => {
	const rows = [
		row({ source: "huggingface:MiniMaxAI/MiniMax-H3", payload_bytes: 330 * GiB, hints: ["large", "redundant"], policy: "negatives", claim: { state: "archiving" } }),
		row({ source: "huggingface:zai-org/GLM-5.3", payload_bytes: 704 * GiB, dominant_dtype: "F8_E4M3", status: "have" }),
		row({ source: "huggingface:Uniboshi/Kimi-K3-Abliterated-V1", payload_bytes: 1454 * GiB, gated: true, dominant_dtype: "U8" }),
		row({ source: "huggingface:Qwen/Qwen3-8B-Base", payload_bytes: 15 * GiB }),
		row({ source: "huggingface:Qwen/Qwen3.5-397B-A17B", payload_bytes: 751 * GiB }),
		row({ source: "huggingface:datasets/saidutta69/fable-5-premium", artifact_type: "dataset", payload_bytes: 2 * GiB }),
		row({ source: "huggingface:biohub/esm3-sm-open-v1", payload_bytes: null, dominant_dtype: null }),
		row({ source: "https://www.qwencloud.com/models/qwen3.8-max-0902", payload_bytes: null, dominant_dtype: null, closed: true }),
	];
	it("reads each row through every lens it passes", () => {
		expect([...lensesFor(rows[0])].sort()).toEqual(["claimed", "large", "negatives", "redundant", "want"]);
		expect([...lensesFor(rows[1])].sort()).toEqual(["have", "large", "quant"]);
		expect([...lensesFor(rows[2])].sort()).toEqual(["abliterated", "gated", "large", "quant", "want"]);
		expect([...lensesFor(rows[3])].sort()).toEqual(["base", "want"]);
		expect([...lensesFor(rows[4])].sort()).toEqual(["large", "moe", "want"]);
		expect([...lensesFor(rows[5])].sort()).toEqual(["dataset", "want"]);
		expect([...lensesFor(rows[6])].sort()).toEqual(["unpriced", "want"]);
		// A closed work is closed, not unpriced: there is nothing to price.
		expect([...lensesFor(rows[7])].sort()).toEqual(["closed", "want"]);
	});
	it("narrows to a family read from the names", () => {
		expect(applyLenses(rows, [], "qwen").map((r) => r.source)).toEqual([
			"huggingface:Qwen/Qwen3-8B-Base",
			"huggingface:Qwen/Qwen3.5-397B-A17B",
			"https://www.qwencloud.com/models/qwen3.8-max-0902",
		]);
		expect(applyLenses(rows, ["want"], "kimi").map((r) => r.source)).toEqual(["huggingface:Uniboshi/Kimi-K3-Abliterated-V1"]);
	});
	it("ANDs active lenses and counts per lens", () => {
		expect(applyLenses(rows, []).length).toBe(8);
		expect(applyLenses(rows, ["large"]).length).toBe(4);
		expect(applyLenses(rows, ["large", "want"]).length).toBe(3);
		expect(applyLenses(rows, ["abliterated", "gated"]).map((r) => r.source)).toEqual([
			"huggingface:Uniboshi/Kimi-K3-Abliterated-V1",
		]);
		const counts = lensCounts(rows);
		expect(counts.get("want")).toBe(7);
		expect(counts.get("closed")).toBe(1);
		expect(counts.get("have")).toBe(1);
		expect(counts.get("spec")).toBe(0);
		expect(counts.get("unpriced")).toBe(1);
	});
	it("counts a chip against the other active lenses, never promising rows the AND drops", () => {
		const given = lensCountsGiven(rows, ["gated"]);
		expect(given.get("gated")).toBe(1); // its own count ignores itself
		expect(given.get("dataset")).toBe(0); // no gated dataset
		expect(given.get("abliterated")).toBe(1);
		expect(given.get("want")).toBe(1);
		expect(lensCountsGiven(rows, []).get("large")).toBe(4);
		expect(lensCountsGiven(rows, []).get("closed")).toBe(1);
	});
	it("tallies bytes by status and counts the unsized", () => {
		const t = tally(rows);
		expect(t.n).toBe(8);
		expect(t.unsized).toBe(1); // the closed row is not "unsized" — it has no size to have
		expect(t.haveBytes).toBe(704 * GiB);
		expect(t.wantBytes).toBe((330 + 1454 + 15 + 751 + 2) * GiB);
		expect(t.bytes).toBe(t.haveBytes + t.wantBytes);
	});
	it("every lens names a primer card, a noun, and a blurb", () => {
		for (const l of LENSES) {
			expect(l.primer.length).toBeGreaterThan(0);
			expect(l.noun.length).toBeGreaterThan(0);
			expect(l.blurb.length).toBeGreaterThan(20);
			if (l.fromName) expect(l.blurb).toMatch(/repo name/);
		}
	});
});

describe("view state in the hash", () => {
	const defaults = { sort: "desire" as const, dir: "desc" as const };
	it("round-trips lenses and a non-default sort, ignoring junk", () => {
		expect(parseView("#lens=abliterated,large,bogus&sort=size:asc")).toEqual({
			lenses: ["abliterated", "large"],
			sort: "size",
			dir: "asc",
			family: null,
			view: null,
			row: null,
		});
		expect(parseView("")).toEqual({ lenses: [], sort: null, dir: null, family: null, view: null, row: null });
		expect(parseView("#sort=nope:asc")).toEqual({ lenses: [], sort: null, dir: null, family: null, view: null, row: null });
		expect(parseView("#view=lineage&family=qwen")).toMatchObject({ view: "lineage", family: "qwen" });
		expect(parseView("#view=nope&family=Not%20A%20Key")).toMatchObject({ view: null, family: null });
		expect(formatView({ lenses: [], sort: "desire", dir: "desc", family: "kimi", view: "lineage", row: null }, defaults)).toBe(
			"#view=lineage&family=kimi",
		);
		const bare = { family: null, view: null, row: null } as const;
		expect(formatView({ lenses: ["gated"], sort: "desire", dir: "desc", ...bare }, defaults)).toBe("#lens=gated");
		expect(formatView({ lenses: [], sort: "size", dir: "desc", ...bare }, defaults)).toBe("#sort=size:desc");
		expect(formatView({ lenses: ["moe", "large"], sort: "size", dir: "asc", ...bare }, defaults)).toBe(
			"#lens=moe,large&sort=size:asc",
		);
		expect(formatView({ lenses: [], sort: "desire", dir: "desc", ...bare }, defaults)).toBe("");
	});

	it("carries a row target, slashes and all", () => {
		expect(parseView("#row=orcarouter/DeepSeek-V4-Flash-Vision-Uncensored")).toMatchObject({
			row: "orcarouter/DeepSeek-V4-Flash-Vision-Uncensored",
		});
		expect(parseView("#lens=gated&row=42")).toMatchObject({ lenses: ["gated"], row: "42" });
		expect(parseView("#row=")).toMatchObject({ row: null });
		expect(parseView("#row=%20%20")).toMatchObject({ row: null });
		expect(parseView(`#row=${"x".repeat(600)}`)).toMatchObject({ row: null });
		expect(parseView("#row=https://example.com/a%3Fb%3D1%26c%3D2")).toMatchObject({ row: "https://example.com/a?b=1&c=2" });
		const bare = { lenses: [], sort: "desire" as const, dir: "desc" as const, family: null, view: null };
		expect(formatView({ ...bare, row: "datasets/ESCAD/OpenRTLSet" }, defaults)).toBe("#row=datasets/ESCAD/OpenRTLSet");
		expect(formatView({ ...bare, lenses: ["gated"], row: "42" }, defaults)).toBe("#lens=gated&row=42");
		expect(formatView({ ...bare, row: "https://example.com/a?b=1&c=2" }, defaults)).toBe(
			"#row=https://example.com/a%3Fb%3D1%26c%3D2",
		);
		// What a link says is what the page reads back.
		const link = formatView({ ...bare, row: "https://example.com/a?b=1&c=2" }, defaults);
		expect(parseView(link).row).toBe("https://example.com/a?b=1&c=2");
	});
});
