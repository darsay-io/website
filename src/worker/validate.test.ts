import { describe, expect, it } from "vitest";
import {
	includeJson,
	includeKey,
	parseCatalogId,
	parseDesire,
	secretEqual,
	slugifyTitle,
	utcNow,
} from "./validate.ts";

describe("include identity", () => {
	it("stores argv order and keys sorted with duplicates", () => {
		expect(includeJson(["b", "a"])).toBe(JSON.stringify(["b", "a"]));
		expect(includeKey(["b", "a"])).toBe(JSON.stringify(["a", "b"]));
		expect(includeKey(["a", "a"])).toBe(JSON.stringify(["a", "a"]));
		expect(includeJson(null)).toBeNull();
		expect(includeKey(null)).toBe("[]");
	});
});

describe("catalog_id", () => {
	it("slugifies title or falls back to board", () => {
		expect(slugifyTitle("Summer 2026")).toBe("summer-2026");
		expect(slugifyTitle("!!!")).toBe("board");
		expect(parseCatalogId(undefined, "Summer 2026").ok && parseCatalogId(undefined, "Summer 2026")).toMatchObject({
			id: "summer-2026",
		});
		expect(parseCatalogId("Summer", "x")).toMatchObject({ ok: true, id: "summer" });
		expect(parseCatalogId("Nope Space", "x").ok).toBe(false);
		expect(parseCatalogId("a".repeat(65), "x").ok).toBe(false);
		expect(parseCatalogId(12, "x").ok).toBe(false);
	});
});

describe("desire", () => {
	it("rejects floats", () => {
		expect(parseDesire(9)).toEqual({ ok: true, desire: 9 });
		expect(parseDesire(9.5).ok).toBe(false);
		expect(parseDesire(null)).toEqual({ ok: true, desire: null });
	});
});

describe("utcNow", () => {
	it("emits +00:00 not Z", () => {
		expect(utcNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
	});
});

describe("secretEqual", () => {
	it("accepts only the exact string", () => {
		expect(secretEqual("abc", "abc")).toBe(true);
		expect(secretEqual("abd", "abc")).toBe(false);
		expect(secretEqual("ab", "abc")).toBe(false);
		expect(secretEqual(null, "abc")).toBe(false);
		expect(secretEqual("abc", "")).toBe(false);
	});
});
