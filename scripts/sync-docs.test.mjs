import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "./sync-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "scripts/snapshots");

describe("sync-docs", () => {
	it("transforms pinned CLI docs and matches snapshots", () => {
		const written = runSync({ check: false });
		expect(written["getting-started.mdx"]).toContain("title: \"Start here\"");
		expect(written["index.mdx"]).toContain("title: \"Documentation\"");
		expect(written["examples.mdx"]).toMatch(/\/docs\/getting-started\//);
		for (const name of ["getting-started.mdx", "catalogs.mdx", "sources.mdx", "examples.mdx", "index.mdx"]) {
			const snap = path.join(SNAP, name);
			if (fs.existsSync(snap)) {
				expect(written[name]).toBe(fs.readFileSync(snap, "utf8"));
			}
		}
		const leftover = /\]\([^)]+\.md(?:#[^)]*)?\)/;
		for (const body of Object.values(written)) {
			const strippedHttp = body.replace(/\]\(https?:\/\/[^)]+\)/g, "]()");
			expect(strippedHttp).not.toMatch(leftover);
		}
	});
});
