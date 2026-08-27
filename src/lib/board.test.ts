import { describe, expect, it } from "vitest";
import { compareEntries } from "./board.ts";

const row = (
	id: number,
	over: Partial<{ desire: number | null; payload_bytes: number | null; source: string; status: "want" | "have" }>,
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
});
