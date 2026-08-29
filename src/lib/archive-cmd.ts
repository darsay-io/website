/** Build a copy-pasteable `darsay archive --next` line from transfer dials. */

export const MAX_GB_STEPS: (number | null)[] = [null, 1, 2, 5, 10, 20, 50, 100];
export const DEFAULT_MAX_GB_INDEX = 4; // 10 GiB — the cookbook "tonight" budget

export const MIN_FREE_STEPS = ["0", "2G", "5G", "10G", "20G", "50G"] as const;
/** CLI default is 2G; omit the flag when the dial sits here. */
export const DEFAULT_MIN_FREE_INDEX = 1;

export const MAX_RATE_STEPS: (string | null)[] = [null, "1M", "5M", "10M", "25M"];
export const DEFAULT_MAX_RATE_INDEX = 0;

export const MAX_MINUTES_STEPS: (number | null)[] = [null, 15, 30, 60, 120];
export const DEFAULT_MAX_MINUTES_INDEX = 0;

export const INSTALL_COMMANDS = {
	pipx: "pipx install darsay",
	brew: "brew install darsay-io/darsay/darsay",
	uvx: "uvx darsay --help",
} as const;

export type InstallFlavor = keyof typeof INSTALL_COMMANDS;

export type DialIndices = {
	maxGb: number;
	minFree: number;
	maxRate: number;
	maxMinutes: number;
};

export const DEFAULT_DIAL_INDICES: DialIndices = {
	maxGb: DEFAULT_MAX_GB_INDEX,
	minFree: DEFAULT_MIN_FREE_INDEX,
	maxRate: DEFAULT_MAX_RATE_INDEX,
	maxMinutes: DEFAULT_MAX_MINUTES_INDEX,
};

export type ArchiveDials = {
	maxGb: number | null;
	/** Null means omit — the CLI default of 2G still applies. */
	minFree: string | null;
	maxRate: string | null;
	maxMinutes: number | null;
};

export function clampIndex(n: number, len: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(len - 1, Math.max(0, Math.round(n)));
}

export function catalogArg(catalogId: string): string {
	return `./${catalogId}.json`;
}

export function dialsFromIndices(i: DialIndices): ArchiveDials {
	const maxGbI = clampIndex(i.maxGb, MAX_GB_STEPS.length);
	const minFreeI = clampIndex(i.minFree, MIN_FREE_STEPS.length);
	const maxRateI = clampIndex(i.maxRate, MAX_RATE_STEPS.length);
	const maxMinutesI = clampIndex(i.maxMinutes, MAX_MINUTES_STEPS.length);
	return {
		maxGb: MAX_GB_STEPS[maxGbI] ?? null,
		minFree: minFreeI === DEFAULT_MIN_FREE_INDEX ? null : MIN_FREE_STEPS[minFreeI],
		maxRate: MAX_RATE_STEPS[maxRateI] ?? null,
		maxMinutes: MAX_MINUTES_STEPS[maxMinutesI] ?? null,
	};
}

export function archiveCommand(catalogFile: string, d: ArchiveDials): string {
	const parts = ["darsay", "archive", "--next", catalogFile];
	if (d.maxGb != null) parts.push("--max-gb", String(d.maxGb));
	if (d.minFree != null) parts.push("--min-free", d.minFree);
	if (d.maxRate != null) parts.push("--max-rate", d.maxRate);
	if (d.maxMinutes != null) parts.push("--max-minutes", String(d.maxMinutes));
	return parts.join(" ");
}

function prettySizeToken(raw: string): string {
	const m = /^(\d+)([GM])$/.exec(raw);
	if (!m) return raw;
	return `${m[1]} ${m[2] === "G" ? "GiB" : "MiB"}`;
}

export function archiveCaption(d: ArchiveDials): string {
	const sentences: string[] = [];
	if (d.maxGb == null && d.maxMinutes == null) {
		sentences.push("The next unfinished source, until the bundle is complete.");
	} else if (d.maxGb != null && d.maxMinutes == null) {
		sentences.push(
			`Tonight: up to ${d.maxGb} GiB of the next unfinished source, then a clean pause. Rerun the same line to continue.`,
		);
	} else if (d.maxGb == null && d.maxMinutes != null) {
		sentences.push(
			`The next unfinished source, pausing after ${d.maxMinutes} minutes. Rerun the same line to continue.`,
		);
	} else {
		sentences.push(
			`Tonight: up to ${d.maxGb} GiB, or ${d.maxMinutes} minutes — whichever comes first. Rerun the same line to continue.`,
		);
	}
	if (d.maxRate) {
		sentences.push(`Link capped at ${prettySizeToken(d.maxRate)}/s.`);
	}
	if (d.minFree === "0") {
		sentences.push("No free-space floor.");
	} else if (d.minFree) {
		sentences.push(`Pause when less than ${prettySizeToken(d.minFree)} remains free.`);
	}
	return sentences.join(" ");
}

export type GaugeKind = "maxGb" | "minFree" | "maxRate" | "maxMinutes";

export const GAUGE_META: Record<GaugeKind, { label: string }> = {
	maxGb: { label: "Download cap" },
	minFree: { label: "Disk floor" },
	maxRate: { label: "Link rate" },
	maxMinutes: { label: "Session" },
};

export function gaugeStepCount(kind: GaugeKind): number {
	if (kind === "maxGb") return MAX_GB_STEPS.length;
	if (kind === "minFree") return MIN_FREE_STEPS.length;
	if (kind === "maxRate") return MAX_RATE_STEPS.length;
	return MAX_MINUTES_STEPS.length;
}

export type GaugeReadout = {
	value: string;
	unit: string;
	aria: string;
};

export function gaugeFillPct(index: number, stepCount: number): number {
	if (stepCount <= 1) return 0;
	const i = clampIndex(index, stepCount);
	return (i / (stepCount - 1)) * 75;
}

export function gaugeReadout(kind: GaugeKind, index: number): GaugeReadout {
	if (kind === "maxGb") {
		const v = MAX_GB_STEPS[clampIndex(index, MAX_GB_STEPS.length)];
		if (v == null) return { value: "∞", unit: "GiB", aria: "unlimited download" };
		return { value: String(v), unit: "GiB", aria: `${v} gigabytes` };
	}
	if (kind === "minFree") {
		const v = MIN_FREE_STEPS[clampIndex(index, MIN_FREE_STEPS.length)];
		if (v === "0") return { value: "off", unit: "floor", aria: "disk floor off" };
		const pretty = prettySizeToken(v);
		return { value: v.replace(/[GM]$/, ""), unit: "GiB", aria: `leave ${pretty} free` };
	}
	if (kind === "maxRate") {
		const v = MAX_RATE_STEPS[clampIndex(index, MAX_RATE_STEPS.length)];
		if (v == null) return { value: "∞", unit: "rate", aria: "unlimited rate" };
		return {
			value: v.replace(/M$/, ""),
			unit: "MiB/s",
			aria: `${prettySizeToken(v)} per second`,
		};
	}
	const v = MAX_MINUTES_STEPS[clampIndex(index, MAX_MINUTES_STEPS.length)];
	if (v == null) return { value: "∞", unit: "min", aria: "no session limit" };
	return { value: String(v), unit: "min", aria: `${v} minutes` };
}
