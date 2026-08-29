import { describe, expect, it } from "vitest";
import {
	DEFAULT_DIAL_INDICES,
	MAX_GB_STEPS,
	MIN_FREE_STEPS,
	archiveCaption,
	archiveCommand,
	catalogArg,
	dialsFromIndices,
	gaugeFillPct,
	gaugeReadout,
} from "./archive-cmd.ts";

describe("catalogArg", () => {
	it("prefixes ./ so the CLI treats it as a path-addressed catalog", () => {
		expect(catalogArg("summer-2026-heater")).toBe("./summer-2026-heater.json");
	});
});

describe("dialsFromIndices", () => {
	it("defaults to a 10 GiB cap and omits the 2G disk floor", () => {
		expect(dialsFromIndices(DEFAULT_DIAL_INDICES)).toEqual({
			maxGb: 10,
			minFree: null,
			maxRate: null,
			maxMinutes: null,
		});
	});

	it("emits --min-free 0 when the floor is disabled", () => {
		expect(dialsFromIndices({ ...DEFAULT_DIAL_INDICES, minFree: 0 }).minFree).toBe("0");
	});

	it("clamps out-of-range indices", () => {
		const d = dialsFromIndices({ maxGb: 99, minFree: -4, maxRate: 99, maxMinutes: -1 });
		expect(d.maxGb).toBe(MAX_GB_STEPS[MAX_GB_STEPS.length - 1]);
		expect(d.minFree).toBe("0");
		expect(d.maxRate).toBe("25M");
		expect(d.maxMinutes).toBeNull();
	});
});

describe("archiveCommand", () => {
	it("builds the cookbook tonight line", () => {
		expect(archiveCommand("./summer-2026-heater.json", dialsFromIndices(DEFAULT_DIAL_INDICES))).toBe(
			"darsay archive --next ./summer-2026-heater.json --max-gb 10",
		);
	});

	it("omits every optional flag when dials are wide open", () => {
		expect(
			archiveCommand("./c.json", {
				maxGb: null,
				minFree: null,
				maxRate: null,
				maxMinutes: null,
			}),
		).toBe("darsay archive --next ./c.json");
	});

	it("appends every engaged dial in flag order", () => {
		expect(
			archiveCommand("./c.json", {
				maxGb: 20,
				minFree: "10G",
				maxRate: "5M",
				maxMinutes: 60,
			}),
		).toBe("darsay archive --next ./c.json --max-gb 20 --min-free 10G --max-rate 5M --max-minutes 60");
	});

	it("tracks each min-free step except the omitted default", () => {
		const cmds = MIN_FREE_STEPS.map((_, i) =>
			archiveCommand("./c.json", dialsFromIndices({ ...DEFAULT_DIAL_INDICES, maxGb: 0, minFree: i })),
		);
		expect(cmds).toEqual([
			"darsay archive --next ./c.json --min-free 0",
			"darsay archive --next ./c.json",
			"darsay archive --next ./c.json --min-free 5G",
			"darsay archive --next ./c.json --min-free 10G",
			"darsay archive --next ./c.json --min-free 20G",
			"darsay archive --next ./c.json --min-free 50G",
		]);
	});
});

describe("archiveCaption", () => {
	it("describes a capped tonight run", () => {
		expect(archiveCaption(dialsFromIndices(DEFAULT_DIAL_INDICES))).toBe(
			"Tonight: up to 10 GiB of the next unfinished source, then a clean pause. Rerun the same line to continue.",
		);
	});

	it("describes an uncapped run", () => {
		expect(archiveCaption({ maxGb: null, minFree: null, maxRate: null, maxMinutes: null })).toBe(
			"The next unfinished source, until the bundle is complete.",
		);
	});

	it("mentions rate, session, and a raised disk floor", () => {
		const text = archiveCaption({
			maxGb: 5,
			minFree: "10G",
			maxRate: "5M",
			maxMinutes: 30,
		});
		expect(text).toContain("up to 5 GiB, or 30 minutes");
		expect(text).toContain("5 MiB/s");
		expect(text).toContain("10 GiB remains free");
	});
});

describe("gaugeReadout", () => {
	it("shows infinity for unlimited caps", () => {
		expect(gaugeReadout("maxGb", 0)).toEqual({ value: "∞", unit: "GiB", aria: "unlimited download" });
		expect(gaugeReadout("maxRate", 0)).toEqual({ value: "∞", unit: "rate", aria: "unlimited rate" });
		expect(gaugeReadout("maxMinutes", 0)).toEqual({ value: "∞", unit: "min", aria: "no session limit" });
	});

	it("shows the default 10 GiB cap", () => {
		expect(gaugeReadout("maxGb", DEFAULT_DIAL_INDICES.maxGb)).toEqual({
			value: "10",
			unit: "GiB",
			aria: "10 gigabytes",
		});
	});

	it("labels a disabled disk floor as off", () => {
		expect(gaugeReadout("minFree", 0).value).toBe("off");
	});
});

describe("gaugeFillPct", () => {
	it("is a 270-degree arc at the last step", () => {
		expect(gaugeFillPct(0, 8)).toBe(0);
		expect(gaugeFillPct(7, 8)).toBe(75);
	});
});
