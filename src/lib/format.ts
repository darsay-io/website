/** Dates and counts for the board chrome. Deterministic (UTC), no locale. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `28 Aug 2026`, or the input untouched when it does not parse. */
export function prettyDate(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	const d = new Date(t);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `just now`, `4 min ago`, `yesterday`, `12 days ago`, then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso;
	const s = Math.round((now - t) / 1000);
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return m === 1 ? "a minute ago" : `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
	const d = Math.round(h / 24);
	if (d === 1) return "yesterday";
	if (d < 30) return `${d} days ago`;
	return prettyDate(iso);
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
