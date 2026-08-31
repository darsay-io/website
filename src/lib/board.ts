import { artifactTypeFromSource, hfUrlFromCanonical } from "../worker/sources.ts";
import { deriveRecipes, humanSize, type Recipe } from "./recipes.ts";
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

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") n.className = v;
		else n.setAttribute(k, v);
	}
	for (const kid of kids) n.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
	return n;
}


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

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

function flashCopied(btn: HTMLButtonElement) {
	const prev = btn.textContent;
	btn.textContent = "Copied";
	btn.classList.add("is-copied");
	window.setTimeout(() => {
		btn.textContent = prev;
		btn.classList.remove("is-copied");
	}, 1600);
}

function selectContents(node: Node) {
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	range.selectNodeContents(node);
	sel.removeAllRanges();
	sel.addRange(range);
}

function isMac(): boolean {
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Copy; where the clipboard is unavailable, select the text and name the key instead. */
async function copyOrSelect(btn: HTMLButtonElement, text: string, node: Node) {
	if (await copyText(text)) {
		flashCopied(btn);
		return;
	}
	selectContents(node);
	const prev = btn.textContent;
	btn.textContent = isMac() ? "Selected · ⌘C" : "Selected · Ctrl+C";
	btn.classList.add("is-copied");
	window.setTimeout(() => {
		btn.textContent = prev;
		btn.classList.remove("is-copied");
	}, 2400);
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];

function termDots(): HTMLElement {
	return el("span", { class: "cmd-dots", "aria-hidden": "true" }, el("span"), el("span"), el("span"));
}

/** Shell lines as text nodes; a trailing `# comment` gets a dimmer span. Never HTML. */
function codeLines(lines: string[]): HTMLElement {
	const code = el("code", { class: "cmd-text" });
	lines.forEach((line, i) => {
		if (i > 0) code.append("\n");
		const m = /^(\s*)(#.*)$/.exec(line) ?? /^(.*?\S)(\s+#.*)$/.exec(line);
		if (m) {
			if (m[1]) code.append(m[1]);
			code.append(el("span", { class: "cmd-comment" }, m[2]));
		} else if (line) {
			code.append(line);
		}
	});
	return code;
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
				try {
					await navigator.clipboard.writeText(body.url);
				} catch {
					/* user can select the URL */
				}
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

type SortKey = "source" | "type" | "desire" | "size" | "status";

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

type GaugeRef = {
	kind: GaugeKind;
	face: HTMLElement;
	value: HTMLElement;
	unit: HTMLElement;
	input: HTMLInputElement;
};

export async function mountBoard(root: HTMLElement, id: string) {
	root.replaceChildren(el("p", {}, "Loading…"));
	let board: Board;
	try {
		board = (await api(`/api/boards/${id}`)) as Board;
	} catch {
		root.replaceChildren(el("p", {}, "Board not found. Check the URL."));
		return;
	}

	let sortKey: SortKey = "desire";
	let sortDir: "asc" | "desc" = "desc";
	let message = "";
	let dials: DialIndices = { ...DEFAULT_DIAL_INDICES };
	let installFlavor: InstallFlavor = "pipx";
	let howOpen = true;
	let archiveLive: { cmd: HTMLElement; caption: HTMLElement; gauges: GaugeRef[] } | null = null;
	let installLive: HTMLElement | null = null;
	const openRecipes = new Set<number>();

	async function patchBoard(body: Record<string, unknown>) {
		try {
			await api(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify(body) });
			message = "";
			await reload();
		} catch (e) {
			message = e instanceof Error ? e.message : "failed";
			render();
		}
	}

	async function patchEntry(eid: number, body: Record<string, unknown>, reloadAfter = true) {
		try {
			await api(`/api/boards/${id}/entries/${eid}`, { method: "PATCH", body: JSON.stringify(body) });
			message = "";
			if (reloadAfter) await reload();
		} catch (e) {
			message = e instanceof Error ? e.message : "failed";
			render();
		}
	}

	async function reload() {
		board = (await api(`/api/boards/${id}`)) as Board;
		render();
	}

	async function downloadCatalog() {
		const res = await fetch(`/api/boards/${id}/catalog.json`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		if (!res.ok) return;
		const blob = await res.blob();
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${board.catalog_id}.json`;
		a.rel = "noreferrer";
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function currentCommand(): string {
		return archiveCommand(catalogArg(board.catalog_id), dialsFromIndices(dials));
	}

	function paintArchive() {
		if (!archiveLive) return;
		const d = dialsFromIndices(dials);
		archiveLive.cmd.textContent = archiveCommand(catalogArg(board.catalog_id), d);
		archiveLive.caption.textContent = archiveCaption(d);
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
		const root = el(
			"label",
			{ class: "gauge" },
			el("span", { class: "gauge-kicker" }, meta.label),
			face,
			input,
		);
		return { root, ref: { kind, face, value, unit, input } };
	}

	function renderBringHome(): HTMLElement {
		const section = el("section", { class: "bring-home", "aria-labelledby": "bring-title" });
		section.append(
			el("p", { class: "bring-kicker" }, "From this list → your vault"),
			el("h2", { id: "bring-title" }, "Bring it home"),
			el(
				"p",
				{ class: "bring-lede" },
				"This site never holds weights. Save the catalog, then let darsay archive the next unfinished source onto your machine.",
			),
		);

		const cmd = el("code", { class: "cmd-text", "aria-live": "polite" }, currentCommand());
		const copy = el("button", { type: "button", class: "btn compact cmd-copy" }, "Copy");
		copy.addEventListener("click", () => void copyOrSelect(copy, currentCommand(), cmd));
		const chrome = el(
			"div",
			{ class: "cmd-chrome" },
			el(
				"span",
				{ class: "cmd-dots", "aria-hidden": "true" },
				el("span"),
				el("span"),
				el("span"),
			),
			el("span", { class: "cmd-label" }, "tonight’s fetch"),
			copy,
		);
		const stage = el("div", { class: "cmd-stage" }, chrome, el("pre", {}, cmd));

		const dl = el("button", { type: "button", class: "btn bring-download" });
		dl.append(
			el("span", { class: "bring-dl-kicker" }, "Download catalog"),
			el("span", { class: "bring-dl-file" }, `${board.catalog_id}.json`),
		);
		dl.addEventListener("click", () => downloadCatalog());

		const cmdRow = el("div", { class: "cmd-row" }, stage, dl);
		const caption = el("p", { class: "cmd-caption" }, archiveCaption(dialsFromIndices(dials)));

		const gauges: GaugeRef[] = [];
		const gaugeRow = el("div", { class: "gauges" });
		for (const kind of ["maxGb", "minFree", "maxRate", "maxMinutes"] as GaugeKind[]) {
			const g = makeGauge(kind);
			gauges.push(g.ref);
			gaugeRow.append(g.root);
		}

		archiveLive = { cmd, caption, gauges };

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
			if (flavor === installFlavor) b.setAttribute("aria-pressed", "true");
			else b.setAttribute("aria-pressed", "false");
			b.addEventListener("click", () => {
				installFlavor = flavor;
				for (const child of flavors.querySelectorAll("button")) {
					child.setAttribute("aria-pressed", child === b ? "true" : "false");
				}
				installCode.textContent = INSTALL_COMMANDS[flavor];
			});
			flavors.append(b);
		}

		const steps = el("ol", { class: "bring-steps" });
		const step1 = el(
			"li",
			{},
			el("span", { class: "step-n" }, "1"),
			el(
				"div",
				{},
				el("strong", {}, "Install darsay"),
				flavors,
				el("pre", { class: "install-cmd" }, installCode),
			),
		);
		const step2 = el(
			"li",
			{},
			el("span", { class: "step-n" }, "2"),
			el(
				"div",
				{},
				el("strong", {}, "Save the catalog"),
				el(
					"p",
					{},
					"A catalog.json the CLI already understands. Download it — do not paste the board URL into a terminal.",
				),
			),
		);
		const step3 = el(
			"li",
			{},
			el("span", { class: "step-n" }, "3"),
			el(
				"div",
				{},
				el("strong", {}, "Run it where you saved the file"),
				el(
					"p",
					{},
					"In that folder, paste the command above. The dials rewrite the flags. Rerun the same line to resume.",
				),
			),
		);
		steps.append(step1, step2, step3);

		const more = el(
			"p",
			{ class: "bring-more muted" },
			"The catalog is the want-list, not the weights. Upstream is Hugging Face. ",
		);
		const docs = el("a", { href: "/docs/getting-started/" }, "Full walkthrough");
		more.append(docs, " · ");
		more.append(el("a", { href: "/docs/examples/#share-a-catalog" }, "Share a catalog"));

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
			const stage = el(
				"div",
				{ class: "cmd-stage" },
				el("div", { class: "cmd-chrome" }, termDots(), el("span", { class: "cmd-label" }, r.label), copy),
				el("pre", {}, code),
			);
			const foot = el("p", { class: "spell-foot" });
			if (r.doc) {
				foot.append(
					el("a", { class: "spell-doc", href: r.doc.href, target: "_blank", rel: "noreferrer" }, r.doc.label),
				);
			}
			if (r.download) {
				const dl = el(
					"button",
					{ type: "button", class: "btn compact secondary spell-dl" },
					`Download ${board.catalog_id}.json`,
				);
				dl.addEventListener("click", () => downloadCatalog());
				foot.append(dl);
			}
			const li = el(
				"li",
				{ class: "spell" },
				el("span", { class: "spell-n", "aria-hidden": "true" }, ROMAN[offset + i] ?? String(offset + i + 1)),
				el("h4", {}, r.title),
				el("p", { class: "spell-why" }, r.why),
				stage,
			);
			if (foot.childNodes.length) li.append(foot);
			ol.append(li);
		});
		return ol;
	}

	/** The recipe card for one entry. Static: derived from the row's fields, no fetch. */
	function buildGrimoire(e: Entry): Node[] {
		const set = deriveRecipes(e, board.catalog_id);
		const facts = el("ul", { class: "grim-facts" });
		for (const f of set.facts) facts.append(el("li", {}, f));
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
		const label = el(
			"div",
			{ class: "claim-label" },
			el("span", { class: "claim-client" }, claim.client),
			el("span", {}, ` ${verb}${clamped === null ? "" : ` ${clamped}%`}${bytes}`),
		);
		return el("div", { class: "claim-gauge" }, track, label);
	}

	function renderEntry(e: Entry): HTMLElement {
		const card = el("article", { class: "work-card" });
		const src = el("div", { class: "work-id" });
		const href = hfUrlFromCanonical(e.source);
		if (href) {
			src.append(el("a", { href, rel: "noreferrer", target: "_blank" }, e.source));
		} else {
			src.append(el("span", {}, e.source));
		}
		if (e.revision) src.append(el("div", { class: "muted" }, e.revision));
		if (e.include?.length) src.append(el("div", { class: "muted" }, e.include.join(", ")));

		const kind = entryArtifactType(e);
		const facts = el("div", { class: "work-facts" });
		if (kind === "model" || kind === "dataset") {
			facts.append(el("span", { class: `type-tag type-tag-${kind}` }, kind));
		} else {
			facts.append(el("span", { class: "muted" }, "—"));
		}
		facts.append(el("span", { class: "work-size" }, humanSize(e.payload_bytes)));
		if (e.policy) {
			facts.append(el("span", { class: "policy-chip", title: "Priced as the masters-first acquisition" }, e.policy));
		}
		for (const hint of e.hints ?? []) {
			facts.append(el("span", { class: "hint-chip" }, hint));
		}

		const open = openRecipes.has(e.id);
		const region = el("section", {
			class: "grimoire",
			id: `grim-${e.id}`,
			"aria-label": `Recipes for ${e.source}`,
		});
		const wrap = el(
			"div",
			{ class: open ? "grim-wrap is-open" : "grim-wrap" },
			el("div", { class: "grim-clip" }, region),
		);
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
			el("span", { class: "grim-glyph", "aria-hidden": "true" }, "✦"),
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
			},
			e.note || "",
		);
		note.addEventListener("change", () => {
			void patchEntry(e.id, { note: note.value }, false);
		});

		const desire = el("input", {
			type: "number",
			min: "1",
			max: "9",
			value: e.desire ? String(e.desire) : "",
			"aria-label": `Desire for ${e.source}`,
		});
		desire.addEventListener("change", async () => {
			const v = desire.value === "" ? null : Number(desire.value);
			await patchEntry(e.id, { desire: v });
		});

		const have = el("input", { type: "checkbox" });
		if (e.status === "have") have.checked = true;
		have.addEventListener("change", async () => {
			await patchEntry(e.id, { status: have.checked ? "have" : "want" });
		});

		const who = el("input", {
			type: "text",
			placeholder: "Maya, USB in Berlin",
			value: e.holders || "",
			maxlength: "500",
			"aria-label": `Who holds ${e.source}`,
		});
		who.addEventListener("change", async () => {
			await patchEntry(e.id, { holders: who.value }, false);
		});

		const rm = el("button", { type: "button", class: "btn compact secondary" }, "Drop");
		rm.addEventListener("click", async () => {
			if (!confirm("Drop this row?")) return;
			await api(`/api/boards/${id}/entries/${e.id}`, { method: "DELETE" });
			await reload();
		});

		const bar = el(
			"div",
			{ class: "work-bar" },
			el("label", { class: "work-desire" }, el("span", {}, "Desire"), desire),
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

	function render() {
		const header = el("header", { class: "board-head" });
		const title = el("input", {
			type: "text",
			class: "board-title",
			value: board.title || "",
			maxlength: "120",
			"aria-label": "Board title",
		});
		title.addEventListener("change", () => patchBoard({ title: title.value }));

		const copy = el("button", { type: "button", class: "btn compact secondary" }, "Copy URL");
		copy.addEventListener("click", async () => {
			if (await copyText(location.href)) flashCopied(copy);
		});
		const del = el("button", { type: "button", class: "btn compact danger" }, "Delete board");
		del.addEventListener("click", async () => {
			const typed = prompt('Type "delete" to destroy this board');
			if (typed !== "delete") return;
			await api(`/api/boards/${id}`, { method: "DELETE", body: JSON.stringify({ confirm: "delete" }) });
			location.href = "/";
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

		header.append(
			el("div", { class: "board-title-row" }, title, actions),
			el("label", { class: "meta-field curator-field" }, el("span", {}, "Curator"), curator),
			el("label", { class: "board-note-wrap" }, el("span", { class: "work-note-kicker" }, "About this list"), boardNote),
			el(
				"p",
				{ class: "muted board-ids" },
				`catalog id ${board.catalog_id} · created ${board.created} · updated ${board.updated}`,
			),
		);
		if (message) header.append(el("p", { class: "flash" }, message));

		const toolbar = el("div", { class: "ledger-toolbar" });
		const n = board.entries.length;
		toolbar.append(el("span", { class: "ledger-count" }, n === 1 ? "1 source" : `${n} sources`));
		const sorts = el("div", { class: "sort-pills" });
		const sortCols: { label: string; key: SortKey }[] = [
			{ label: "Desire", key: "desire" },
			{ label: "Source", key: "source" },
			{ label: "Type", key: "type" },
			{ label: "Size", key: "size" },
			{ label: "Have", key: "status" },
		];
		for (const col of sortCols) {
			const mark = sortKey === col.key ? (sortDir === "desc" ? " ▾" : " ▴") : "";
			const btn = el(
				"button",
				{
					type: "button",
					class: sortKey === col.key ? "sort-btn is-active" : "sort-btn",
				},
				col.label + mark,
			);
			btn.addEventListener("click", () => {
				if (sortKey === col.key) sortDir = sortDir === "desc" ? "asc" : "desc";
				else {
					sortKey = col.key;
					sortDir = col.key === "source" ? "asc" : "desc";
				}
				render();
			});
			sorts.append(btn);
		}
		toolbar.append(sorts);

		const ledger = el("div", { class: "ledger" });
		const rows = [...board.entries].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
		if (rows.length === 0) {
			ledger.append(el("p", { class: "muted" }, "Add a source to start the list."));
		} else {
			for (const e of rows) ledger.append(renderEntry(e));
		}

		const add = el("form", { class: "add-row add-card" });
		const source = el("input", {
			type: "text",
			placeholder: "huggingface:Qwen/Qwen3-0.6B or datasets/owner/name",
			required: "true",
			"aria-label": "Source",
		});
		const d = el("input", { type: "number", min: "1", max: "9", placeholder: "desire", "aria-label": "Desire" });
		const rev = el("input", {
			type: "text",
			placeholder: "revision (optional)",
			maxlength: "64",
			"aria-label": "Revision",
		});
		const advanced = el("details");
		const inc = el("input", {
			type: "text",
			placeholder: "include globs, comma-separated",
			"aria-label": "Include globs",
		});
		advanced.append(el("summary", {}, "subset / include"), inc);
		const addBtn = el("button", { type: "submit", class: "btn" }, "Add source");
		const addErr = el("p", { class: "muted" });
		add.append(source, d, rev, advanced, addBtn, addErr);
		add.addEventListener("submit", async (ev) => {
			ev.preventDefault();
			addErr.textContent = "";
			const include = inc.value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
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
				await reload();
			} catch (err) {
				addErr.textContent = err instanceof Error ? err.message : "failed";
			}
		});

		root.replaceChildren(header, renderBringHome(), toolbar, ledger, add);
		paintArchive();
	}

	render();
}
