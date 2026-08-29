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
