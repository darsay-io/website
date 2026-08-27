import type { EstimateDigest } from "./catalog.ts";
import type { HfCanonical } from "./sources.ts";
import { utcNow } from "./validate.ts";

const TIMEOUT_MS = 5000;

type HubInfo = {
	sha?: string;
	gated?: boolean | string;
	siblings?: { rfilename?: string; size?: number | null }[];
	safetensors?: { total?: number; parameters?: Record<string, number> };
	cardData?: { license?: string };
	license?: string;
};

export async function fetchEstimate(
	parsed: HfCanonical,
	revision: string | null,
	fetchImpl: typeof fetch = fetch,
): Promise<EstimateDigest | null> {
	const kind = parsed.artifactType === "dataset" ? "datasets" : "models";
	const rev = revision && revision.length > 0 ? revision : "main";
	const url = `https://huggingface.co/api/${kind}/${parsed.locator}?blobs=true`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			signal: ac.signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return null;
		const info = (await res.json()) as HubInfo;
		const siblings = Array.isArray(info.siblings) ? info.siblings : [];
		let payload = 0;
		let unknown = 0;
		for (const s of siblings) {
			if (typeof s.size === "number") payload += s.size;
			else unknown += 1;
		}
		const byDtype = info.safetensors?.parameters ?? {};
		const keys = Object.keys(byDtype);
		let dominant: string | null = null;
		if (keys.length) {
			dominant = keys.reduce((a, b) => (byDtype[a] >= byDtype[b] ? a : b));
		}
		const gated = info.gated === true || info.gated === "auto" || info.gated === "manual";
		return {
			as_of: utcNow(),
			artifact_type: parsed.artifactType,
			revision: info.sha ?? null,
			revision_ref: rev,
			payload_bytes: siblings.length ? payload : null,
			file_count: siblings.length || null,
			license: info.cardData?.license ?? info.license ?? null,
			gated,
			parameters: typeof info.safetensors?.total === "number" ? info.safetensors.total : null,
			dominant_dtype: dominant,
			unknown_size_count: unknown,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
