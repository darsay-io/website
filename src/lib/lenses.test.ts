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
	it("spots abliterated and obliterated repos, not owners", () => {
		expect(isAbliterated("huggingface:Uniboshi/Kimi-K3-Abliterated-V1")).toBe(true);
		expect(isAbliterated("huggingface:OBLITERATUS/Qwen3.8-27B-OBLITERATED")).toBe(true);
		expect(isAbliterated("huggingface:mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated")).toBe(true);
		expect(isAbliterated("huggingface:p-e-w/gemma-3-27b-it-heretic")).toBe(true);
		expect(isAbliterated("huggingface:OBLITERATUS/Qwen3.8-27B")).toBe(false);
		expect(isAbliterated("huggingface:Qwen/Qwen3.8-27B")).toBe(false);
	});
	it("spots base models by suffix, never datasets", () => {
		expect(isBaseModel("huggingface:moonshotai/Kimi-K2-Base")).toBe(true);
		expect(isBaseModel("huggingface:Qwen/Qwen3-8B-Base")).toBe(true);
		expect(isBaseModel("huggingface:google/gemma-3-27b-pt")).toBe(true);
		expect(isBaseModel("huggingface:Qwen/Qwen3.8-27B")).toBe(false);
		expect(isBaseModel("huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct")).toBe(false);
		expect(isBaseModel("huggingface:datasets/acme/base-corpus")).toBe(false);
	});
	it("reads total/active from a MoE name", () => {
		expect(moeFromName("huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct")).toEqual({ total: 480, active: 35 });
		expect(moeFromName("huggingface:Qwen/Qwen3.5-397B-A17B")).toEqual({ total: 397, active: 17 });
		expect(moeFromName("huggingface:mistralai/Mixtral-8x7B-v0.1")).toEqual({ total: null, active: null });
		expect(moeFromName("huggingface:zai-org/GLM-4.5V")).toBeNull();
	});
	it("spots speculators by name, excluding RWKV's Eagle", () => {
		expect(isSpeculator("huggingface:RedHatAI/Qwen3-32B-speculator.eagle3")).toBe(true);
		expect(isSpeculator("huggingface:yuhuili/EAGLE3-LLaMA3.1-Instruct-8B")).toBe(true);
		expect(isSpeculator("huggingface:FasterDecoding/medusa-vicuna-7b-v1.3")).toBe(true);
		expect(isSpeculator("huggingface:acme/Qwen3-235B-MTP")).toBe(true);
		expect(isSpeculator("huggingface:RWKV/v5-Eagle-7B-HF")).toBe(false);
		expect(isSpeculator("huggingface:Qwen/Qwen3.8-27B")).toBe(false);
		expect(isSpeculator("huggingface:datasets/acme/draft-corpus")).toBe(false);
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
		row({ source: "huggingface:MiniMaxAI/MiniMax-H3", payload_bytes: 330 * GiB, hints: ["large", "redundant"], policy: "masters", claim: { state: "archiving" } }),
		row({ source: "huggingface:zai-org/GLM-5.3", payload_bytes: 704 * GiB, dominant_dtype: "F8_E4M3", status: "have" }),
		row({ source: "huggingface:Uniboshi/Kimi-K3-Abliterated-V1", payload_bytes: 1454 * GiB, gated: true, dominant_dtype: "U8" }),
		row({ source: "huggingface:Qwen/Qwen3-8B-Base", payload_bytes: 15 * GiB }),
		row({ source: "huggingface:Qwen/Qwen3.5-397B-A17B", payload_bytes: 751 * GiB }),
		row({ source: "huggingface:datasets/saidutta69/fable-5-premium", artifact_type: "dataset", payload_bytes: 2 * GiB }),
		row({ source: "huggingface:biohub/esm3-sm-open-v1", payload_bytes: null, dominant_dtype: null }),
	];
	it("reads each row through every lens it passes", () => {
		expect([...lensesFor(rows[0])].sort()).toEqual(["claimed", "large", "masters", "redundant", "want"]);
		expect([...lensesFor(rows[1])].sort()).toEqual(["have", "large", "quant"]);
		expect([...lensesFor(rows[2])].sort()).toEqual(["abliterated", "gated", "large", "quant", "want"]);
		expect([...lensesFor(rows[3])].sort()).toEqual(["base", "want"]);
		expect([...lensesFor(rows[4])].sort()).toEqual(["large", "moe", "want"]);
		expect([...lensesFor(rows[5])].sort()).toEqual(["dataset", "want"]);
		expect([...lensesFor(rows[6])].sort()).toEqual(["unpriced", "want"]);
	});
	it("ANDs active lenses and counts per lens", () => {
		expect(applyLenses(rows, []).length).toBe(7);
		expect(applyLenses(rows, ["large"]).length).toBe(4);
		expect(applyLenses(rows, ["large", "want"]).length).toBe(3);
		expect(applyLenses(rows, ["abliterated", "gated"]).map((r) => r.source)).toEqual([
			"huggingface:Uniboshi/Kimi-K3-Abliterated-V1",
		]);
		const counts = lensCounts(rows);
		expect(counts.get("want")).toBe(6);
		expect(counts.get("have")).toBe(1);
		expect(counts.get("spec")).toBe(0);
		expect(counts.get("unpriced")).toBe(1);
	});
	it("tallies bytes by status and counts the unsized", () => {
		const t = tally(rows);
		expect(t.n).toBe(7);
		expect(t.unsized).toBe(1);
		expect(t.haveBytes).toBe(704 * GiB);
		expect(t.wantBytes).toBe((330 + 1454 + 15 + 751 + 2) * GiB);
		expect(t.bytes).toBe(t.haveBytes + t.wantBytes);
	});
	it("every lens names a primer card and a blurb", () => {
		for (const l of LENSES) {
			expect(l.primer.length).toBeGreaterThan(0);
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
		});
		expect(parseView("")).toEqual({ lenses: [], sort: null, dir: null });
		expect(parseView("#sort=nope:asc")).toEqual({ lenses: [], sort: null, dir: null });
		expect(formatView({ lenses: ["gated"], sort: "desire", dir: "desc" }, defaults)).toBe("#lens=gated");
		expect(formatView({ lenses: [], sort: "size", dir: "desc" }, defaults)).toBe("#sort=size:desc");
		expect(formatView({ lenses: ["moe", "large"], sort: "size", dir: "asc" }, defaults)).toBe(
			"#lens=moe,large&sort=size:asc",
		);
		expect(formatView({ lenses: [], sort: "desire", dir: "desc" }, defaults)).toBe("");
	});
});
