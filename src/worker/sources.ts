/** Port of darsay.sources.parse_source + HuggingFaceProvider.parse. */

const SCHEME = /^([a-z][a-z0-9+.-]*):(?:\/\/)?(.*)$/i;
const HF_HOSTS = new Set(["huggingface.co", "hf.co"]);

export type HfCanonical = {
	kind: "hf";
	canonical: string;
	url: string;
	artifactType: "model" | "dataset";
	locator: string;
};

export type OpaqueCanonical = {
	kind: "opaque";
	canonical: string;
};

/**
 * A closed work: an https page on a host with no provider — an API-only
 * model, an announced release. It holds its place on a board with no
 * price and nothing to fetch; the CLI's `catalog add` accepts the same
 * address. Stored as given, minus fragment and trailing slash.
 */
export type HomeCanonical = {
	kind: "home";
	canonical: string;
	host: string;
};

export type SourceError = {
	kind: "error";
	status: 400;
	error: string;
};

export type CanonicalizeResult = HfCanonical | OpaqueCanonical | HomeCanonical | SourceError;

function parseHome(s: string): CanonicalizeResult {
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return { kind: "error", status: 400, error: "invalid url" };
	}
	if (u.protocol !== "https:") return { kind: "error", status: 400, error: "a home URL must be https" };
	if (u.username || u.password) return { kind: "error", status: 400, error: "invalid url" };
	if (!u.hostname.includes(".")) return { kind: "error", status: 400, error: "invalid url" };
	if (u.pathname === "/" || u.pathname === "") return { kind: "error", status: 400, error: "a home URL needs a path to the work" };
	u.hash = "";
	const canonical = u.toString().replace(/\/+$/, "");
	return { kind: "home", canonical, host: u.hostname.replace(/^www\./, "") };
}

function parseHuggingFace(
	locator: string,
	fromUrl: boolean,
	original: string,
): CanonicalizeResult {
	let s = locator.trim();
	let urlShaped = fromUrl;
	if (s.toLowerCase().startsWith("https://") || s.toLowerCase().startsWith("http://")) {
		let parsed: URL;
		try {
			parsed = new URL(s);
		} catch {
			return { kind: "error", status: 400, error: `cannot parse source ref` };
		}
		let host = parsed.host.toLowerCase();
		if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
		if (host.startsWith("www.")) host = host.slice(4);
		if (!HF_HOSTS.has(host)) {
			return { kind: "error", status: 400, error: `not a Hugging Face URL` };
		}
		s = parsed.pathname.replace(/^\/+/, "");
		urlShaped = true;
	}
	s = s.split("?", 1)[0].split("#", 1)[0].replace(/^\/+|\/+$/g, "");
	let parts = s.split("/").filter((p) => p.length > 0);
	let artifactType: "model" | "dataset" = "model";
	if (parts.length > 0 && parts[0] === "datasets") {
		artifactType = "dataset";
		parts = parts.slice(1);
	}
	if (urlShaped && parts.length > 2) {
		parts = parts.slice(0, 2);
	}
	if (parts.length !== 2) {
		return {
			kind: "error",
			status: 400,
			error: `cannot parse source ref ${JSON.stringify(original)}`,
		};
	}
	const repoId = parts.join("/");
	const path = artifactType === "dataset" ? `datasets/${repoId}` : repoId;
	return {
		kind: "hf",
		canonical: `huggingface:${path}`,
		url: `https://huggingface.co/${path}`,
		artifactType,
		locator: repoId,
	};
}

export function canonicalizeSource(input: string): CanonicalizeResult {
	const s = (input ?? "").trim();
	if (!s) return { kind: "error", status: 400, error: "empty source" };

	const lowered = s.toLowerCase();
	if (lowered.startsWith("https://") || lowered.startsWith("http://")) {
		let host: string;
		let path: string;
		try {
			const u = new URL(s);
			host = u.host.toLowerCase();
			if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
			if (host.startsWith("www.")) host = host.slice(4);
			path = u.pathname.replace(/^\/+/, "");
		} catch {
			return { kind: "error", status: 400, error: "invalid url" };
		}
		if (!HF_HOSTS.has(host)) {
			return parseHome(s);
		}
		return parseHuggingFace(path, true, s);
	}

	const match = s.match(SCHEME);
	if (match) {
		const scheme = match[1].toLowerCase();
		const locator = match[2];
		if (scheme === "huggingface" || scheme === "hf") {
			return parseHuggingFace(locator, false, locator);
		}
		return { kind: "opaque", canonical: s };
	}

	return parseHuggingFace(s, false, s);
}

export function hfUrlFromCanonical(canonical: string): string | null {
	if (!canonical.startsWith("huggingface:")) return null;
	return `https://huggingface.co/${canonical.slice("huggingface:".length)}`;
}

/** A closed work's address, when the source is one. */
export function isHome(source: string): boolean {
	return canonicalizeSource(source).kind === "home";
}

export function asDatasetCanonical(parsed: HfCanonical): HfCanonical {
	if (parsed.artifactType === "dataset") return parsed;
	const path = `datasets/${parsed.locator}`;
	return {
		kind: "hf",
		canonical: `huggingface:${path}`,
		url: `https://huggingface.co/${path}`,
		artifactType: "dataset",
		locator: parsed.locator,
	};
}

export function artifactTypeFromSource(canonical: string): "model" | "dataset" | null {
	const parsed = canonicalizeSource(canonical);
	if (parsed.kind === "hf") return parsed.artifactType;
	return null;
}
