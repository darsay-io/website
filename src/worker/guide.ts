/**
 * The field guide, served: every chip on a board row is a doorway, and a
 * program deserves the same door. Cards come from `src/lib/primer.ts` —
 * authored copy, the same text the board's dialog shows — with docs links
 * made absolute so an agent can follow them.
 */
import { LENS_BY_KEY, isLensKey } from "../lib/lenses.ts";
import { HINT_PRIMER, PRIMER, PRIMER_BY_KEY, type PrimerCard, type PrimerKey } from "../lib/primer.ts";

export function cardToApi(c: PrimerCard, origin: string) {
	return {
		key: c.key,
		group: c.group,
		title: c.title,
		lede: c.lede,
		body: c.body,
		table: c.table ?? null,
		collect: c.collect,
		cmd: c.cmd ?? null,
		doc: c.doc ? { href: origin + c.doc.href, label: c.doc.label } : null,
		link: c.link ?? null,
		related: c.related,
		lens: c.lens ?? null,
	};
}

/** A card by its key, by a lens key, or by a hint chip's word. */
export function resolveCard(chip: string): PrimerCard | null {
	const word = chip.trim().toLowerCase();
	if (!word) return null;
	if (Object.prototype.hasOwnProperty.call(PRIMER_BY_KEY, word)) return PRIMER_BY_KEY[word as PrimerKey];
	if (isLensKey(word)) return PRIMER_BY_KEY[LENS_BY_KEY[word].primer];
	const viaHint = (HINT_PRIMER as Record<string, PrimerKey | undefined>)[word];
	if (viaHint) return PRIMER_BY_KEY[viaHint];
	return null;
}

export function guideIndex(origin: string) {
	return {
		cards: PRIMER.map((c) => cardToApi(c, origin)),
		chips: [...new Set([...PRIMER.map((c) => c.key), ...Object.keys(HINT_PRIMER), ...Object.keys(LENS_BY_KEY)])].sort(),
		docs: origin + "/docs/board/",
	};
}
