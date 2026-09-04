import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTarget, shaFromSibling } from "./bump-docs-lock.mjs";

describe("resolveTarget", () => {
	it("peels an annotated sibling tag to a commit", async () => {
		const sha = shaFromSibling("v0.10.0");
		if (!sha) return;
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		const got = await resolveTarget("v0.10.0");
		expect(got.ref).toBe("v0.10.0");
		expect(got.sha).toBe(sha);
		expect(got.repo).toBe("darsay-io/darsay");
	});

	it("rejects a non-semver tag", async () => {
		await expect(resolveTarget("main")).rejects.toThrow(/vX\.Y\.Z/);
	});

	it("pins a full sibling commit without requiring a release or network", async () => {
		const sha = shaFromSibling("HEAD");
		if (!sha) return;
		const got = await resolveTarget(sha, { fetchImpl: () => { throw new Error("unexpected network"); } });
		expect(got).toEqual({ repo: "darsay-io/darsay", ref: sha, sha });
	});

	it("resolves full remote commits exactly", async () => {
		const sha = "b".repeat(40);
		const got = await resolveTarget(sha, {
			fetchImpl: async (url) => {
				expect(String(url)).toBe(`https://api.github.com/repos/darsay-io/darsay/commits/${sha}`);
				return Response.json({ sha });
			},
		});
		expect(got.ref).toBe(sha);
		expect(got.sha).toBe(sha);
	});

	it("rejects abbreviated, symbolic, and mismatched commit pins", async () => {
		for (const ref of ["1234abc", "HEAD", "v0.10.0^{commit}"]) {
			await expect(resolveTarget(ref)).rejects.toThrow(/full lowercase commit SHA/);
		}
		await expect(resolveTarget("b".repeat(40), {
			fetchImpl: async () => Response.json({ sha: "a".repeat(40) }),
		})).rejects.toThrow(/expected commit SHA/);
	});

	it("uses GitHub when asked, without touching git", async () => {
		const fetchImpl = async (url) => {
			if (String(url).includes("/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "v0.10.0" }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (String(url).includes("/commits/v0.10.0")) {
				return new Response(JSON.stringify({ sha: "a".repeat(40) }), {
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("no", { status: 404 });
		};
		const got = await resolveTarget(null, {
			repo: "darsay-io/darsay",
			fetchImpl,
		});
		expect(got.ref).toBe("v0.10.0");
		// Sibling wins when the tag exists locally.
		if (shaFromSibling("v0.10.0")) {
			expect(got.sha).toBe(shaFromSibling("v0.10.0"));
		} else {
			expect(got.sha).toBe("a".repeat(40));
		}
	});
});

describe("release sync commit-pin guard", () => {
	it.each([
		["b".repeat(40), "", true],
		["v0.14.14", "", false],
		["b".repeat(40), "v0.15.0", false],
	])("handles ref %s and requested tag %s", (ref, requestedTag, held) => {
		const workflow = readFileSync(new URL("../.github/workflows/sync-cli-docs.yml", import.meta.url), "utf8");
		const step = workflow.slice(workflow.indexOf("- name: Resolve CLI tag"));
		const start = step.indexOf("          set -euo pipefail");
		const end = step.indexOf('          if [ -n "${INPUT_TAG}" ]; then');
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const guard = step.slice(start, end).replace(/^          /gm, "");
		const dir = mkdtempSync(join(tmpdir(), "darsay-docs-pin-"));
		try {
			writeFileSync(join(dir, "docs.lock.json"), JSON.stringify({ ref, sha: "b".repeat(40) }));
			const output = join(dir, "output");
			writeFileSync(output, "");
			const stdout = execFileSync("bash", ["-c", `${guard}\necho release-resolution`], {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, INPUT_TAG: requestedTag, GITHUB_OUTPUT: output },
			});
			expect(readFileSync(output, "utf8")).toBe(held ? "current=true\n" : "");
			expect(stdout.includes("release-resolution")).toBe(!held);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
