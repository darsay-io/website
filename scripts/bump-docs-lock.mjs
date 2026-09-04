#!/usr/bin/env node
/**
 * Point docs.lock.json at a CLI release tag or full commit SHA, regenerate Starlight Markdown,
 * and refresh transform snapshots.
 *
 *     node scripts/bump-docs-lock.mjs           # latest GitHub Release
 *     node scripts/bump-docs-lock.mjs v0.10.0
 *     node scripts/bump-docs-lock.mjs <40-character-commit-sha>
 *
 * Prefers a sibling ../darsay git checkout for the commit SHA. Falls back
 * to the GitHub API. Does not deploy the site.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, writeSnapshots } from "./sync-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "docs.lock.json");
const DEFAULT_REPO = "darsay-io/darsay";

export function readLock() {
	return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
}

export function writeLock(lock) {
	fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n");
}

function siblingRepo() {
	const sibling = path.resolve(ROOT, "../darsay");
	return fs.existsSync(path.join(sibling, ".git")) ? sibling : null;
}

export function shaFromSibling(tag, cwd = siblingRepo()) {
	if (!cwd) return null;
	try {
		return execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

async function githubJson(url, fetchImpl = fetch) {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "darsay-io-website",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetchImpl(url, { headers });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`${url} -> ${res.status} ${body.slice(0, 200)}`);
	}
	return res.json();
}

export async function latestReleaseTag(repo = DEFAULT_REPO, fetchImpl = fetch) {
	const data = await githubJson(`https://api.github.com/repos/${repo}/releases/latest`, fetchImpl);
	if (!data.tag_name) throw new Error("GitHub latest release has no tag_name");
	return data.tag_name;
}

export async function shaFromGitHub(repo, ref, fetchImpl = fetch) {
	const data = await githubJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, fetchImpl);
	if (!data.sha) throw new Error(`no commit sha for ${repo}@${ref}`);
	return data.sha;
}

export async function resolveTarget(tag, { repo = DEFAULT_REPO, fetchImpl = fetch } = {}) {
	const ref = tag || (await latestReleaseTag(repo, fetchImpl));
	const commit = /^[0-9a-f]{40}$/.test(ref);
	if (!/^v\d+\.\d+\.\d+$/.test(ref) && !commit) {
		throw new Error(`ref ${JSON.stringify(ref)} is not a vX.Y.Z tag or full lowercase commit SHA`);
	}
	const sha = shaFromSibling(ref) || (await shaFromGitHub(repo, ref, fetchImpl));
	if (!/^[0-9a-f]{40}$/.test(sha) || (commit && sha !== ref)) {
		throw new Error(`ref ${JSON.stringify(ref)} did not resolve to the expected commit SHA`);
	}
	return { repo, ref, sha };
}

export async function bumpDocsLock(tag, opts = {}) {
	const current = readLock();
	const next = await resolveTarget(tag, opts);
	if (current.ref === next.ref && current.sha === next.sha && !opts.force) {
		return { changed: false, lock: current };
	}
	writeLock(next);
	const written = runSync({ check: false });
	writeSnapshots(written);
	return { changed: true, lock: next, written };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const tag = process.argv.slice(2).find((a) => !a.startsWith("-")) || null;
	const force = process.argv.includes("--force");
	const result = await bumpDocsLock(tag, { force });
	if (!result.changed) {
		console.log(`docs.lock.json already at ${result.lock.ref} (${result.lock.sha.slice(0, 12)})`);
	} else {
		console.log(`docs.lock.json -> ${result.lock.ref} ${result.lock.sha}`);
		console.log("synced src/content/docs/docs and scripts/snapshots");
	}
}
