#!/usr/bin/env node
/**
 * Publish CLI Markdown from a pinned darsay ref into Starlight.
 * Source of truth stays in the CLI repo; this is a transform.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "docs.lock.json");
const OUT_DIR = path.join(ROOT, "src/content/docs/docs");
const SNAPSHOT_DIR = path.join(ROOT, "scripts/snapshots");

const MAP = {
	"GETTING-STARTED.md": "getting-started.mdx",
	"CONCEPTS.md": "concepts.mdx",
	"CATALOGS.md": "catalogs.mdx",
	"SOURCES.md": "sources.mdx",
	"MANIFEST.md": "manifest.mdx",
	"MVB-FORMAT.md": "mvb-format.mdx",
	"HYDRATION.md": "hydration.mdx",
	"INCREMENTAL.md": "incremental.mdx",
	"DATASETS.md": "datasets.mdx",
	"QUANTIZATION.md": "quantization.mdx",
	"DESIGN.md": "design.mdx",
	"DISTRIBUTION.md": "distribution.mdx",
	"TESTING.md": "testing.mdx",
	"README.md": "index.mdx",
};

function slugForMd(name) {
	if (name === "README.md") return "/docs/";
	const stem = name.replace(/\.md$/, "").toLowerCase().replace(/_/g, "-");
	return `/docs/${stem}/`;
}

function stripHtmlNav(md) {
	let s = md;
	s = s.replace(/<p align="center">[\s\S]*?<\/p>\s*/g, "");
	s = s.replace(/<h1 align="center">[\s\S]*?<\/h1>\s*/g, "");
	return s.trimStart();
}

function firstHeading(md) {
	const m = md.match(/^#\s+(.+)$/m);
	return m ? m[1].trim() : null;
}

function firstDescription(md) {
	const bq = md.match(/^>\s+\*\*In one sentence\.\*\*\s*\n(?:>.*\n)*/m);
	if (bq) {
		return bq[0]
			.split("\n")
			.map((l) => l.replace(/^>\s?/, ""))
			.join(" ")
			.replace(/\*\*In one sentence\.\*\*\s*/, "")
			.replace(/\s+/g, " ")
			.trim();
	}
	const para = md.match(/^#.*\n+(?!#|>)(.+)/m);
	return para ? para[1].trim().slice(0, 180) : "";
}

function yamlEscape(s) {
	return JSON.stringify(s);
}

function rewriteLinks(md, sha, repo) {
	return md.replace(/\]\(([^)]+)\)/g, (full, target) => {
		if (/^https?:\/\//i.test(target)) return full;
		const hashIdx = target.indexOf("#");
		const hash = hashIdx >= 0 ? target.slice(hashIdx) : "";
		const file = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
		if (file === "../README.md") {
			return `](https://github.com/${repo}${hash})`;
		}
		if (file === "../CONTRIBUTING.md") {
			return `](https://github.com/${repo}/blob/${sha}/CONTRIBUTING.md${hash})`;
		}
		if (file === "../examples/README.md" || file === "examples/README.md") {
			return `](/docs/examples/${hash})`;
		}
		if (file === "darsay-logo.png" || file === "docs/darsay-logo.png") {
			return `](/darsay-logo.png${hash})`;
		}
		const base = path.posix.basename(file);
		if (base === "README.md" && (file === "README.md" || file.endsWith("/docs/README.md") || file === "../docs/README.md")) {
			return `](/docs/${hash})`;
		}
		if (MAP[base] && (file === base || file.endsWith(`/docs/${base}`) || file === `../docs/${base}` || file === `../${base}`)) {
			const slug = slugForMd(base);
			return `](${slug}${hash.slice(1) ? hash : ""})`.replace(/\/#/, "/#");
		}
		return full;
	});
}

function leftoverMdLinks(md) {
	const bad = [];
	const re = /\]\(([^)]+)\)/g;
	let m;
	while ((m = re.exec(md))) {
		const t = m[1];
		if (/^https?:\/\//i.test(t)) continue;
		const file = t.split("#")[0];
		if (file.endsWith(".md")) bad.push(t);
	}
	return bad;
}

function transform(md, outName, sha, repo) {
	const stripped = stripHtmlNav(md);
	const title =
		outName === "index.mdx" ? firstHeading(stripped) || "Documentation" : firstHeading(stripped) || outName;
	const description = firstDescription(stripped);
	const rewritten = rewriteLinks(stripped, sha, repo);
	const fm = `---\ntitle: ${yamlEscape(title)}\n${description ? `description: ${yamlEscape(description)}\n` : ""}---\n\n`;
	return fm + rewritten;
}

function resolveSourceDir(lock) {
	const envRoot = process.env.DARSAY_DOCS_ROOT;
	if (envRoot && fs.existsSync(path.join(envRoot, "docs"))) return envRoot;
	const sibling = path.resolve(ROOT, "../darsay");
	if (fs.existsSync(path.join(sibling, ".git"))) {
		try {
			execFileSync("git", ["cat-file", "-e", `${lock.sha}^{commit}`], { cwd: sibling });
			return { git: sibling, sha: lock.sha };
		} catch {
			/* fall through */
		}
	}
	if (fs.existsSync(path.join(sibling, "docs/GETTING-STARTED.md"))) {
		return sibling;
	}
	throw new Error("Set DARSAY_DOCS_ROOT to a darsay checkout, or clone darsay-io/darsay next to this repo");
}

function readSourceFile(src, rel) {
	if (src.git) {
		return execFileSync("git", ["show", `${src.sha}:${rel}`], { cwd: src.git, encoding: "utf8" });
	}
	return fs.readFileSync(path.join(src, rel), "utf8");
}

function copyLogo(src) {
	const dest = path.join(ROOT, "public/darsay-logo.png");
	if (src.git) {
		const fd = fs.openSync(dest, "w");
		try {
			execFileSync("git", ["show", `${src.sha}:docs/darsay-logo.png`], {
				cwd: src.git,
				stdio: ["ignore", fd, "pipe"],
			});
		} finally {
			fs.closeSync(fd);
		}
		fs.copyFileSync(dest, path.join(ROOT, "src/assets/darsay-logo.png"));
		return;
	}
	fs.copyFileSync(path.join(src, "docs/darsay-logo.png"), dest);
	fs.copyFileSync(dest, path.join(ROOT, "src/assets/darsay-logo.png"));
}

export function runSync({ check = false } = {}) {
	const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
	const src = resolveSourceDir(lock);
	fs.mkdirSync(OUT_DIR, { recursive: true });
	const written = {};
	for (const [mdName, outName] of Object.entries(MAP)) {
		const rel = `docs/${mdName}`;
		const raw = readSourceFile(src, rel);
		const out = transform(raw, outName, lock.sha, lock.repo);
		const leftover = leftoverMdLinks(out);
		if (leftover.length) {
			throw new Error(`${mdName}: leftover .md links: ${leftover.join(", ")}`);
		}
		written[outName] = out;
	}
	const examples = readSourceFile(src, "examples/README.md");
	const examplesOut = transform(examples, "examples.mdx", lock.sha, lock.repo);
	const leftoverEx = leftoverMdLinks(examplesOut);
	if (leftoverEx.length) {
		throw new Error(`examples/README.md leftover .md links: ${leftoverEx.join(", ")}`);
	}
	written["examples.mdx"] = examplesOut;

	if (check) {
		for (const [name, body] of Object.entries(written)) {
			const onDisk = fs.readFileSync(path.join(OUT_DIR, name), "utf8");
			if (onDisk !== body) throw new Error(`docs tree stale: ${name}`);
		}
		return written;
	}

	for (const f of fs.readdirSync(OUT_DIR)) {
		if (f.endsWith(".mdx")) fs.unlinkSync(path.join(OUT_DIR, f));
	}
	for (const [name, body] of Object.entries(written)) {
		fs.writeFileSync(path.join(OUT_DIR, name), body);
	}
	copyLogo(src);
	return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const check = process.argv.includes("--check");
	runSync({ check });
	if (!check) console.log("synced docs into src/content/docs/docs");
}
