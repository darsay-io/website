import { artifactTypeFromSource, canonicalizeSource, hfUrlFromCanonical } from "../worker/sources.ts";
import {
	DEFAULT_DIAL_INDICES,
	GAUGE_META,
	INSTALL_COMMANDS,
	archiveCaption,
	archiveCommand,
	catalogArg,
	dialsFromIndices,
	gaugeFillPct,
	gaugeReadout,
	gaugeStepCount,
	type DialIndices,
	type GaugeKind,
	type InstallFlavor,
} from "./archive-cmd.ts";
import {
	codeLines,
	confirmDialog,
	copyOrSelect,
	copyText,
	el,
	flashCopied,
	inline,
	reducedMotion,
	roman,
	termDots,
	toast,
} from "./dom.ts";
import { plural, prettyDate, relativeTime } from "./format.ts";
import { createGuide, type Guide } from "./guide.ts";
import {
	LENSES,
	LENS_BY_KEY,
	applyLenses,
	effectiveHints,
	formatView,
	inFlight,
	isAbliterated,
	isBaseModel,
	isSpeculator,
	lensCounts,
	lensCountsGiven,
	moeFromName,
	parseView,
	tally,
	type LensKey,
	type SortKey,
} from "./lenses.ts";
import { HINT_PRIMER, type PrimerKey } from "./primer.ts";
import { deriveRecipes, humanParams, humanSize, type Recipe } from "./recipes.ts";

type Entry = {
	id: number;
	source: string;
	revision: string | null;
	include: string[] | null;
	desire: number | null;
	note: string | null;
	status: "want" | "have";
	holders: string;
	added: string;
	payload_bytes: number | null;
	artifact_type?: string | null;
	gated?: boolean | null;
	parameters?: number | null;
	dominant_dtype?: string | null;
	hints?: string[];
	policy?: string | null;
	claim?: {
		client: string;
		state: "archiving" | "paused" | "done";
		percent: number | null;
		banked_bytes: number | null;
		total_bytes: number | null;
		claimed_at: string;
		updated: string;
	} | null;
};

type Board = {
	id: string;
	catalog_id: string;
	title: string;
	curator: string | null;
	note: string | null;
	created: string;
	updated: string;
	entries: Entry[];
};

function fitTextarea(n: HTMLTextAreaElement) {
	n.style.height = "auto";
	n.style.height = `${Math.max(n.scrollHeight, 44)}px`;
}

function area(attrs: Record<string, string>, value: string): HTMLTextAreaElement {
	const n = el("textarea", attrs);
	n.value = value;
	n.addEventListener("input", () => fitTextarea(n));
	queueMicrotask(() => fitTextarea(n));
	return n;
}

async function api(path: string, init?: RequestInit) {
	const res = await fetch(path, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = { error: text };
	}
	if (!res.ok) {
		const err = (body as { error?: string })?.error || res.statusText;
		throw new Error(err);
	}
	return body;
}

/** API error strings, as a person would hear them. */
function humanError(msg: string): string {
	const known: Record<string, string> = {
		not_found: "That board is gone.",
		conflict: "That source is already on the list.",
		entry_cap: "The list is full.",
		mutate_cap: "The board is resting — too many edits today. Try again tomorrow.",
		lookup_cap: "Too many lookups today. Try again tomorrow.",
		quota: "The ledger could not be written. Try again in a moment.",
		"invalid source": "That does not look like a source. Try owner/name or a Hugging Face URL.",
		"field too long": "That is too long for the field.",
	};
	return known[msg] ?? msg;
}

/** No hover: a phone. The `?` shortcut and hover titles are for keyboards. */
const hasKeyboard = () => typeof window === "undefined" || !window.matchMedia?.("(hover: none)").matches;

export function mountCreate(root: HTMLElement) {
	const title = el("input", {
		type: "text",
		placeholder: "Summer 2026",
		maxlength: "120",
		id: "board-title",
	});
	const password = el("input", {
		type: "password",
		placeholder: "Shared create password",
		autocomplete: "off",
		spellcheck: "false",
		id: "board-password",
	});
	const status = el("p", { class: "muted" });
	const urlBox = el("p", { class: "board-url" });
	const copyBtn = el("button", { type: "button", class: "btn secondary" }, "Copy URL");
	const ackBox = el("input", { type: "checkbox" });
	const ack = el("label", { class: "ack" }, ackBox, el("span", {}, "I have copied this URL. Losing it loses the board."));
	const go = el("a", { href: "#", class: "btn" }, "Open board");
	go.hidden = true;
	const result = el("div", { class: "create-result" }, urlBox, copyBtn, ack, go);
	result.hidden = true;

	const form = el("form", { class: "create-form" });
	const submit = el("button", { type: "submit", class: "btn" }, "Create a board");
	form.append(
		el("label", { class: "field" }, el("span", {}, "Title"), title),
		el("label", { class: "field" }, el("span", {}, "Create password"), password),
		submit,
		status,
		result,
	);
	form.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		submit.disabled = true;
		status.textContent = "Creating…";
		try {
			const body = (await api("/api/boards", {
				method: "POST",
				body: JSON.stringify({ title: title.value, password: password.value }),
			})) as { url: string };
			urlBox.textContent = body.url;
			result.hidden = false;
			copyBtn.onclick = async () => {
				if (await copyText(body.url)) flashCopied(copyBtn);
			};
			ackBox.addEventListener("change", () => {
				go.hidden = !ackBox.checked;
				go.setAttribute("href", body.url);
			});
			go.hidden = true;
			status.textContent = "Copy this URL. It is the only way back.";
			submit.hidden = true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : "failed";
			status.textContent =
				msg === "unauthorized" ? "Wrong create password." : msg === "create_disabled" ? "Board create is off." : msg;
			submit.disabled = false;
		}
	});
	root.append(form);
}

export function entryArtifactType(e: Pick<Entry, "source" | "artifact_type">): string {
	if (e.artifact_type === "dataset" || e.artifact_type === "model") return e.artifact_type;
	return artifactTypeFromSource(e.source) ?? "—";
}

export function compareEntries(a: Entry, b: Entry, key: SortKey, dir: "asc" | "desc"): number {
	let cmp = 0;
	if (key === "desire" || key === "size") {
		const av = key === "desire" ? a.desire : a.payload_bytes;
		const bv = key === "desire" ? b.desire : b.payload_bytes;
		if (av === null && bv === null) cmp = 0;
		else if (av === null) return 1;
		else if (bv === null) return -1;
		else cmp = av - bv;
	} else if (key === "source") {
		cmp = a.source.localeCompare(b.source);
	} else if (key === "type") {
		cmp = entryArtifactType(a).localeCompare(entryArtifactType(b));
	} else {
		cmp = (a.status === "have" ? 1 : 0) - (b.status === "have" ? 1 : 0);
	}
	if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
	return a.id - b.id;
}

/** Which field-guide card a recipe-card fact opens, if any. */
export function factPrimer(fact: string): PrimerKey | null {
	if (/^pin /.test(fact)) return "pin";
	if (fact === "gated") return "gated";
	if (/\bglobs?$/.test(fact)) return "subset";
	if (fact === "dataset") return "dataset";
	if (fact === "model") return "bundle";
	if (/^\d[\d.]*[BM]\b/.test(fact)) return "dtype";
	if (/before --include$/.test(fact)) return "subset";
	if (/\b(GiB|TiB)$/.test(fact)) return "large";
	return null;
}

type GaugeRef = {
	kind: GaugeKind;
	face: HTMLElement;
	value: HTMLElement;
	unit: HTMLElement;
	input: HTMLInputElement;
};

type Target = "file" | "url";

const DEFAULT_SORT: { sort: SortKey; dir: "asc" | "desc" } = { sort: "desire", dir: "desc" };
const HINT_KEY = "darsay:board:guide-hint";

export async function mountBoard(root: HTMLElement, id: string) {
	root.replaceChildren(
		el("p", { class: "board-loading" }, el("span", { class: "loading-rule", "aria-hidden": "true" }), "Opening the ledger…"),
	);
	let board: Board;
	try {
		board = (await api(`/api/boards/${id}`)) as Board;
	} catch {
		const p = el("p", { class: "board-missing" });
		p.append(
			el("strong", {}, "Board not found."),
			" Check the URL — it is the whole key. ",
			el("a", { href: "/boards" }, "Create a new one"),
			".",
		);
		root.replaceChildren(p);
		return;
	}

	const initial = parseView(location.hash);
	let sortKey: SortKey = initial.sort ?? DEFAULT_SORT.sort;
	let sortDir: "asc" | "desc" = initial.dir ?? DEFAULT_SORT.dir;
	let lenses: LensKey[] = initial.lenses;
	let dials: DialIndices = { ...DEFAULT_DIAL_INDICES };
	let target: Target = "file";
	let installFlavor: InstallFlavor = "pipx";
	let howOpen = true;
	let archiveLive: { cmd: HTMLElement; caption: HTMLElement; gauges: GaugeRef[]; label: HTMLElement } | null = null;
	let installLive: HTMLElement | null = null;
	let idsLive: HTMLElement | null = null;
	const openRecipes = new Set<number>();
	let firstPaint = true;
	let stickyWatch: IntersectionObserver | null = null;
	/** Entry writes go one at a time, so a note blur and a Have click cannot race. */
	let writes: Promise<unknown> = Promise.resolve();

	const shells = {
		toolbar: el("div", { class: "ledger-toolbar" }),
		caption: el("div", { class: "lens-caption-slot" }),
		ledger: el("div", { class: "ledger" }),
	};

	const guide: Guide = createGuide({
		lensCount: (key) => lensCounts(board.entries).get(key) ?? 0,
		showLens: (key) => {
			lenses = [key];
			syncHash();
			paintLedger();
			shells.toolbar.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
			shells.toolbar.querySelector<HTMLElement>(".lens-chip.is-active")?.focus({ preventScroll: true });
		},
	});

	function openGuide(key: PrimerKey, from?: HTMLElement | null, row?: Entry | null) {
		guide.open(key, from ?? null, row ?? null);
	}

	/** A chip that opens a field-guide card, applied to its row. */
	function teachChip(text: string, key: PrimerKey, cls: string, row: Entry, title?: string): HTMLButtonElement {
		const b = el("button", { type: "button", class: `chip ${cls}`, title: title ?? `What “${text}” means — the field guide, applied to this row` }, text);
		b.addEventListener("click", () => openGuide(key, b, row));
		return b;
	}

	function syncHash() {
		const hash = formatView({ lenses, sort: sortKey, dir: sortDir }, DEFAULT_SORT);
		const url = `${location.pathname}${location.search}${hash}`;
		if (`${location.pathname}${location.search}${location.hash}` !== url) history.replaceState(null, "", url);
	}

	window.addEventListener("hashchange", () => {
		const v = parseView(location.hash);
		lenses = v.lenses;
		sortKey = v.sort ?? DEFAULT_SORT.sort;
		sortDir = v.dir ?? DEFAULT_SORT.dir;
		paintLedger();
	});

	document.addEventListener("keydown", (ev) => {
		if (ev.key !== "?" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
		const t = ev.target as HTMLElement | null;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
		if (document.querySelector("dialog[open]")) return;
		ev.preventDefault();
		openGuide("masters");
	});

	function hintSeen(): boolean {
		try {
			return localStorage.getItem(HINT_KEY) === "1";
		} catch {
			return true;
		}
	}
	function markHintSeen() {
		try {
			localStorage.setItem(HINT_KEY, "1");
		} catch {
			/* private mode: the hint just shows again next time */
		}
	}

	/** Remember which field has focus, so a repaint can hand it back. */
	function focusMemo(): { entry: string; field: string; start: number | null } | null {
		const a = document.activeElement as HTMLElement | null;
		if (!a || !a.dataset.entry || !a.dataset.field) return null;
		const start = a instanceof HTMLInputElement && a.type === "text" ? a.selectionStart : null;
		return { entry: a.dataset.entry, field: a.dataset.field, start };
	}
	function focusRestore(memo: ReturnType<typeof focusMemo>) {
		if (!memo) return;
		const n = shells.ledger.querySelector<HTMLElement>(`[data-entry="${memo.entry}"][data-field="${memo.field}"]`);
		if (!n) return;
		n.focus({ preventScroll: true });
		if (memo.start !== null && n instanceof HTMLInputElement) {
			try {
				n.setSelectionRange(memo.start, memo.start);
			} catch {
				/* number inputs refuse; fine */
			}
		}
	}

	async function patchBoard(body: Record<string, unknown>) {
		try {
			const res = (await api(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify(body) })) as {
				updated?: string;
				catalog_id?: string;
			};
			if (typeof body.title === "string") board.title = body.title;
			if (typeof body.curator === "string") board.curator = body.curator || null;
			if (typeof body.note === "string") board.note = body.note || null;
			if (res.updated) board.updated = res.updated;
			if (res.catalog_id) board.catalog_id = res.catalog_id;
			paintIds();
			paintArchive();
			toast("Saved");
		} catch (e) {
			toast(humanError(e instanceof Error ? e.message : "failed"), "error");
		}
	}

	/** Write one field, merge the row the API returns, and repaint the ledger without losing focus. */
	function patchEntry(eid: number, body: Record<string, unknown>): Promise<void> {
		const run = async () => {
			try {
				const updated = (await api(`/api/boards/${id}/entries/${eid}`, { method: "PATCH", body: JSON.stringify(body) })) as Entry;
				const i = board.entries.findIndex((e) => e.id === eid);
				if (i >= 0) board.entries[i] = updated;
				board.updated = new Date().toISOString();
				const memo = focusMemo();
				paintLedger();
				focusRestore(memo);
				paintIds();
				toast("Saved");
			} catch (e) {
				toast(humanError(e instanceof Error ? e.message : "failed"), "error");
			}
		};
		writes = writes.then(run, run);
		return writes as Promise<void>;
	}

	async function reload() {
		await writes;
		board = (await api(`/api/boards/${id}`)) as Board;
		render();
	}

	async function downloadCatalog() {
		const res = await fetch(`/api/boards/${id}/catalog.json`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		if (!res.ok) {
			toast("The catalog could not be fetched.", "error");
			return;
		}
		const blob = await res.blob();
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${board.catalog_id}.json`;
		a.rel = "noreferrer";
		a.click();
		URL.revokeObjectURL(a.href);
		toast(`Saved ${board.catalog_id}.json`);
	}

	function boardUrl(): string {
		return `${location.origin}/b/${id}`;
	}

	function currentTarget(): string {
		return target === "url" ? boardUrl() : catalogArg(board.catalog_id);
	}

	function currentCommand(): string {
		return archiveCommand(currentTarget(), dialsFromIndices(dials));
	}

	function currentCaption(): string {
		const base = archiveCaption(dialsFromIndices(dials));
		return target === "url"
			? `${base} Straight from this board: the CLI claims the row it picks and reports progress here, so the others see it is taken.`
			: `${base} From the downloaded catalog; nothing is reported back to the board.`;
	}

	function paintArchive() {
		if (!archiveLive) return;
		const d = dialsFromIndices(dials);
		archiveLive.cmd.textContent = archiveCommand(currentTarget(), d);
		archiveLive.caption.textContent = currentCaption();
		archiveLive.label.textContent = target === "url" ? "tonight’s fetch · from the board" : "tonight’s fetch · from the file";
		for (const g of archiveLive.gauges) {
			const idx = dials[g.kind];
			const r = gaugeReadout(g.kind, idx);
			g.value.textContent = r.value;
			g.unit.textContent = r.unit;
			g.face.style.setProperty("--pct", String(gaugeFillPct(idx, gaugeStepCount(g.kind))));
			g.input.setAttribute("aria-valuetext", r.aria);
			if (g.input.value !== String(idx)) g.input.value = String(idx);
		}
		if (installLive) installLive.textContent = INSTALL_COMMANDS[installFlavor];
	}

	function makeGauge(kind: GaugeKind): { root: HTMLElement; ref: GaugeRef } {
		const meta = GAUGE_META[kind];
		const steps = gaugeStepCount(kind);
		const idx = dials[kind];
		const r = gaugeReadout(kind, idx);
		const value = el("span", { class: "gauge-value" }, r.value);
		const unit = el("span", { class: "gauge-unit" }, r.unit);
		const face = el(
			"div",
			{ class: "gauge-face", "aria-hidden": "true" },
			el("div", { class: "gauge-core" }, value, unit),
		);
		face.style.setProperty("--pct", String(gaugeFillPct(idx, steps)));
		const input = el("input", {
			type: "range",
			min: "0",
			max: String(steps - 1),
			step: "1",
			value: String(idx),
			"aria-label": meta.label,
			"aria-valuetext": r.aria,
		});
		input.addEventListener("input", () => {
			dials = { ...dials, [kind]: Number(input.value) };
			paintArchive();
		});
		const rootEl = el("label", { class: "gauge" }, el("span", { class: "gauge-kicker" }, meta.label), face, input);
		return { root: rootEl, ref: { kind, face, value, unit, input } };
	}

	function renderBringHome(): HTMLElement {
		const section = el("section", { class: "bring-home", "aria-labelledby": "bring-title" });
		section.append(
			el("p", { class: "bring-kicker" }, "From this list → your vault"),
			el("h2", { id: "bring-title" }, "Bring it home"),
			el(
				"p",
				{ class: "bring-lede" },
				"This site never holds weights. Point darsay at this board — or at the downloaded catalog — and it archives the next unfinished source onto your machine.",
			),
		);

		const cmd = el("code", { class: "cmd-text", "aria-live": "polite" }, currentCommand());
		const copy = el("button", { type: "button", class: "btn compact cmd-copy" }, "Copy");
		copy.addEventListener("click", () => void copyOrSelect(copy, currentCommand(), cmd));
		const label = el("span", { class: "cmd-label" }, "tonight’s fetch");
		const targets = el("div", { class: "install-switch cmd-target", role: "group", "aria-label": "Point darsay at" });
		for (const t of ["url", "file"] as Target[]) {
			const b = el("button", { type: "button", class: "install-pill" }, t === "url" ? "this board" : "the file");
			b.setAttribute("aria-pressed", t === target ? "true" : "false");
			b.addEventListener("click", () => {
				target = t;
				for (const child of targets.querySelectorAll("button")) {
					child.setAttribute("aria-pressed", child === b ? "true" : "false");
				}
				paintArchive();
			});
			targets.append(b);
		}
		const chrome = el("div", { class: "cmd-chrome" }, termDots(), label, targets, copy);
		const stageEl = el("div", { class: "cmd-stage" }, chrome, el("pre", {}, cmd));

		const dl = el("button", { type: "button", class: "btn bring-download" });
		dl.append(
			el("span", { class: "bring-dl-kicker" }, "Download catalog"),
			el("span", { class: "bring-dl-file" }, `${board.catalog_id}.json`),
		);
		dl.addEventListener("click", () => downloadCatalog());

		const cmdRow = el("div", { class: "cmd-row" }, stageEl, dl);
		const caption = el("p", { class: "cmd-caption" }, currentCaption());

		const gauges: GaugeRef[] = [];
		const gaugeRow = el("div", { class: "gauges" });
		for (const kind of ["maxGb", "minFree", "maxRate", "maxMinutes"] as GaugeKind[]) {
			const g = makeGauge(kind);
			gauges.push(g.ref);
			gaugeRow.append(g.root);
		}

		archiveLive = { cmd, caption, gauges, label };

		const details = el("details", { class: "bring-how" });
		details.open = howOpen;
		details.addEventListener("toggle", () => {
			howOpen = details.open;
		});
		const summary = el("summary", {}, "How this works");

		const flavors = el("div", { class: "install-switch", role: "group", "aria-label": "Install method" });
		const installCode = el("code", {}, INSTALL_COMMANDS[installFlavor]);
		installLive = installCode;
		for (const flavor of ["pipx", "brew", "uvx"] as InstallFlavor[]) {
			const b = el("button", { type: "button", class: "install-pill" }, flavor);
			b.setAttribute("aria-pressed", flavor === installFlavor ? "true" : "false");
			b.addEventListener("click", () => {
				installFlavor = flavor;
				for (const child of flavors.querySelectorAll("button")) {
					child.setAttribute("aria-pressed", child === b ? "true" : "false");
				}
				installCode.textContent = INSTALL_COMMANDS[flavor];
			});
			flavors.append(b);
		}

		const step2 = el("p", {});
		step2.append(
			"Paste the command with ",
			el("em", {}, "this board"),
			" and the CLI claims the row it picks, so the gauge and In flight appear here for everyone. Or download the catalog and run it from ",
			el("em", {}, "the file"),
			" — the same want-list, nothing reported back. Either way the URL is this board's key: keep it out of shared shell histories.",
		);
		const steps = el("ol", { class: "bring-steps" });
		steps.append(
			el(
				"li",
				{},
				el("span", { class: "step-n" }, "1"),
				el("div", {}, el("strong", {}, "Install darsay"), flavors, el("pre", { class: "install-cmd" }, installCode)),
			),
			el("li", {}, el("span", { class: "step-n" }, "2"), el("div", {}, el("strong", {}, "Point it at the board, or the file"), step2)),
			el(
				"li",
				{},
				el("span", { class: "step-n" }, "3"),
				el(
					"div",
					{},
					el("strong", {}, "Run it, then rerun it"),
					el("p", {}, "The dials rewrite the flags. Interrupt any time; the same line resumes the same pin until every file verifies."),
				),
			),
		);

		const more = el("p", { class: "bring-more muted" }, "Upstream is Hugging Face. ");
		more.append(el("a", { href: "/docs/getting-started/" }, "Full walkthrough"), " · ");
		more.append(el("a", { href: "/docs/examples/#keep-a-darsayio-board-honest" }, "Keep a board honest"), " · ");
		const fg = el("button", { type: "button", class: "linkish" }, "✦ Field guide");
		fg.addEventListener("click", () => openGuide("masters", fg));
		more.append(fg);

		details.append(summary, steps, more);
		section.append(cmdRow, caption, gaugeRow, details);
		return section;
	}

	function spellList(recipes: Recipe[], offset: number): HTMLElement {
		const ol = el("ol", { class: "spells" });
		recipes.forEach((r, i) => {
			const text = r.lines.join("\n");
			const code = codeLines(r.lines);
			const copy = el("button", { type: "button", class: "btn compact cmd-copy" }, "Copy");
			copy.addEventListener("click", () => void copyOrSelect(copy, text, code));
			const stageEl = el(
				"div",
				{ class: "cmd-stage" },
				el("div", { class: "cmd-chrome" }, termDots(), el("span", { class: "cmd-label" }, r.label), copy),
				el("pre", {}, code),
			);
			const foot = el("p", { class: "spell-foot" });
			if (r.doc) {
				foot.append(el("a", { class: "spell-doc", href: r.doc.href, target: "_blank", rel: "noreferrer" }, r.doc.label));
			}
			if (r.download) {
				const dl = el("button", { type: "button", class: "btn compact secondary spell-dl" }, `Download ${board.catalog_id}.json`);
				dl.addEventListener("click", () => downloadCatalog());
				foot.append(dl);
			}
			const li = el(
				"li",
				{ class: "spell" },
				el("span", { class: "spell-n", "aria-hidden": "true" }, roman(offset + i)),
				el("h4", {}, r.title),
				el("p", { class: "spell-why" }, r.why),
				stageEl,
			);
			if (foot.childNodes.length) li.append(foot);
			ol.append(li);
		});
		return ol;
	}

	/** The recipe card for one entry. Static: derived from the row's fields and this page's URL, no fetch. */
	function buildGrimoire(e: Entry): Node[] {
		const set = deriveRecipes(e, board.catalog_id, boardUrl());
		const facts = el("ul", { class: "grim-facts" });
		for (const f of set.facts) {
			const key = factPrimer(f);
			if (key) {
				const b = el("button", { type: "button", class: "grim-fact-btn", title: "Open in the field guide" }, f);
				b.addEventListener("click", () => openGuide(key, b, e));
				facts.append(el("li", {}, b));
			} else {
				facts.append(el("li", {}, f));
			}
		}
		const head = el(
			"header",
			{ class: "grim-head" },
			el(
				"p",
				{ class: "grim-kicker" },
				el("span", { "aria-hidden": "true" }, "✦ "),
				"Recipes for ",
				el("span", { class: "grim-source" }, e.source),
			),
			el("h3", { class: "grim-title" }, set.headline),
			facts,
			el("p", { class: "grim-verdict" }, set.verdict),
		);
		const out: Node[] = [head, spellList(set.hero, 0)];
		if (set.more.length) {
			const more = el("details", { class: "grim-more" });
			more.append(
				el("summary", {}, set.more.length === 1 ? "One more way" : `${set.more.length} more ways`),
				spellList(set.more, set.hero.length),
			);
			out.push(more);
		}
		return out;
	}

	/** The % complete gauge for a row a client has claimed and is fetching. */
	function renderClaim(e: Entry): HTMLElement | null {
		const claim = e.claim;
		if (!claim || claim.state === "done") return null;
		let pct = typeof claim.percent === "number" ? claim.percent : null;
		if (pct === null && claim.banked_bytes !== null && claim.total_bytes) {
			pct = Math.floor((claim.banked_bytes / claim.total_bytes) * 100);
		}
		const clamped = pct === null ? null : Math.max(0, Math.min(100, pct));
		const fill = el("div", { class: "claim-fill" });
		fill.style.width = `${clamped ?? 4}%`;
		const track = el(
			"div",
			{
				class: clamped === null ? "claim-track claim-indeterminate" : "claim-track",
				role: "progressbar",
				"aria-label": `Archive progress for ${e.source}`,
				...(clamped === null ? {} : { "aria-valuenow": String(clamped), "aria-valuemin": "0", "aria-valuemax": "100" }),
			},
			fill,
		);
		const verb = claim.state === "paused" ? "paused at" : "fetching";
		const bytes =
			claim.banked_bytes !== null && claim.total_bytes
				? ` · ${humanSize(claim.banked_bytes)} of ${humanSize(claim.total_bytes)}`
				: "";
		const since = claim.updated ? ` · reported ${relativeTime(claim.updated)}` : "";
		const why = el("button", { type: "button", class: "claim-why", "aria-label": "What is a claim?" }, "✦");
		why.addEventListener("click", () => openGuide("claims", why, e));
		const label = el(
			"div",
			{ class: "claim-label" },
			el("span", { class: "claim-client" }, claim.client),
			el("span", {}, ` ${verb}${clamped === null ? "" : ` ${clamped}%`}${bytes}${since}`),
			why,
		);
		return el("div", { class: "claim-gauge" }, track, label);
	}

	/** `huggingface:` `Owner/` `Name` as three tones, so the name reads first. */
	function sourceLabel(source: string): Node[] {
		const parsed = canonicalizeSource(source);
		if (parsed.kind !== "hf") return [el("span", { class: "src-name" }, source)];
		const prefix = parsed.artifactType === "dataset" ? "huggingface:datasets/" : "huggingface:";
		const [owner, ...rest] = parsed.locator.split("/");
		return [
			el("span", { class: "src-scheme" }, prefix),
			el("span", { class: "src-owner" }, `${owner}/`),
			el("span", { class: "src-name" }, rest.join("/")),
		];
	}

	function renderEntry(e: Entry, index: number): HTMLElement {
		const claimed = inFlight(e);
		const card = el("article", {
			class: `work-card${e.status === "have" ? " is-have" : ""}${claimed ? " is-claimed" : ""}`,
		});
		if (firstPaint && !reducedMotion()) card.style.animationDelay = `${Math.min(index, 10) * 45}ms`;
		else card.classList.add("no-enter");

		const src = el("div", { class: "work-id" });
		const href = hfUrlFromCanonical(e.source);
		if (href) src.append(el("a", { href, rel: "noreferrer", target: "_blank", class: "src-link" }, ...sourceLabel(e.source)));
		else src.append(el("span", { class: "src-link" }, ...sourceLabel(e.source)));
		const sub: string[] = [];
		if (e.revision) sub.push(`pin ${e.revision.length > 12 ? e.revision.slice(0, 12) : e.revision}`);
		if (e.include?.length) sub.push(`include ${e.include.join(", ")}`);
		if (sub.length) src.append(el("div", { class: "work-sub" }, sub.join(" · ")));

		const kind = entryArtifactType(e);
		const facts = el("div", { class: "work-facts" });
		if (e.status === "have") {
			facts.append(teachChip(e.holders ? `have · ${e.holders}` : "have", "desire", "chip-have", e, "In a member's vault — who says whose"));
		}
		if (kind === "dataset") facts.append(teachChip("dataset", "dataset", "chip-type chip-type-dataset", e));
		else if (kind === "model") facts.append(teachChip("model", "bundle", "chip-type chip-type-model", e, "What lands on disk for a model"));
		else facts.append(el("span", { class: "muted" }, "—"));

		const size = el("span", { class: "work-size" }, humanSize(e.payload_bytes));
		if (typeof e.payload_bytes === "number") size.title = `${e.payload_bytes.toLocaleString()} bytes`;
		facts.append(size);
		if (e.parameters) {
			const stat = `${humanParams(e.parameters)}${e.dominant_dtype ? ` · ${e.dominant_dtype}` : ""}`;
			facts.append(teachChip(stat, "dtype", "chip-stat", e, "Parameters and dominant dtype — what one copy should weigh"));
		}
		if (e.policy === "masters") {
			facts.append(teachChip("masters", "masters", "chip-policy", e, "Priced masters-first: negatives, not prints"));
		}
		for (const hint of effectiveHints(e)) {
			const key = HINT_PRIMER[hint];
			if (key) facts.append(teachChip(hint, key, "chip-hint", e));
		}
		if (isAbliterated(e.source)) facts.append(teachChip("abliterated", "abliterated", "chip-name", e));
		if (isSpeculator(e.source)) facts.append(teachChip("speculator", "spec", "chip-name", e));
		if (isBaseModel(e.source)) facts.append(teachChip("base", "base", "chip-name", e));
		const moe = moeFromName(e.source);
		if (moe) {
			const label = moe.total !== null && moe.active !== null ? `MoE · ${moe.active}B active` : "MoE";
			facts.append(teachChip(label, "moe", "chip-name", e));
		}

		const open = openRecipes.has(e.id);
		const region = el("section", {
			class: "grimoire",
			id: `grim-${e.id}`,
			"aria-label": `Recipes for ${e.source}`,
		});
		const wrap = el("div", { class: open ? "grim-wrap is-open" : "grim-wrap" }, el("div", { class: "grim-clip" }, region));
		if (!open) wrap.setAttribute("inert", "");
		let built = false;
		const ensureBuilt = () => {
			if (built) return;
			built = true;
			region.append(...buildGrimoire(e));
		};
		if (open) ensureBuilt();
		const toggle = el(
			"button",
			{
				type: "button",
				class: "grim-toggle",
				"aria-expanded": open ? "true" : "false",
				"aria-controls": region.id,
			},
			el("span", { class: "grim-glyph", "aria-hidden": "true" }, "▸"),
			el("span", {}, "Recipes"),
		);
		toggle.addEventListener("click", () => {
			const now = !openRecipes.has(e.id);
			if (now) {
				openRecipes.add(e.id);
				ensureBuilt();
				wrap.removeAttribute("inert");
			} else {
				openRecipes.delete(e.id);
				wrap.setAttribute("inert", "");
			}
			toggle.setAttribute("aria-expanded", now ? "true" : "false");
			wrap.classList.toggle("is-open", now);
		});
		facts.append(toggle);

		const note = area(
			{
				class: "work-note",
				rows: "2",
				maxlength: "500",
				placeholder: "A sentence for why this one.",
				"aria-label": `Note for ${e.source}`,
				"data-entry": String(e.id),
				"data-field": "note",
			},
			e.note || "",
		);
		note.addEventListener("change", () => {
			void patchEntry(e.id, { note: note.value });
		});

		const desire = el("input", {
			type: "number",
			min: "1",
			max: "9",
			inputmode: "numeric",
			value: e.desire ? String(e.desire) : "",
			"aria-label": `Desire for ${e.source}, 1 to 9`,
			"data-entry": String(e.id),
			"data-field": "desire",
		});
		desire.addEventListener("change", () => {
			const v = desire.value === "" ? null : Number(desire.value);
			void patchEntry(e.id, { desire: v });
		});

		const have = el("input", { type: "checkbox", "data-entry": String(e.id), "data-field": "have" });
		if (e.status === "have") have.checked = true;
		have.addEventListener("change", () => {
			void patchEntry(e.id, { status: have.checked ? "have" : "want" });
		});

		const who = el("input", {
			type: "text",
			placeholder: "Maya, USB in Berlin",
			value: e.holders || "",
			maxlength: "500",
			"aria-label": `Who holds ${e.source}`,
			"data-entry": String(e.id),
			"data-field": "who",
		});
		who.addEventListener("change", () => {
			void patchEntry(e.id, { holders: who.value });
		});

		const rm = el("button", { type: "button", class: "btn compact secondary work-drop" }, "Drop");
		rm.addEventListener("click", async () => {
			const ok = await confirmDialog({
				title: "Drop this row?",
				body: `${e.source} leaves the list. Vaults that already hold it are untouched; the catalog simply stops asking for it.`,
				action: "Drop it",
				danger: true,
			});
			if (!ok) return;
			try {
				await api(`/api/boards/${id}/entries/${e.id}`, { method: "DELETE" });
				toast("Dropped");
				await reload();
			} catch (err) {
				toast(humanError(err instanceof Error ? err.message : "failed"), "error");
			}
		});

		const desireKicker = el("button", { type: "button", class: "kicker-btn", title: "What desire does" }, "Desire");
		desireKicker.addEventListener("click", () => openGuide("desire", desireKicker, e));
		const bar = el(
			"div",
			{ class: "work-bar" },
			el("label", { class: "work-desire" }, desireKicker, desire),
			el("label", { class: "work-have" }, have, el("span", {}, "Have")),
			el("label", { class: "work-who" }, el("span", {}, "Who"), who),
			rm,
		);

		const claimRow = renderClaim(e);
		card.append(
			el("div", { class: "work-top" }, src, facts),
			...(claimRow ? [claimRow] : []),
			el("label", { class: "work-note-wrap" }, el("span", { class: "work-note-kicker" }, "Note"), note),
			bar,
			wrap,
		);
		return card;
	}

	function paintIds() {
		if (!idsLive) return;
		idsLive.replaceChildren(
			el("span", { class: "board-id-k" }, "catalog "),
			el("code", { class: "board-id-v" }, board.catalog_id),
			el("span", { class: "board-id-sep", "aria-hidden": "true" }, " · "),
			el("span", {}, "created "),
			el("time", { datetime: board.created, title: board.created }, prettyDate(board.created)),
			el("span", { class: "board-id-sep", "aria-hidden": "true" }, " · "),
			el("span", {}, "updated "),
			el("time", { datetime: board.updated, title: board.updated }, relativeTime(board.updated)),
		);
	}

	function renderHeader(): HTMLElement {
		const header = el("header", { class: "board-head" });
		const title = el("input", {
			type: "text",
			class: "board-title",
			value: board.title || "",
			maxlength: "120",
			placeholder: "Name this list",
			"aria-label": "Board title",
		});
		title.addEventListener("change", () => patchBoard({ title: title.value }));

		const copy = el("button", { type: "button", class: "btn compact secondary" }, "Copy URL");
		copy.addEventListener("click", async () => {
			if (await copyText(location.href.split("#")[0])) flashCopied(copy);
			else toast("Select the address bar and copy it.", "error");
		});
		const del = el("button", { type: "button", class: "btn compact danger" }, "Delete board");
		del.addEventListener("click", async () => {
			const ok = await confirmDialog({
				title: "Destroy this board?",
				body: "Every row, note, and claim goes with it, and the URL stops working for everyone who has it. Vaults are untouched — the board never held the bytes.",
				action: "Delete the board",
				danger: true,
				typed: "delete",
			});
			if (!ok) return;
			try {
				await api(`/api/boards/${id}`, { method: "DELETE", body: JSON.stringify({ confirm: "delete" }) });
				location.href = "/";
			} catch (err) {
				toast(humanError(err instanceof Error ? err.message : "failed"), "error");
			}
		});
		const actions = el("div", { class: "board-actions" }, copy, del);

		const curator = el("input", {
			type: "text",
			value: board.curator || "",
			maxlength: "120",
			placeholder: "Who is curating",
			"aria-label": "Curator",
		});
		curator.addEventListener("change", () => patchBoard({ curator: curator.value }));

		const boardNote = area(
			{
				class: "board-note",
				rows: "2",
				maxlength: "2000",
				placeholder: "What is this list for? A short sentence is enough.",
				"aria-label": "Board note",
			},
			board.note || "",
		);
		boardNote.addEventListener("change", () => patchBoard({ note: boardNote.value }));

		idsLive = el("p", { class: "muted board-ids" });
		paintIds();

		header.append(
			el("div", { class: "board-title-row" }, title, actions),
			el("label", { class: "meta-field curator-field" }, el("span", {}, "Curator"), curator),
			el("label", { class: "board-note-wrap" }, el("span", { class: "work-note-kicker" }, "About this list"), boardNote),
			idsLive,
		);
		return header;
	}

	function clearLenses() {
		lenses = [];
		syncHash();
		paintLedger();
	}

	function paintToolbar(visible: Entry[]) {
		const all = board.entries;
		const counts = lensCountsGiven(all, lenses);
		const t = tally(visible);
		const total = all.length;

		const head = el("span", { class: "ledger-n" });
		if (lenses.length && visible.length !== total) {
			head.append(el("strong", {}, String(visible.length)), ` of ${plural(total, "source")}`);
		} else {
			head.append(el("strong", {}, String(total)), ` ${total === 1 ? "source" : "sources"}`);
		}
		const parts: string[] = [];
		if (t.wantBytes > 0) parts.push(`${humanSize(t.wantBytes)} wanted`);
		if (t.haveBytes > 0) parts.push(`${humanSize(t.haveBytes)} in vaults`);
		if (t.unsized > 0) parts.push(`${t.unsized} unpriced`);
		const tallyEl = el("span", { class: "ledger-tally", title: "Sizes as priced by the Hub; masters-first where the CLI classified" });
		parts.forEach((p, i) => {
			if (i > 0) tallyEl.append(el("span", { class: "ledger-sep", "aria-hidden": "true" }, "·"));
			tallyEl.append(p);
		});

		const sorts = el("div", { class: "sort-pills", role: "group", "aria-label": "Sort" });
		const sortCols: { label: string; key: SortKey }[] = [
			{ label: "Desire", key: "desire" },
			{ label: "Source", key: "source" },
			{ label: "Type", key: "type" },
			{ label: "Size", key: "size" },
			{ label: "Have", key: "status" },
		];
		for (const col of sortCols) {
			const active = sortKey === col.key;
			const btn = el(
				"button",
				{ type: "button", class: active ? "sort-btn is-active" : "sort-btn", "aria-pressed": active ? "true" : "false" },
				col.label,
			);
			if (active) btn.append(el("span", { class: "sort-mark", "aria-hidden": "true" }, sortDir === "desc" ? "▾" : "▴"));
			btn.setAttribute("aria-label", active ? `Sort by ${col.label}, ${sortDir === "desc" ? "descending" : "ascending"}` : `Sort by ${col.label}`);
			btn.addEventListener("click", () => {
				if (sortKey === col.key) sortDir = sortDir === "desc" ? "asc" : "desc";
				else {
					sortKey = col.key;
					sortDir = col.key === "source" ? "asc" : "desc";
				}
				syncHash();
				paintLedger();
			});
			sorts.append(btn);
		}

		const chips = el("div", { class: "lens-chips", role: "group", "aria-label": "Lenses" });
		const all_ = el(
			"button",
			{ type: "button", class: "lens-chip lens-all", "aria-pressed": lenses.length === 0 ? "true" : "false" },
			"All",
		);
		all_.addEventListener("click", clearLenses);
		chips.append(el("span", { class: "lens-group" }, all_));
		let group: HTMLElement | null = null;
		let lastGroup = "";
		for (const lens of LENSES) {
			const n = counts.get(lens.key) ?? 0;
			const active = lenses.includes(lens.key);
			const alone = lensCounts(all).get(lens.key) ?? 0;
			if (alone === 0 && !active) continue;
			if (!group || lens.group !== lastGroup) {
				group = el("span", { class: "lens-group" });
				chips.append(group);
				lastGroup = lens.group;
			}
			const b = el(
				"button",
				{
					type: "button",
					class: `lens-chip lens-${lens.group}${active ? " is-active" : ""}${n === 0 && !active ? " is-empty" : ""}`,
					"aria-pressed": active ? "true" : "false",
					"data-lens": lens.key,
					title: n === 0 && !active ? "Nothing would be left with the lenses already on" : lens.blurb.replace(/`/g, ""),
				},
				lens.label,
				el("span", { class: "lens-n" }, String(n)),
			);
			b.addEventListener("click", () => {
				lenses = active ? lenses.filter((k) => k !== lens.key) : [...lenses, lens.key];
				syncHash();
				paintLedger();
				// The toolbar was rebuilt; keep the keyboard on the chip that was pressed.
				shells.toolbar.querySelector<HTMLElement>(`.lens-chip[data-lens="${lens.key}"]`)?.focus({ preventScroll: true });
			});
			group.append(b);
		}
		const guideBtn = el(
			"button",
			{
				type: "button",
				class: "guide-open",
				title: hasKeyboard() ? "Open the field guide — or press ? anywhere on the board" : "Open the field guide",
			},
			el("span", { "aria-hidden": "true" }, "✦ "),
			el("span", { class: "guide-open-long" }, "Field "),
			"guide",
		);
		guideBtn.addEventListener("click", () => openGuide(lenses.length ? LENS_BY_KEY[lenses[lenses.length - 1]].primer : "masters", guideBtn));

		shells.toolbar.replaceChildren(
			el("div", { class: "ledger-row ledger-row-top" }, head, tallyEl, sorts, guideBtn),
			el("div", { class: "ledger-row lens-row" }, el("span", { class: "lens-kicker" }, "Lens"), chips),
		);

		// The caption: the active lenses explain themselves; before any lens,
		// a one-time hint that the chips are doorways.
		if (!lenses.length && !hintSeen()) {
			const hint = el("p", { class: "lens-caption lens-hint" });
			hint.append(
				el("span", { "aria-hidden": "true" }, "✦ "),
				"New here? Every chip on a row — the type, the size stat, hints like ",
				el("code", {}, "large"),
				" — opens a card of the field guide, applied to that row. ",
			);
			if (hasKeyboard()) hint.append(el("span", { class: "kbd-only" }, "Press ", el("kbd", {}, "?"), " any time. "));
			const ok = el("button", { type: "button", class: "linkish lens-clear" }, "Got it");
			ok.addEventListener("click", () => {
				markHintSeen();
				shells.caption.replaceChildren();
			});
			hint.append(ok);
			shells.caption.replaceChildren(hint);
		} else if (lenses.length) {
			const last = LENS_BY_KEY[lenses[lenses.length - 1]];
			const cap = el("p", { class: "lens-caption" });
			const names = lenses.map((k) => LENS_BY_KEY[k].label).join(" · ");
			cap.append(el("strong", {}, names), " — ");
			if (lenses.length > 1) cap.append(`rows that are ${lenses.length === 2 ? "both" : "all of these"}. `);
			cap.append(inline(last.blurb), " ");
			const read = el("button", { type: "button", class: "linkish" }, "✦ Read the card");
			read.addEventListener("click", () => openGuide(last.primer, read));
			cap.append(read);
			const clear = el("button", { type: "button", class: "linkish lens-clear" }, lenses.length > 1 ? "Clear all" : "Clear");
			clear.addEventListener("click", clearLenses);
			cap.append(el("span", { class: "guide-sep", "aria-hidden": "true" }, " · "), clear);
			shells.caption.replaceChildren(cap);
		} else {
			shells.caption.replaceChildren();
		}
	}

	function paintLedger() {
		const sorted = [...board.entries].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
		const visible = applyLenses(sorted, lenses);
		paintToolbar(visible);
		shells.ledger.replaceChildren();
		if (board.entries.length === 0) {
			const empty = el("div", { class: "ledger-empty" });
			empty.append(
				el("p", { class: "ledger-empty-t" }, "An empty ledger."),
				el("p", {}, "Add a source below — a Hugging Face URL or ", el("code", {}, "owner/name"), " — and it is priced from the Hub as it lands."),
			);
			shells.ledger.append(empty);
		} else if (visible.length === 0) {
			const empty = el("div", { class: "ledger-empty" });
			const n = lenses.length;
			const clear = el(
				"button",
				{ type: "button", class: "btn compact secondary" },
				n === 1 ? "Clear the lens" : n === 2 ? "Clear both lenses" : `Clear all ${n} lenses`,
			);
			clear.addEventListener("click", clearLenses);
			empty.append(el("p", { class: "ledger-empty-t" }, n === 1 ? "Nothing through this lens." : "Nothing through these lenses together."), clear);
			shells.ledger.append(empty);
		} else {
			visible.forEach((e, i) => shells.ledger.append(renderEntry(e, i)));
		}
		firstPaint = false;
	}

	function renderAdd(): HTMLElement {
		const add = el("form", { class: "add-card", "aria-labelledby": "add-title" });
		const source = el("input", {
			type: "text",
			placeholder: "owner/name, datasets/owner/name, or a Hugging Face URL",
			required: "true",
			id: "add-source",
			autocomplete: "off",
			spellcheck: "false",
		});
		const d = el("input", { type: "number", min: "1", max: "9", inputmode: "numeric", placeholder: "1–9", id: "add-desire" });
		const rev = el("input", { type: "text", placeholder: "main, a tag, a commit", maxlength: "64", id: "add-rev", spellcheck: "false" });
		const advanced = el("details", { class: "add-advanced" });
		const inc = el("input", {
			type: "text",
			placeholder: "*Q4_K_M*, tokenizer*",
			"aria-label": "Include globs, comma-separated",
			spellcheck: "false",
		});
		const incWhy = el("button", { type: "button", class: "linkish" }, "✦ What a subset is");
		incWhy.addEventListener("click", () => openGuide("subset", incWhy));
		advanced.append(
			el("summary", {}, "Only part of the repo? Add include globs"),
			el("div", { class: "add-advanced-row" }, inc, incWhy),
		);
		const addBtn = el("button", { type: "submit", class: "btn" }, "Add source");
		const addErr = el("p", { class: "add-err", role: "alert" });
		const help = el("p", { class: "add-help muted" });
		help.append("Priced from the Hub as it lands — size, parameters, dtype. Rate it 1–9; ");
		const fg = el("button", { type: "button", class: "linkish" }, "✦ what desire does");
		fg.addEventListener("click", () => openGuide("desire", fg));
		help.append(fg, ".");

		add.append(
			el("h2", { class: "add-title", id: "add-title" }, "Add a source"),
			el(
				"div",
				{ class: "add-fields" },
				el("label", { class: "add-field add-field-source" }, el("span", {}, "Source"), source),
				el("label", { class: "add-field add-field-desire" }, el("span", {}, "Desire"), d),
				el("label", { class: "add-field add-field-rev" }, el("span", {}, "Revision"), rev),
			),
			advanced,
			el("div", { class: "add-actions" }, addBtn, addErr),
			help,
		);
		add.addEventListener("submit", async (ev) => {
			ev.preventDefault();
			addErr.textContent = "";
			const include = inc.value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			addBtn.disabled = true;
			addBtn.textContent = "Pricing…";
			try {
				await api(`/api/boards/${id}/entries`, {
					method: "POST",
					body: JSON.stringify({
						source: source.value,
						desire: d.value === "" ? null : Number(d.value),
						revision: rev.value.trim() || null,
						include: include.length ? include : null,
					}),
				});
				source.value = "";
				rev.value = "";
				inc.value = "";
				d.value = "";
				toast("Added and priced");
				await reload();
			} catch (err) {
				addErr.textContent = humanError(err instanceof Error ? err.message : "failed");
			} finally {
				addBtn.disabled = false;
				addBtn.textContent = "Add source";
			}
		});
		return add;
	}

	function watchSticky() {
		stickyWatch?.disconnect();
		const sentinel = el("div", { class: "sticky-sentinel", "aria-hidden": "true" });
		shells.toolbar.before(sentinel);
		if (!("IntersectionObserver" in window)) return;
		stickyWatch = new IntersectionObserver(
			([entry]) => shells.toolbar.classList.toggle("is-stuck", !entry.isIntersecting),
			{ threshold: [1] },
		);
		stickyWatch.observe(sentinel);
	}

	function render() {
		root.replaceChildren(renderHeader(), renderBringHome(), shells.toolbar, shells.caption, shells.ledger, renderAdd());
		watchSticky();
		paintLedger();
		paintArchive();
		syncHash();
	}

	render();
}
