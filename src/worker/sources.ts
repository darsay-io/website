/** Port of darsay.sources.parse_source + HuggingFaceProvider.parse + GitHubProvider.parse. */

const SCHEME = /^([a-z][a-z0-9+.-]*):(?:\/\/)?(.*)$/i;
const HF_HOSTS = new Set(["huggingface.co", "hf.co"]);
const GITHUB_HOSTS = new Set(["github.com"]);
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;
/**
 * URL path segments after owner/repo that carry a revision GitHub's web UI
 * put there; darsay takes revisions on --revision, so these are refused
 * with the command that says the same thing unambiguously.
 */
const GITHUB_REVISION_SEGMENTS = new Set(["tree", "blob", "commit", "commits", "tag"]);

export type HfCanonical = {
	kind: "hf";
	canonical: string;
	url: string;
	artifactType: "model" | "dataset";
	locator: string;
};

/**
 * A GitHub repository: a code bundle — the tree at one commit, payload
 * under `code/`. `github:owner/repo`, `gh:owner/repo`, or the repository
 * URL; the default revision is `HEAD`, whatever the default branch is
 * called. Mirrors `GitHubProvider.parse`.
 */
export type GitHubCanonical = {
	kind: "github";
	canonical: string;
	url: string;
	artifactType: "code";
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

export type CanonicalizeResult = HfCanonical | GitHubCanonical | OpaqueCanonical | HomeCanonical | SourceError;

/** A source with a provider: the two kinds a board can price and the CLI can fetch. */
export type ProviderCanonical = HfCanonical | GitHubCanonical;

export type ArtifactType = "model" | "dataset" | "code";

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

function parseGitHub(locator: string, fromUrl: boolean, original: string): CanonicalizeResult {
	const s = locator.trim().split("?", 1)[0].split("#", 1)[0].replace(/^\/+|\/+$/g, "");
	let parts = s.split("/").filter((p) => p.length > 0);
	if (fromUrl && parts.length > 2) {
		const owner = parts[0];
		const repo = parts[1].replace(/\.git$/, "");
		let ref: string | null = null;
		if (GITHUB_REVISION_SEGMENTS.has(parts[2]) && parts.length > 3) ref = parts[3];
		else if (parts[2] === "releases" && parts.length > 4 && parts[3] === "tag") ref = parts[4];
		if (ref) {
			return {
				kind: "error",
				status: 400,
				error: `${JSON.stringify(original)} names a revision inside the repository URL. Add the repository and put the revision in its own field: github:${owner}/${repo}, revision ${ref}`,
			};
		}
		parts = parts.slice(0, 2);
	}
	if (parts.length !== 2) {
		return {
			kind: "error",
			status: 400,
			error: `cannot parse source ref ${JSON.stringify(original)} — expected github:owner/repo, gh:owner/repo, or a github.com repository URL`,
		};
	}
	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/, "");
	if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
		return {
			kind: "error",
			status: 400,
			error: `cannot parse source ref ${JSON.stringify(original)} — owner and repository names are letters, digits, '-', '_' and '.'`,
		};
	}
	const repoId = `${owner}/${repo}`;
	return {
		kind: "github",
		canonical: `github:${repoId}`,
		url: `https://github.com/${repoId}`,
		artifactType: "code",
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
		if (HF_HOSTS.has(host)) return parseHuggingFace(path, true, s);
		if (GITHUB_HOSTS.has(host)) return parseGitHub(path, true, s);
		return parseHome(s);
	}

	const match = s.match(SCHEME);
	if (match) {
		const scheme = match[1].toLowerCase();
		const locator = match[2];
		if (scheme === "huggingface" || scheme === "hf") {
			return parseHuggingFace(locator, false, locator);
		}
		if (scheme === "github" || scheme === "gh") {
			return parseGitHub(locator, false, s);
		}
		return { kind: "opaque", canonical: s };
	}

	return parseHuggingFace(s, false, s);
}

export function hfUrlFromCanonical(canonical: string): string | null {
	if (!canonical.startsWith("huggingface:")) return null;
	return `https://huggingface.co/${canonical.slice("huggingface:".length)}`;
}

/** The page a canonical source names: a Hub or GitHub repository, or a closed work's own home. */
export function urlFromCanonical(canonical: string): string | null {
	const parsed = canonicalizeSource(canonical);
	if (parsed.kind === "hf" || parsed.kind === "github") return parsed.url;
	if (parsed.kind === "home") return parsed.canonical;
	return null;
}

/** A closed work's address, when the source is one. */
export function isHome(source: string): boolean {
	return canonicalizeSource(source).kind === "home";
}

/** A source darsay can pin and fetch: a Hugging Face or GitHub address. */
export function isProviderSource(parsed: CanonicalizeResult): parsed is ProviderCanonical {
	return parsed.kind === "hf" || parsed.kind === "github";
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

export function artifactTypeFromSource(canonical: string): ArtifactType | null {
	const parsed = canonicalizeSource(canonical);
	if (parsed.kind === "hf" || parsed.kind === "github") return parsed.artifactType;
	return null;
}
