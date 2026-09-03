import { describe, expect, it } from "vitest";
import { buildLlmsTxt, docSections, machineInterfaces, sentence } from "./llms.mjs";
import { pageSlugs } from "./sidebar.mjs";

const LINK = /^- \[([^\]]+)\]\((\S+)\)(?:: (.+))?$/;

describe("llms.txt", () => {
	const text = buildLlmsTxt();
	const lines = text.split("\n");

	it("is an H1, a summary, and sections of links", () => {
		expect(lines[0]).toBe("# darsay");
		expect(lines[2].startsWith("> ")).toBe(true);
		const headings = lines.filter((l) => l.startsWith("## "));
		expect(headings[0]).toBe("## Machine interfaces");
		expect(headings[headings.length - 1]).toBe("## Optional");
		for (const l of lines) if (l.startsWith("- ")) expect(l, l).toMatch(LINK);
	});

	it("links every docs page exactly once, under the sidebar's own groups", () => {
		const { synced, authored } = pageSlugs();
		const urls = lines.map((l) => LINK.exec(l)?.[2]).filter(Boolean);
		for (const slug of [...synced, ...authored]) {
			const url = `https://darsay.io/${slug}/`;
			expect(urls.filter((u) => u === url), `${slug} in llms.txt`).toHaveLength(1);
		}
		const labels = docSections().map((s) => s.label);
		expect(labels).toContain("Using the vault");
		expect(labels).toContain("The board");
	});

	it("names the machine interfaces the card names", () => {
		const urls = machineInterfaces().map((i) => i.url);
		expect(urls).toEqual(["https://darsay.io/.well-known/mcp-server-card", "https://darsay.io/mcp", "https://darsay.io/openapi.json", "https://darsay.io/api/guide"]);
		for (const u of urls) expect(text).toContain(`](${u})`);
		expect(text).toContain("](https://darsay.io/agents/)");
	});

	it("names no board", () => {
		expect(text).not.toMatch(/[0-9a-f]{32}/);
	});

	it("keeps the board's words", () => {
		expect(text).toContain("rows, not cards");
		expect(text).not.toMatch(/\bmaster\b/i);
	});
});

describe("a description cut at its last whole sentence", () => {
	it("drops a trailing fragment and the emphasis marks", () => {
		expect(sentence("Models are the artifacts of this decade. They are published as living")).toBe("Models are the artifacts of this decade.");
		expect(sentence("Copy-paste recipes. Each one is a complete thought: the command, what")).toBe("Copy-paste recipes.");
		expect(sentence("**You have five minutes.**")).toBe("You have five minutes.");
		expect(sentence("Three commands keep a model and talk to it. This page walks through them")).toBe("Three commands keep a model and talk to it.");
	});

	it("says nothing rather than half a sentence, a table row, or a list item", () => {
		expect(sentence("Keys and scopes, connecting Claude")).toBe("");
		expect(sentence("estimate and archive take one argument, a source ref:")).toBe("");
		expect(sentence("| Field | Meaning |")).toBe("");
		expect(sentence("- Filename: <bundle_id>.mvb.tar, e.g. qwen--qwen3-0.6b@c1899de289a0.mvb.tar.")).toBe("");
		expect(sentence("1. The payload stays immutable.")).toBe("");
		expect(sentence("")).toBe("");
	});

	it("reads a link as its text", () => {
		expect(sentence("darsay is published to [PyPI](https://pypi.org/project/darsay/). Install it.")).toBe("darsay is published to PyPI. Install it.");
	});

	it("gives every line in the file a whole sentence or no note at all", () => {
		for (const l of buildLlmsTxt().split("\n")) {
			const m = LINK.exec(l);
			if (m?.[3]) expect(m[3], l).toMatch(/[.!?]$/);
		}
	});
});
