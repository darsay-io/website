import { describe, expect, it } from "vitest";
import fixtures from "./lineage-fixtures.json";
import {
	compareGenerations,
	displayGeneration,
	familiesOf,
	familyKey,
	groupByFamily,
	lineageOf,
	nameOfSource,
	parseName,
	publisherOf,
} from "./lineage.ts";

type Fixture = {
	name: string;
	family: string | null;
	generation: string | null;
	member: string | null;
	variants: string[];
	formats: string[];
	size_total: number | null;
	size_active: number | null;
};

describe("the name grammar (shared fixtures with the CLI)", () => {
	for (const row of fixtures as Fixture[]) {
		it(JSON.stringify(row.name), () => {
			const got = parseName(row.name);
			expect(got.family).toBe(row.family);
			expect(got.generation).toBe(row.generation);
			expect(got.member).toBe(row.member);
			expect(got.variants).toEqual(row.variants);
			expect(got.formats).toEqual(row.formats);
			expect(got.sizeTotal).toBe(row.size_total);
			expect(got.sizeActive).toBe(row.size_active);
		});
	}
});

describe("sources and homes", () => {
	it("reads the work's name from refs and home URLs alike", () => {
		expect(nameOfSource("huggingface:Qwen/Qwen3.8-27B")).toBe("Qwen3.8-27B");
		expect(nameOfSource("huggingface:datasets/saidutta69/fable-5-premium")).toBe("fable-5-premium");
		expect(nameOfSource("https://www.qwencloud.com/models/qwen3.8-max-0902/?x#y")).toBe("qwen3.8-max-0902");
		expect(nameOfSource("test:acme/toy")).toBe("toy");
		expect(nameOfSource("")).toBe("");
	});
	it("folds the family key so a closed work meets its open siblings", () => {
		expect(familyKey(lineageOf("https://www.qwencloud.com/models/qwen3.8-max-0902"))).toBe("qwen");
		expect(familyKey(lineageOf("huggingface:Qwen/Qwen3.8-2.4T-A95B"))).toBe("qwen");
		expect(publisherOf("huggingface:Qwen/Qwen3.8-27B")).toBe("Qwen");
		expect(publisherOf("huggingface:datasets/acme/reviews")).toBe("acme");
		expect(publisherOf("https://example.com/x")).toBeNull();
	});
	it("orders generations numerically", () => {
		expect(["K3", "K2", "K2.5"].sort(compareGenerations)).toEqual(["K2", "K2.5", "K3"]);
		expect(["3.8", "3", "3.5", "4"].sort(compareGenerations)).toEqual(["3", "3.5", "3.8", "4"]);
		expect(compareGenerations(null, "1")).toBeLessThan(0);
		expect(displayGeneration("Qwen", "3.8")).toBe("Qwen 3.8");
		expect(displayGeneration(null, null)).toBe("—");
	});
});

describe("the tree", () => {
	const rows = [
		{ source: "huggingface:Qwen/Qwen3.8-2.4T-A95B" },
		{ source: "huggingface:Qwen/Qwen3-8B-Base" },
		{ source: "https://www.qwencloud.com/models/qwen3.8-max-0902" },
		{ source: "huggingface:OBLITERATUS/Qwen3.8-27B-OBLITERATED" },
		{ source: "huggingface:Qwen/Qwen3.5-397B-A17B" },
		{ source: "huggingface:moonshotai/Kimi-K3" },
		{ source: "huggingface:moonshotai/Kimi-K2-Base" },
		{ source: "huggingface:Uniboshi/Kimi-K3-Abliterated-V1" },
		{ source: "huggingface:datasets/saidutta69/fable-5-premium" },
	];
	it("groups families largest first, generations oldest first, members smallest first", () => {
		const tree = groupByFamily(rows);
		expect(tree.map((f) => f.family)).toEqual(["Qwen", "Kimi", "fable"]);
		const qwen = tree[0];
		expect(qwen.homePublisher).toBe("Qwen");
		expect(qwen.count).toBe(5);
		expect(qwen.generations.map((g) => g.generation)).toEqual(["3", "3.5", "3.8"]);
		const gen38 = qwen.generations[2].rows.map((r) => r.row.source);
		expect(gen38[gen38.length - 1]).toBe("huggingface:Qwen/Qwen3.8-2.4T-A95B");
		expect(tree[1].homePublisher).toBe("moonshotai");
		expect(tree[1].generations.map((g) => g.generation)).toEqual(["K2", "K3"]);
	});
	it("lists the families a board holds", () => {
		expect(familiesOf(rows)).toEqual([
			{ key: "qwen", family: "Qwen", count: 5 },
			{ key: "kimi", family: "Kimi", count: 3 },
			{ key: "fable", family: "fable", count: 1 },
		]);
	});
});
