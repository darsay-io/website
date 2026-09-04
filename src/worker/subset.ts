/** Repository path selection, matching the CLI's subset.py rules. */
import type { SizedFile } from "./hints.ts";

const SIDECAR_GLOBS = [
	"README", "README.*", "LICENSE", "LICENSE.*", "LICENCE", "LICENCE.*", "COPYING", "COPYING.*",
	"config.json", "generation_config.json", "*.index.json", "tokenizer.json", "tokenizer.model",
	"tokenizer_config.json", "vocab.json", "merges.txt", "special_tokens_map.json", "added_tokens.json",
	"chat_template*", "preprocessor_config.json", "video_preprocessor_config.json", "spiece.model",
	"tiktoken.model", "*.tiktoken", "*.py", "dataset_infos.json",
];

/** fnmatch-style globs: stars and question marks also match slashes. */
export function globMatches(path: string, pattern: string): boolean {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") re += "[\\s\\S]*";
		else if (c === "?") re += "[\\s\\S]";
		else if (c === "[") {
			let end = i + 1;
			if (pattern[end] === "!") end++;
			if (pattern[end] === "]") end++;
			while (end < pattern.length && pattern[end] !== "]") end++;
			if (end >= pattern.length) re += "\\[";
			else {
				let chars = pattern.slice(i + 1, end);
				const negate = chars.startsWith("!");
				if (negate) chars = chars.slice(1);
				chars = chars.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
				if (chars.startsWith("^")) chars = "\\" + chars;
				re += "[" + (negate ? "^" : "") + chars + "]";
				i = end;
			}
		} else re += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	}
	try { return new RegExp(re + "(?![\\s\\S])").test(path); } catch { return false; }
}

export function matchesInclude(path: string, patterns: string[]): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return patterns.some((pattern) => pattern.startsWith("/")
		? globMatches(path, pattern.slice(1))
		: globMatches(path, pattern) || globMatches(name, pattern));
}

export function isSidecar(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	return SIDECAR_GLOBS.some((pattern) => globMatches(name, pattern.toLowerCase()));
}

/** No match leaves the estimate unknown; sidecars alone cannot satisfy a selector. */
export function selectSubset(files: SizedFile[], include: string[]): SizedFile[] | null {
	if (!files.some((f) => matchesInclude(f.path, include))) return null;
	return files.filter((f) => matchesInclude(f.path, include) || isSidecar(f.path));
}
