import { describe, expect, it } from "vitest";
import { plural, prettyDate, relativeTime } from "./format.ts";

const NOW = Date.parse("2026-09-01T01:20:00+00:00");

describe("prettyDate", () => {
	it("renders a UTC day-month-year and leaves garbage alone", () => {
		expect(prettyDate("2026-08-28T18:09:16+00:00")).toBe("28 Aug 2026");
		expect(prettyDate("2026-12-31T23:59:59+00:00")).toBe("31 Dec 2026");
		expect(prettyDate("soon")).toBe("soon");
	});
});

describe("relativeTime", () => {
	const at = (s: string) => relativeTime(s, NOW);
	it("steps through the units", () => {
		expect(at("2026-09-01T01:19:50+00:00")).toBe("just now");
		expect(at("2026-09-01T01:16:53+00:00")).toBe("3 min ago");
		expect(at("2026-09-01T01:19:00+00:00")).toBe("a minute ago");
		expect(at("2026-09-01T00:20:00+00:00")).toBe("an hour ago");
		expect(at("2026-08-31T20:20:00+00:00")).toBe("5 hours ago");
		expect(at("2026-08-31T01:20:00+00:00")).toBe("yesterday");
		expect(at("2026-08-20T01:20:00+00:00")).toBe("12 days ago");
		expect(at("2026-06-01T01:20:00+00:00")).toBe("1 Jun 2026");
	});
});

describe("plural", () => {
	it("counts", () => {
		expect(plural(1, "source")).toBe("1 source");
		expect(plural(16, "source")).toBe("16 sources");
		expect(plural(2, "lens", "lenses")).toBe("2 lenses");
	});
});
