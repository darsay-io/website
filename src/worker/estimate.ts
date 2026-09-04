import type { EstimateDigest, ParentEdge } from "./catalog.ts";
import { dominantFormat, hintsFrom, isWeightFile, type SizedFile } from "./hints.ts";
import { bytesPerParam, precisionFacts } from "./precision.ts";
import { ggufVariants, isProjector, modelWeightBytes } from "./gguf.ts";
import { selectSubset } from "./subset.ts";
import type { HfCanonical } from "./sources.ts";
import { asDatasetCanonical } from "./sources.ts";
import { utcNow } from "./validate.ts";

const TIMEOUT_MS = 5000;
const NOT_FOUND = new Set([401, 404]);
/** config.json is read whole for the precision facts; anything larger is not a config. */
const CONFIG_CAP_BYTES = 1024 * 1024;
/** The Hub's model-tree edge labels, as `base_model:<relation>:<repo>` tags carry them. */
const BASE_MODEL_RELATIONS = ["adapter", "finetune", "merge", "quantized"];

type HubInfo = {
	sha?: string;
	gated?: boolean | string;
	siblings?: { rfilename?: string; size?: number | null }[];
	safetensors?: { total?: number; parameters?: Record<string, number> };
	gguf?: { total?: number; architecture?: string };
	cardData?: { license?: string; base_model?: string | string[]; base_model_relation?: string; datasets?: string | string[] };
	license?: string;
	tags?: string[];
};

function asList(v: unknown): string[] {
	if (typeof v === "string") return v.trim() ? [v] : [];
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
	return [];
}

/**
 * Parent edges as upstream declares them — the port of the CLI's
 * `parents_from_metadata`: the card's `base_model` (with
 * `base_model_relation`), the Hub's `base_model:<relation>:<repo>` tags,
 * and the card's `datasets` as `trained_on` edges. Never guessed.
 */
export function parentsFrom(info: HubInfo): ParentEdge[] | null {
	const card = info.cardData ?? {};
	const cardBases = asList(card.base_model);
	const tagBases: string[] = [];
	const tagRelations = new Map<string, string>();
	for (const tag of info.tags ?? []) {
		if (!tag.startsWith("base_model:")) continue;
		let rest = tag.slice("base_model:".length);
		for (const rel of BASE_MODEL_RELATIONS) {
			if (rest.startsWith(`${rel}:`)) {
				rest = rest.slice(rel.length + 1);
				if (rest) tagRelations.set(rest, rel);
				break;
			}
		}
		if (rest && !tagBases.includes(rest)) tagBases.push(rest);
	}
	const cardRelation = typeof card.base_model_relation === "string" ? card.base_model_relation : null;
	const edges: ParentEdge[] = [];
	const seen = new Set<string>();
	for (const repo of [...cardBases, ...tagBases]) {
		if (seen.has(repo)) continue;
		seen.add(repo);
		edges.push({ source: `huggingface:${repo}`, relation: tagRelations.get(repo) ?? cardRelation });
	}
	for (const ds of asList(card.datasets)) {
		if (seen.has(ds)) continue;
		seen.add(ds);
		edges.push({ source: `huggingface:datasets/${ds}`, relation: "trained_on" });
	}
	return edges.length ? edges : null;
}

export type EstimateHit = {
	parsed: HfCanonical;
	digest: EstimateDigest;
};

function digestFrom(parsed: HfCanonical, info: HubInfo, revisionRef: string, config: unknown, include: string[] | null): EstimateDigest | null {
	const siblings = Array.isArray(info.siblings) ? info.siblings : [];
	const validSize = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
	const files: SizedFile[] = siblings.filter((s) => typeof s.rfilename === "string")
		.map((s) => ({ path: s.rfilename!, size: validSize(s.size) ? s.size : null }));
	const selected = include?.length ? selectSubset(files, include) : files;
	if (!selected) return null;
	let payload = 0;
	let unknown = 0;
	for (const s of selected) {
		if (s.size !== null) payload += s.size;
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
	const payloadBytes = selected.length ? payload : null;
	const weights: SizedFile[] =
		parsed.artifactType === "model"
			? selected.filter((s) => isWeightFile(s.path))
			: [];
	const weightsBytes = weights.reduce((n, f) => n + (f.size ?? 0), 0);
	const fmt = dominantFormat(weights);
	const hints = hintsFrom({
		payloadBytes,
		gated,
		subset: !!include?.length,
		dominantDtype: dominant,
		dominantFormat: fmt,
		weightsBytes: weights.length ? weightsBytes : null,
		paramsByDtype: keys.length ? byDtype : null,
	});
	const stTotal = info.safetensors?.total;
	const ggufTotal = info.gguf?.total;
	const total = validSize(stTotal) && stTotal > 0 ? stTotal : validSize(ggufTotal) && ggufTotal > 0 ? ggufTotal : null;
	const parametersSource = total === null ? null : total === stTotal ? "safetensors" : "gguf";
	const model = parsed.artifactType === "model";
	const modelWeights = weights.filter((w) => !isProjector(w.path));
	const precision = model && (modelWeights.length > 0 || !include?.length)
		? precisionFacts({ config, dominantDtype: dominant, dominantFormat: fmt, weightPaths: modelWeights.map((w) => w.path) })
		: null;
	const cfg = config !== null && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : null;
	return {
		as_of: utcNow(),
		artifact_type: parsed.artifactType,
		revision: info.sha ?? null,
		revision_ref: revisionRef,
		payload_bytes: payloadBytes,
		size_basis: include?.length ? "selection" : "repository",
		repository_bytes: files.length && files.every((f) => f.size !== null) ? files.reduce((n, f) => n + f.size!, 0) : null,
		file_count: selected.length || null,
		license: info.cardData?.license ?? info.license ?? null,
		gated,
		parameters: total,
		parameters_source: parametersSource,
		dominant_dtype: dominant,
		unknown_size_count: unknown,
		hints,
		classification: null,
		gguf_variants: model ? ggufVariants(files) : [],
		precision: precision?.label ?? null,
		bytes_per_param: model ? bytesPerParam(modelWeightBytes(weights), total) : null,
		architecture: cfg && typeof cfg.model_type === "string" ? cfg.model_type : typeof info.gguf?.architecture === "string" ? info.gguf.architecture : null,
		parents: model ? parentsFrom(info) : null,
	};
}

/** The repo's root config.json, when it is small enough to be one; null on any failure. */
async function hubConfig(locator: string, revisionRef: string, siblings: HubInfo["siblings"], fetchImpl: typeof fetch): Promise<unknown> {
	const spec = (siblings ?? []).find((s) => s.rfilename === "config.json");
	if (!spec || (typeof spec.size === "number" && spec.size > CONFIG_CAP_BYTES)) return null;
	const url = `https://huggingface.co/${locator}/resolve/${encodeURIComponent(revisionRef)}/config.json`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { signal: ac.signal, headers: { Accept: "application/json" } });
		if (!res.ok) return null;
		const text = await res.text();
		if (text.length > CONFIG_CAP_BYTES) return null;
		return JSON.parse(text);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
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
	include: string[] | null = null,
	fetchImpl: typeof fetch = fetch,
): Promise<EstimateHit | null> {
	const rev = revision && revision.length > 0 ? revision : "main";
	if (parsed.artifactType === "dataset") {
		const hit = await hubInfo("datasets", parsed.locator, rev, fetchImpl);
		if (!hit.ok) return null;
		const digest = digestFrom(parsed, hit.info, rev, null, include);
		return digest ? { parsed, digest } : null;
	}
	const model = await hubInfo("models", parsed.locator, rev, fetchImpl);
	if (model.ok) {
		const config = await hubConfig(parsed.locator, model.info.sha ?? rev, model.info.siblings, fetchImpl);
		const digest = digestFrom(parsed, model.info, rev, config, include);
		return digest ? { parsed, digest } : null;
	}
	if (!NOT_FOUND.has(model.status)) return null;
	const dataset = await hubInfo("datasets", parsed.locator, rev, fetchImpl);
	if (!dataset.ok) return null;
	const retargeted = asDatasetCanonical(parsed);
	const digest = digestFrom(retargeted, dataset.info, rev, null, include);
	return digest ? { parsed: retargeted, digest } : null;
}
