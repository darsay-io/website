import { describe, expect, it } from "vitest";
import { compareEntries, entryArtifactType } from "./board.ts";

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

describe("entryArtifactType", () => {
	it("prefers the stored type and falls back to the source grammar", () => {
		expect(entryArtifactType(row(1, { artifact_type: "dataset" }))).toBe("dataset");
		expect(
			entryArtifactType(row(1, { source: "huggingface:datasets/acme/reviews", artifact_type: null })),
		).toBe("dataset");
		expect(entryArtifactType(row(1, { source: "modelscope:qwen/Qwen-7B", artifact_type: null }))).toBe("—");
	});
});
