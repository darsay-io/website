import { describe, expect, it } from "vitest";
import { compareEntries, compareFamily, entryArtifactType, factPrimer, ledgerGroup, resolveRowLink, rowLinkTarget, sameRowIdentity } from "./board.ts";

const row = (
	id: number,
	over: Partial<{
		desire: number | null;
		payload_bytes: number | null;
		source: string;
		status: "want" | "have";
		artifact_type: string | null;
	}>,
) =>
	({
		id,
		source: "huggingface:a/b",
		revision: null,
		include: null,
		desire: null,
		note: null,
		status: "want" as const,
		holders: "",
		added: "2026-08-26T18:00:00+00:00",
		payload_bytes: null,
		artifact_type: "model" as const,
		...over,
	});

describe("compareEntries", () => {
	it("sorts desire descending with nulls last", () => {
		const rows = [row(1, { desire: 2 }), row(2, { desire: null }), row(3, { desire: 9 })];
		rows.sort((a, b) => compareEntries(a, b, "desire", "desc"));
		expect(rows.map((r) => r.id)).toEqual([3, 1, 2]);
	});

	it("keeps insertion order as a tie-break", () => {
		const rows = [row(1, { desire: 5 }), row(4, { desire: 5 }), row(2, { desire: 5 })];
		rows.sort((a, b) => compareEntries(a, b, "desire", "desc"));
		expect(rows.map((r) => r.id)).toEqual([1, 2, 4]);
	});

	it("sorts type with dataset before model alphabetically", () => {
		const rows = [
			row(1, { source: "huggingface:a/b", artifact_type: "model" }),
			row(2, { source: "huggingface:datasets/a/c", artifact_type: "dataset" }),
		];
		rows.sort((a, b) => compareEntries(a, b, "type", "asc"));
		expect(rows.map((r) => r.id)).toEqual([2, 1]);
	});
});

describe("ledgerGroup", () => {
	const GiB = 1024 ** 3;
	it("files a row under the heading its sort changes on, and under none for the source order", () => {
		expect(ledgerGroup(row(1, { desire: 9 }), "desire")).toEqual({ key: "9", label: "desire 9" });
		expect(ledgerGroup(row(1, { desire: null }), "desire")).toEqual({ key: "none", label: "no desire yet" });
		expect(ledgerGroup(row(1, { status: "have" }), "status")).toEqual({ key: "have", label: "in a vault" });
		expect(ledgerGroup(row(1, {}), "status")).toEqual({ key: "want", label: "wanted" });
		expect(ledgerGroup(row(1, { source: "huggingface:datasets/a/c", artifact_type: "dataset" }), "type")).toEqual({ key: "dataset", label: "datasets" });
		expect(ledgerGroup(row(1, { source: "https://www.qwencloud.com/models/qwen3.8-max-0902" }), "type")).toEqual({ key: "closed", label: "closed works" });
		expect(ledgerGroup(row(1, { source: "huggingface:Qwen/Qwen3.8-27B" }), "family")).toEqual({ key: "qwen", label: "Qwen" });
		expect(ledgerGroup(row(1, {}), "source")).toBeNull();
	});

	it("buckets sizes by the order of magnitude an archivist plans around", () => {
		const bucket = (bytes: number | null) => ledgerGroup(row(1, { payload_bytes: bytes }), "size")?.label;
		expect(bucket(2 * 1024 * GiB)).toBe("a tebibyte and up");
		expect(bucket(1024 * GiB)).toBe("a tebibyte and up");
		expect(bucket(500 * GiB)).toBe("100 GiB to 1 TiB");
		expect(bucket(42 * GiB)).toBe("10 to 100 GiB");
		expect(bucket(3 * GiB)).toBe("1 to 10 GiB");
		expect(bucket(200 * 1024 * 1024)).toBe("under 1 GiB");
		expect(bucket(null)).toBe("unpriced");
	});

	it("keeps consecutive rows of one sort key under one runner", () => {
		const rows = [row(1, { desire: 9 }), row(2, { desire: 9 }), row(3, { desire: 7 }), row(4, { desire: null })];
		rows.sort((a, b) => compareEntries(a, b, "desire", "desc"));
		const keys = rows.map((r) => ledgerGroup(r, "desire")?.key);
		expect(keys).toEqual(["9", "9", "7", "none"]);
	});
});

describe("compareFamily", () => {
	it("reads the tree: family, generation oldest first, then size; no-family rows last", () => {
		const rows = [
			row(1, { source: "huggingface:Qwen/Qwen3.8-2.4T-A95B" }),
			row(2, { source: "huggingface:moonshotai/Kimi-K3" }),
			row(3, { source: "huggingface:Qwen/Qwen3-8B-Base" }),
			row(4, { source: "https://www.qwencloud.com/models/qwen3.8-max-0902" }),
			row(5, { source: "huggingface:Qwen/Qwen3.8-27B" }),
			row(6, { source: "test:acme/toy" }),
		];
		rows.sort((a, b) => compareEntries(a, b, "family", "asc"));
		expect(rows.map((r) => r.id)).toEqual([2, 3, 4, 5, 1, 6]);
		expect(compareFamily({ source: "huggingface:Qwen/Qwen3-8B" }, { source: "huggingface:Qwen/Qwen3-8B" })).toBe(0);
	});
});

describe("factPrimer", () => {
	it("routes the precision facts and closed to their cards", () => {
		expect(factPrimer("2.45T BF16")).toBe("dtype");
		expect(factPrimer("0.56 B/param")).toBe("dtype");
		expect(factPrimer("closed")).toBe("closed");
		expect(factPrimer("gated")).toBe("gated");
		expect(factPrimer("4.4 TiB")).toBe("large");
		expect(factPrimer("2.3 TiB repository total")).toBe("archive");
		expect(factPrimer("≥ 120 GiB selection · partial")).toBe("archive");
		expect(factPrimer("12 GGUF variants in repository")).toBe("subset");
		expect(factPrimer("pin abc123")).toBe("pin");
		expect(factPrimer("whatever")).toBeNull();
	});
});

describe("entryArtifactType", () => {
	it("prefers the stored type and falls back to the source grammar", () => {
		expect(entryArtifactType(row(1, { artifact_type: "dataset" }))).toBe("dataset");
		expect(
			entryArtifactType(row(1, { source: "huggingface:datasets/acme/reviews", artifact_type: null })),
		).toBe("dataset");
		expect(entryArtifactType(row(1, { source: "modelscope:qwen/Qwen-7B", artifact_type: null }))).toBe("—");
	});
});

describe("row links", () => {
	const rows = [
		row(7, { source: "huggingface:orcarouter/DeepSeek-V4-Flash-Vision-Uncensored" }),
		row(8, { source: "huggingface:datasets/ESCAD/OpenRTLSet" }),
		row(9, { source: "https://example.com/models/closed-one" }),
		row(10, { source: "huggingface:orcarouter/DeepSeek-V4-Flash-Vision-Uncensored" }),
	];
	const ids = (target: string) => resolveRowLink(rows, target).map((r) => r.id);

	it("names a row the way a person would, and finds it in any spelling", () => {
		expect(rowLinkTarget(rows[0].source)).toBe("orcarouter/DeepSeek-V4-Flash-Vision-Uncensored");
		expect(rowLinkTarget(rows[1].source)).toBe("datasets/ESCAD/OpenRTLSet");
		expect(rowLinkTarget(rows[2].source)).toBe("https://example.com/models/closed-one");
		expect(ids("orcarouter/DeepSeek-V4-Flash-Vision-Uncensored")).toEqual([7, 10]);
		expect(ids("ORCAROUTER/deepseek-v4-flash-vision-uncensored")).toEqual([7, 10]);
		expect(ids("https://huggingface.co/orcarouter/DeepSeek-V4-Flash-Vision-Uncensored")).toEqual([7, 10]);
		expect(ids("huggingface:orcarouter/DeepSeek-V4-Flash-Vision-Uncensored")).toEqual([7, 10]);
		expect(ids("datasets/ESCAD/OpenRTLSet")).toEqual([8]);
		expect(ids("https://example.com/models/closed-one")).toEqual([9]);
	});

	it("takes an id, and answers nothing for a stranger", () => {
		expect(ids("8")).toEqual([8]);
		expect(ids(" 9 ")).toEqual([9]);
		expect(ids("11")).toEqual([]);
		expect(ids("nobody/nothing")).toEqual([]);
		expect(ids("")).toEqual([]);
		expect(ids("not a source at all")).toEqual([]);
	});
});

describe("row identity", () => {
	const selected = { source: "huggingface:unsloth/GLM-5.3-Flash-GGUF", revision: "v1", include: ["/part1.gguf", "/part2.gguf"] };

	it("finds an existing variant across source spellings and include-set order", () => {
		expect(sameRowIdentity(selected, { ...selected, source: "https://huggingface.co/UNSLOTH/glm-5.3-flash-gguf", include: ["/part2.gguf", "/part1.gguf", "/part1.gguf"] })).toBe(true);
		expect(sameRowIdentity({ ...selected, include: null }, { ...selected, include: [] })).toBe(true);
	});

	it("distinguishes a variant from the whole repository, another pin, or another include set", () => {
		expect(sameRowIdentity(selected, { ...selected, include: null })).toBe(false);
		expect(sameRowIdentity(selected, { ...selected, revision: null })).toBe(false);
		expect(sameRowIdentity(selected, { ...selected, revision: "V1" })).toBe(false);
		expect(sameRowIdentity(selected, { ...selected, include: ["/part1.gguf"] })).toBe(false);
		expect(sameRowIdentity(selected, { ...selected, source: "huggingface:datasets/unsloth/GLM-5.3-Flash-GGUF" })).toBe(false);
		expect(sameRowIdentity({ ...selected, source: "bad source" }, { ...selected, source: "another bad source" })).toBe(false);
	});
});
