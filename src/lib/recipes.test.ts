import { describe, expect, it } from "vitest";
import {
	LARGE_BYTES,
	alignComments,
	bundleName,
	deriveRecipes,
	halfBudgetGb,
	humanParams,
	includeArgs,
	revision12,
	shellQuote,
	type Recipe,
	type RecipeInput,
} from "./recipes.ts";

const GiB = 1024 ** 3;
const BOARD = "https://darsay.io/b/0123456789abcdef0123456789abcdef";

function entry(over: Partial<RecipeInput> = {}): RecipeInput {
	return {
		source: "huggingface:Qwen/Qwen3-0.6B",
		revision: null,
		include: null,
		payload_bytes: 1_519_209_243,
		artifact_type: "model",
		gated: false,
		parameters: 751_632_384,
		dominant_dtype: "BF16",
		...over,
	};
}

function all(set: ReturnType<typeof deriveRecipes>): Recipe[] {
	return [...set.hero, ...set.more];
}

function keys(list: Recipe[]): string[] {
	return list.map((r) => r.key);
}

function text(list: Recipe[]): string {
	return list.map((r) => r.lines.join("\n")).join("\n");
}

describe("shell safety", () => {
	it("leaves canonical sources bare", () => {
		expect(shellQuote("huggingface:Qwen/Qwen3-0.6B")).toBe("huggingface:Qwen/Qwen3-0.6B");
		expect(shellQuote("huggingface:datasets/acme/reviews_v2")).toBe("huggingface:datasets/acme/reviews_v2");
	});
	it("single-quotes anything else and escapes embedded quotes", () => {
		expect(shellQuote("test:acme/toy stuff")).toBe("'test:acme/toy stuff'");
		expect(shellQuote("x:$(rm -rf ~)")).toBe("'x:$(rm -rf ~)'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote("")).toBe("''");
	});
	it("always quotes globs, in argv order", () => {
		expect(includeArgs(["*Q4_K_M*", "tokenizer*"])).toBe(" --include '*Q4_K_M*' --include 'tokenizer*'");
		expect(includeArgs(null)).toBe("");
		expect(includeArgs([])).toBe("");
	});
	it("never lets user text out of quotes in any command", () => {
		const nasty = entry({
			source: "huggingface:Ev il/Name\nrm -rf ~",
			include: ["*'; echo pwned; '*"],
			revision: "v1.0 $(id)",
		});
		// Outside single quotes nothing the shell would interpret may remain.
		const unquoted = (line: string) =>
			line
				.replace(/'\\''/g, "Q")
				.replace(/'[^']*'/g, "")
				.replace(/<(rev|bundle)>/g, "") // cookbook placeholders, not user text
				.replace(/\s+#.*$/, "");
		for (const r of all(deriveRecipes(nasty, "summer"))) {
			for (const line of r.lines.filter((l) => !l.startsWith("#"))) {
				expect(unquoted(line)).not.toMatch(/[\n;$`|&<>()]/);
				expect(unquoted(line)).not.toContain("rm -rf");
			}
		}
		const est = deriveRecipes(nasty, "summer").hero.find((r) => r.key === "estimate")!;
		expect(est.lines[0]).toBe(
			"darsay estimate 'huggingface:Ev il/Name\nrm -rf ~' --revision 'v1.0 $(id)' --include '*'\\''; echo pwned; '\\''*'",
		);
	});
	it("quotes a board URL that needs it, leaves the real one bare", () => {
		const evil = deriveRecipes(entry(), "s", "https://darsay.io/b/x; rm -rf ~").hero.find((r) => r.key === "board")!;
		expect(evil.lines[0]).toContain("--board 'https://darsay.io/b/x; rm -rf ~'");
		const real = deriveRecipes(entry(), "s", BOARD).hero.find((r) => r.key === "board")!;
		expect(real.lines[0]).toBe(`darsay archive huggingface:Qwen/Qwen3-0.6B --board ${BOARD}`);
	});
});

describe("bundle naming", () => {
	it("mirrors the CLI: owner--name lowercased, datasets-- prefix", () => {
		expect(bundleName("huggingface:Qwen/Qwen3-0.6B")).toBe("qwen--qwen3-0.6b");
		expect(bundleName("huggingface:datasets/cornell-movie-review-data/rotten_tomatoes")).toBe(
			"datasets--cornell-movie-review-data--rotten_tomatoes",
		);
		expect(bundleName("test:acme/toy")).toBeNull();
	});
	it("uses the first 12 of a hex pin, else the cookbook placeholder", () => {
		expect(revision12("c1899de289a0f1e2d3c4b5a6")).toBe("c1899de289a0");
		expect(revision12("C1899DE289A0")).toBe("c1899de289a0");
		expect(revision12("main")).toBe("<rev>");
		expect(revision12("abc123")).toBe("<rev>");
		expect(revision12(null)).toBe("<rev>");
	});
});

describe("numbers", () => {
	it("halves round up to a multiple of 5 GiB", () => {
		expect(halfBudgetGb(438 * GiB)).toBe(220);
		expect(halfBudgetGb(51.8 * GiB)).toBe(30);
		expect(halfBudgetGb(30 * GiB)).toBe(15);
		expect(halfBudgetGb(1 * GiB)).toBe(5);
	});
	it("prints parameters like the CLI", () => {
		expect(humanParams(27_780_000_000)).toBe("27.78B");
		expect(humanParams(596_000_000)).toBe("596.0M");
	});
	it("aligns trailing comments in one column", () => {
		const out = alignComments([
			["darsay archive X --max-gb 10", "tonight"],
			["darsay archive X", "finish"],
			"plain",
		]);
		expect(out[0]).toBe("darsay archive X --max-gb 10  # tonight");
		expect(out[1]).toBe("darsay archive X              # finish");
		expect(out[2]).toBe("plain");
	});
});

describe("deriveRecipes", () => {
	it("small model: estimate, archive, after, adopt up front; shards behind more", () => {
		const set = deriveRecipes(entry(), "summer-2026");
		expect(keys(set.hero)).toEqual(["estimate", "archive", "after", "adopt"]);
		expect(keys(set.more)).toEqual(["shards"]);
		expect(set.headline).toBe("Small enough for tonight");
		expect(set.facts).toEqual(["1.4 GiB", "751.6M BF16", "model"]);
		expect(set.hero[0].lines).toEqual(["darsay estimate huggingface:Qwen/Qwen3-0.6B"]);
		expect(set.hero[1].lines).toEqual(["darsay archive huggingface:Qwen/Qwen3-0.6B"]);
		expect(text([set.hero[2]])).toContain('darsay run qwen--qwen3-0.6b "Say hello"');
		expect(text([set.hero[2]])).toContain("darsay export qwen--qwen3-0.6b -o /Volumes/USB");
		expect(text([set.hero[2]])).toContain("darsay verify qwen--qwen3-0.6b");
	});

	it("every row surfaces estimate, archive, and adopt-the-board with the board's catalog id", () => {
		const rows: RecipeInput[] = [
			entry(),
			entry({ payload_bytes: 438 * GiB }),
			entry({ source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF", include: ["*Q4_K_M*"], payload_bytes: 464 * GiB }),
			entry({ source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF", payload_bytes: 464 * GiB }),
			entry({ source: "huggingface:meta-llama/Llama-3.1-8B", gated: true, payload_bytes: 30 * GiB }),
			entry({ source: "huggingface:datasets/acme/reviews", artifact_type: "dataset", payload_bytes: 889_683 }),
			entry({ source: "test:acme/toy", artifact_type: null, payload_bytes: null }),
			entry({ payload_bytes: null }),
		];
		for (const row of rows) {
			const set = deriveRecipes(row, "summer-2026");
			const ks = keys(all(set));
			expect(ks).toContain("estimate");
			expect(ks).toContain("archive");
			expect(ks).toContain("adopt");
			expect(new Set(ks).size).toBe(ks.length);
			expect(set.hero.length).toBeGreaterThanOrEqual(2);
			expect(set.hero.length).toBeLessThanOrEqual(4);
			const adopt = all(set).find((r) => r.key === "adopt")!;
			expect(adopt.lines).toEqual([
				"darsay catalog new summer-2026",
				"darsay catalog adopt summer-2026 ./summer-2026.json  # copy intent; your overlay, your bytes",
				"darsay archive --next summer-2026 --max-gb 10        # the next unfinished source",
			]);
			expect(adopt.download).toBe(true);
			for (const r of all(set)) {
				expect(r.lines.length).toBeGreaterThan(0);
				expect(r.title).toBeTruthy();
				expect(r.why).toBeTruthy();
			}
			for (const r of all(set).filter((r) => r.key !== "adopt" && r.key !== "after")) {
				expect(text([r])).toContain(shellQuote(row.source));
			}
		}
	});

	it("large model: pause/resume and the two-disk --handoff flow lead, with a half-size budget", () => {
		const set = deriveRecipes(entry({ source: "huggingface:Qwen/Qwen3-235B-A22B", payload_bytes: 438 * GiB }), "summer");
		expect(set.traits).toEqual(["large"]);
		expect(set.headline).toBe("Too big for one sitting");
		expect(keys(set.hero)).toEqual(["estimate", "budget", "halves", "shards"]);
		expect(keys(set.more)).toEqual(["archive", "adopt", "after"]);
		const budget = set.hero[1];
		expect(budget.lines).toEqual([
			"darsay archive huggingface:Qwen/Qwen3-235B-A22B --max-gb 10  # tonight: first 10 GB",
			"darsay archive huggingface:Qwen/Qwen3-235B-A22B --max-gb 10  # tomorrow: next 10 GB",
			"darsay archive huggingface:Qwen/Qwen3-235B-A22B --dry-run    # what's left?",
			"darsay archive huggingface:Qwen/Qwen3-235B-A22B              # finish, verify, register",
		]);
		const halves = set.hero[2];
		expect(halves.lines).toContain("darsay archive huggingface:Qwen/Qwen3-235B-A22B --max-gb 220");
		expect(halves.lines).toContain("darsay --vault /Volumes/big assemble ~/darsay/qwen--qwen3-235b-a22b/<rev> --handoff");
		expect(halves.lines.filter((l) => l.includes("--handoff"))).toHaveLength(2);
		expect(halves.doc?.href).toBe("/docs/incremental/#across-disks-assemble---handoff-and-skeletons");
		const shards = set.hero[3];
		expect(text([shards])).toContain("--shard 1/2 --max-gb 20");
		expect(text([shards])).toContain("--shard 2/2 --max-gb 20");
		expect(text([shards])).toContain(
			"darsay --vault ./combined assemble /usb/alice/qwen--qwen3-235b-a22b/<rev> /usb/bob/qwen--qwen3-235b-a22b/<rev>",
		);
	});

	it("include globs ride on estimate and archive, and the pack size does not mean 'large'", () => {
		const set = deriveRecipes(
			entry({ source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF", include: ["*Q4_K_M*"], payload_bytes: 464 * GiB }),
			"summer",
		);
		expect(set.traits).toEqual(["subset"]);
		expect(keys(set.hero)).toEqual(["estimate", "archive", "adopt"]);
		expect(keys(set.more)).toEqual(["budget", "shards", "after"]);
		expect(set.hero[0].lines).toEqual(["darsay estimate huggingface:unsloth/Qwen3-30B-A3B-GGUF --include '*Q4_K_M*'"]);
		expect(set.hero[1].lines).toEqual(["darsay archive huggingface:unsloth/Qwen3-30B-A3B-GGUF --include '*Q4_K_M*'"]);
		expect(set.hero[1].title).toBe("Grab just the subset");
		expect(set.facts[0]).toBe("464 GiB before --include");
		expect(set.verdict).toContain("*Q4_K_M*");
	});

	it("a GGUF pack without globs suggests one quant first", () => {
		const set = deriveRecipes(entry({ source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF", payload_bytes: 464 * GiB }), "summer");
		expect(set.traits).toEqual(["pack"]);
		expect(keys(set.hero)).toEqual(["subset", "estimate", "adopt"]);
		expect(set.hero[0].lines).toEqual([
			"darsay estimate huggingface:unsloth/Qwen3-30B-A3B-GGUF --include '*Q4_K_M*'",
			"darsay archive  huggingface:unsloth/Qwen3-30B-A3B-GGUF --include '*Q4_K_M*'",
		]);
		expect(keys(set.more)).toContain("budget");
	});

	it("gated rows put authentication before the archive verb", () => {
		const small = deriveRecipes(entry({ source: "huggingface:meta-llama/Llama-3.2-1B", gated: true, payload_bytes: 2 * GiB }), "summer");
		expect(small.traits).toEqual(["gated"]);
		expect(small.headline).toBe("Behind a gate");
		const archive = small.hero.find((r) => r.key === "archive")!;
		expect(archive.lines[0]).toMatch(/^hf auth login\s+# once, after accepting the terms on huggingface.co$/);
		expect(archive.lines[1]).toBe("darsay archive huggingface:meta-llama/Llama-3.2-1B");
		expect(archive.doc).toEqual({ href: "https://huggingface.co/meta-llama/Llama-3.2-1B", label: "Accept the terms on Hugging Face" });

		const big = deriveRecipes(entry({ source: "huggingface:meta-llama/Llama-3.1-8B", gated: true, payload_bytes: 30 * GiB }), "summer");
		expect(big.traits).toEqual(["large", "gated"]);
		expect(keys(big.hero)).toEqual(["estimate", "archive", "budget", "halves"]);
		expect(big.hero[1].lines[0]).toContain("hf auth login");
		expect(big.facts).toContain("gated");
	});

	it("datasets use datasets-- bundle names and info instead of run", () => {
		const set = deriveRecipes(
			entry({ source: "huggingface:datasets/cornell-movie-review-data/rotten_tomatoes", artifact_type: "dataset", payload_bytes: 889_683, parameters: null, dominant_dtype: null }),
			"summer",
		);
		expect(set.traits).toEqual(["dataset"]);
		expect(set.headline).toBe("A dataset, same verbs");
		const after = all(set).find((r) => r.key === "after")!;
		expect(text([after])).toContain("darsay info datasets--cornell-movie-review-data--rotten_tomatoes");
		expect(text([after])).not.toContain("darsay run");
		expect(set.facts).toEqual(["869 KiB", "dataset"]);
	});

	it("a pinned revision is threaded through every fetch and into bundle paths", () => {
		const set = deriveRecipes(entry({ revision: "c1899de289a0f1e2", payload_bytes: 60 * GiB }), "summer");
		for (const r of all(set).filter((r) => ["estimate", "archive", "budget", "halves", "shards"].includes(r.key))) {
			for (const line of r.lines.filter((l) => /darsay .*(archive|estimate) /.test(l))) {
				expect(line).toContain("--revision c1899de289a0f1e2");
			}
		}
		expect(text(all(set))).toContain("~/darsay/qwen--qwen3-0.6b/c1899de289a0 --handoff");
		expect(set.facts).toContain("pin c1899de289a0");
	});

	it("an opaque source gets the happy path only, quoted", () => {
		const set = deriveRecipes(entry({ source: "test:acme/toy", artifact_type: null, payload_bytes: null, parameters: null }), "summer");
		expect(set.traits).toEqual(["opaque", "unsized"]);
		expect(keys(set.hero)).toEqual(["estimate", "archive", "adopt"]);
		expect(set.more).toEqual([]);
		expect(set.hero[0].lines).toEqual(["darsay estimate test:acme/toy"]);
	});

	it("LARGE_BYTES is the 20 GiB line", () => {
		expect(deriveRecipes(entry({ payload_bytes: LARGE_BYTES - 1 }), "s").traits).not.toContain("large");
		expect(deriveRecipes(entry({ payload_bytes: LARGE_BYTES }), "s").traits).toContain("large");
	});
});

describe("the board round-trip card", () => {
	const rows: RecipeInput[] = [
		entry(),
		entry({ payload_bytes: 438 * GiB }),
		entry({ source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF", include: ["*Q4_K_M*"], payload_bytes: 464 * GiB }),
		entry({ source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF", payload_bytes: 464 * GiB }),
		entry({ source: "huggingface:meta-llama/Llama-3.1-8B", gated: true, payload_bytes: 30 * GiB }),
		entry({ source: "huggingface:datasets/acme/reviews", artifact_type: "dataset", payload_bytes: 889_683 }),
		entry({ source: "test:acme/toy", artifact_type: null, payload_bytes: null }),
	];

	it("appears in the hero of every row shape when the page has a URL, never without one", () => {
		for (const row of rows) {
			const withUrl = deriveRecipes(row, "summer", BOARD);
			expect(keys(withUrl.hero)).toContain("board");
			expect(withUrl.hero.length).toBeLessThanOrEqual(4);
			expect(new Set(keys(all(withUrl))).size).toBe(all(withUrl).length);
			expect(keys(all(deriveRecipes(row, "summer")))).not.toContain("board");
		}
	});

	it("is one line — the row's exact identity plus --board, so the claim matches", () => {
		const set = deriveRecipes(
			entry({
				source: "huggingface:unsloth/Qwen3-30B-A3B-GGUF",
				revision: "c1899de289a0f1e2",
				include: ["*Q4_K_M*"],
				payload_bytes: 18 * GiB,
			}),
			"summer",
			BOARD,
		);
		const b = set.hero.find((r) => r.key === "board")!;
		expect(b.lines).toEqual([
			`darsay archive huggingface:unsloth/Qwen3-30B-A3B-GGUF --revision c1899de289a0f1e2 --include '*Q4_K_M*' --board ${BOARD}`,
		]);
		expect(b.label).toBe("claim · fetch · report");
		expect(b.doc?.href).toBe("/docs/examples/#keep-a-darsayio-board-honest");
		expect(b.why).toContain("--board");
	});

	it("slots after the fetch verbs and spills the displaced card into more", () => {
		const small = deriveRecipes(entry(), "s", BOARD);
		expect(keys(small.hero)).toEqual(["estimate", "archive", "board", "after"]);
		expect(keys(small.more)).toEqual(["adopt", "shards"]);
		const large = deriveRecipes(entry({ payload_bytes: 438 * GiB }), "s", BOARD);
		expect(keys(large.hero)).toEqual(["estimate", "budget", "board", "halves"]);
		expect(keys(large.more)).toEqual(["shards", "archive", "adopt", "after"]);
		const gatedLarge = deriveRecipes(entry({ gated: true, payload_bytes: 438 * GiB }), "s", BOARD);
		expect(keys(gatedLarge.hero)).toEqual(["estimate", "archive", "budget", "board"]);
		expect(keys(gatedLarge.more)).toEqual(["halves", "shards", "adopt", "after"]);
	});
});
