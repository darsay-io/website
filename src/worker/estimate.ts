import type { EstimateDigest } from "./catalog.ts";
import { dominantFormat, hintsFrom, isWeightFile, type SizedFile } from "./hints.ts";
import type { HfCanonical } from "./sources.ts";
import { asDatasetCanonical } from "./sources.ts";
import { utcNow } from "./validate.ts";

const TIMEOUT_MS = 5000;
const NOT_FOUND = new Set([401, 404]);

type HubInfo = {
	sha?: string;
	gated?: boolean | string;
	siblings?: { rfilename?: string; size?: number | null }[];
	safetensors?: { total?: number; parameters?: Record<string, number> };
	cardData?: { license?: string };
	license?: string;
};

export type EstimateHit = {
	parsed: HfCanonical;
	digest: EstimateDigest;
};

function digestFrom(parsed: HfCanonical, info: HubInfo, revisionRef: string): EstimateDigest {
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
	// The CLI's closed hint vocabulary, on the CLI's rules (hints.ts). A
	// `darsay estimate <board-url>` refresh rewrites this digest, hints included.
	const payloadBytes = siblings.length ? payload : null;
	const weights: SizedFile[] =
		parsed.artifactType === "model"
			? siblings
					.filter((s): s is { rfilename: string; size?: number | null } => typeof s.rfilename === "string")
					.filter((s) => isWeightFile(s.rfilename))
					.map((s) => ({ path: s.rfilename, size: typeof s.size === "number" ? s.size : null }))
			: [];
	const weightsBytes = weights.reduce((n, f) => n + (f.size ?? 0), 0);
	const hints = hintsFrom({
		payloadBytes,
		gated,
		subset: false,
		dominantDtype: dominant,
		dominantFormat: dominantFormat(weights),
		weightsBytes: weights.length ? weightsBytes : null,
		paramsByDtype: keys.length ? byDtype : null,
	});
	return {
		as_of: utcNow(),
		artifact_type: parsed.artifactType,
		revision: info.sha ?? null,
		revision_ref: revisionRef,
		payload_bytes: payloadBytes,
		file_count: siblings.length || null,
		license: info.cardData?.license ?? info.license ?? null,
		gated,
		parameters: typeof info.safetensors?.total === "number" ? info.safetensors.total : null,
		dominant_dtype: dominant,
		unknown_size_count: unknown,
		hints,
	};
}

async function hubInfo(
	kind: "models" | "datasets",
	locator: string,
	revisionRef: string,
	fetchImpl: typeof fetch,
): Promise<{ ok: true; info: HubInfo } | { ok: false; status: number }> {
	const url = `https://huggingface.co/api/${kind}/${locator}/revision/${encodeURIComponent(revisionRef)}?blobs=true`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			signal: ac.signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return { ok: false, status: res.status };
		const info = (await res.json()) as HubInfo;
		return { ok: true, info };
	} catch {
		return { ok: false, status: 0 };
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchEstimate(
	parsed: HfCanonical,
	revision: string | null,
	fetchImpl: typeof fetch = fetch,
): Promise<EstimateHit | null> {
	const rev = revision && revision.length > 0 ? revision : "main";
	if (parsed.artifactType === "dataset") {
		const hit = await hubInfo("datasets", parsed.locator, rev, fetchImpl);
		if (!hit.ok) return null;
		return { parsed, digest: digestFrom(parsed, hit.info, rev) };
	}
	const model = await hubInfo("models", parsed.locator, rev, fetchImpl);
	if (model.ok) return { parsed, digest: digestFrom(parsed, model.info, rev) };
	if (!NOT_FOUND.has(model.status)) return null;
	const dataset = await hubInfo("datasets", parsed.locator, rev, fetchImpl);
	if (!dataset.ok) return null;
	const retargeted = asDatasetCanonical(parsed);
	return { parsed: retargeted, digest: digestFrom(retargeted, dataset.info, rev) };
}
