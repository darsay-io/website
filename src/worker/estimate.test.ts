import { describe, expect, it } from "vitest";
import { fetchEstimate } from "./estimate.ts";
import type { HfCanonical } from "./sources.ts";

const hf: HfCanonical = {
	kind: "hf",
	canonical: "huggingface:Qwen/Qwen3-0.6B",
	url: "https://huggingface.co/Qwen/Qwen3-0.6B",
	artifactType: "model",
	locator: "Qwen/Qwen3-0.6B",
};

describe("fetchEstimate", () => {
	it("returns null when the Hub misses", async () => {
		const got = await fetchEstimate(hf, null, async () => new Response("no", { status: 404 }));
		expect(got).toBeNull();
	});

	it("pins the Hub request at the given revision", async () => {
		let url = "";
		await fetchEstimate(hf, "abc123", async (input) => {
			url = String(input);
			return new Response("no", { status: 404 });
		});
		expect(url).toContain("/models/Qwen/Qwen3-0.6B/revision/abc123");
		expect(url).toContain("blobs=true");
	});

	it("projects DIGEST_KEYS and does not invent sizes", async () => {
		const got = await fetchEstimate(hf, null, async () =>
			new Response(
				JSON.stringify({
					sha: "deadbeef",
					gated: false,
					siblings: [{ rfilename: "a.safetensors", size: 100 }, { rfilename: "b.bin", size: null }],
					safetensors: { total: 42, parameters: { BF16: 40, FP32: 2 } },
					cardData: { license: "apache-2.0" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			),
		);
		expect(got).toMatchObject({
			artifact_type: "model",
			revision: "deadbeef",
			revision_ref: "main",
			payload_bytes: 100,
			file_count: 2,
			license: "apache-2.0",
			gated: false,
			parameters: 42,
			dominant_dtype: "BF16",
			unknown_size_count: 1,
		});
		expect(got?.as_of).toMatch(/\+00:00$/);
	});
});
